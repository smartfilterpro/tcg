// A minimal SMTP client over node:tls — deliberately no nodemailer. The
// repo's rule is no new dependencies without asking, and the slice of SMTP
// a newsletter needs (connect, authenticate, one text message per
// recipient) is a short, well-specified conversation. Same reasoning as
// Stripe-over-fetch in lib/stripe.ts.
//
// Configuration comes from the environment — the same credentials the
// owner already made for Supabase's auth emails work here:
//   SMTP_HOST, SMTP_PORT (465 = implicit TLS, anything else = STARTTLS),
//   SMTP_USER, SMTP_PASS, SMTP_FROM ("TCGdeck <news@tcgdeck.io>").

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createConnection, type Socket } from "node:net";

export function emailEnabled(): boolean {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM
  );
}

const TIMEOUT_MS = 15_000;

/** One SMTP conversation. Waits for a full reply (last line "250 " not
 *  "250-"), checks the expected status class, and gives up loudly —
 *  a newsletter must never half-send in silence. */
class SmtpSession {
  private buf = "";
  private waiter: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;

  constructor(private socket: Socket | TLSSocket) {
    socket.setTimeout(TIMEOUT_MS, () => this.fail(new Error("SMTP timeout")));
    socket.on("data", (d) => this.onData(String(d)));
    socket.on("error", (e) => this.fail(e as Error));
    socket.on("close", () => this.fail(new Error("SMTP connection closed")));
  }

  private fail(e: Error) {
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    // A reply is complete when a line's 4th char is a space ("250 ok");
    // "250-line" means more lines follow.
    const lines = this.buf.split(/\r?\n/);
    for (const line of lines) {
      if (/^\d{3} /.test(line)) {
        const whole = this.buf;
        this.buf = "";
        const w = this.waiter;
        this.waiter = null;
        w?.resolve(whole);
        return;
      }
    }
  }

  reply(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async cmd(line: string, expect: RegExp): Promise<string> {
    const pending = this.reply();
    this.socket.write(line + "\r\n");
    const res = await pending;
    if (!expect.test(res)) {
      throw new Error(`SMTP refused "${line.slice(0, 24)}…": ${res.split("\n")[0]}`);
    }
    return res;
  }

  swap(socket: TLSSocket) {
    this.socket.removeAllListeners?.();
    this.socket = socket;
    socket.setTimeout(TIMEOUT_MS, () => this.fail(new Error("SMTP timeout")));
    socket.on("data", (d) => this.onData(String(d)));
    socket.on("error", (e) => this.fail(e as Error));
  }

  end() {
    try {
      this.socket.end();
    } catch {
      // closing is best-effort
    }
  }
}

function fromAddress(): string {
  const from = process.env.SMTP_FROM ?? "";
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

/** RFC 2047 header encoding for anything beyond ASCII in the subject. */
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

/** Send one message. Throws with the server's own words on refusal. */
export async function sendEmail(mail: Mail): Promise<void> {
  if (!emailEnabled()) throw new Error("Email is not configured (SMTP_* env vars).");
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT ?? 465);
  const implicitTls = port === 465;

  const socket: Socket | TLSSocket = implicitTls
    ? tlsConnect({ host, port, servername: host })
    : createConnection({ host, port });
  const s = new SmtpSession(socket);
  try {
    let greeting = s.reply();
    await new Promise<void>((resolve, reject) => {
      socket.once(implicitTls ? "secureConnect" : "connect", () => resolve());
      socket.once("error", reject);
    });
    if (!/^220/.test(await greeting)) throw new Error("SMTP server did not greet");

    await s.cmd(`EHLO tcgdeck`, /^250/m);
    if (!implicitTls) {
      await s.cmd("STARTTLS", /^220/);
      const upgraded = tlsConnect({ socket: socket as Socket, servername: host });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      s.swap(upgraded);
      await s.cmd(`EHLO tcgdeck`, /^250/m);
    }

    const user = process.env.SMTP_USER!;
    const pass = process.env.SMTP_PASS!;
    await s.cmd(
      `AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64")}`,
      /^235/
    );

    await s.cmd(`MAIL FROM:<${fromAddress()}>`, /^250/);
    await s.cmd(`RCPT TO:<${mail.to}>`, /^25[01]/);
    await s.cmd("DATA", /^354/);

    const headers = [
      `From: ${process.env.SMTP_FROM}`,
      `To: <${mail.to}>`,
      `Subject: ${encodeHeader(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ];
    // Dot-stuffing: a body line starting "." would end DATA early.
    const body = mail.text.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    await s.cmd(`${headers.join("\r\n")}\r\n\r\n${body}\r\n.`, /^250/);
    await s.cmd("QUIT", /^221/).catch(() => {});
  } finally {
    s.end();
  }
}
