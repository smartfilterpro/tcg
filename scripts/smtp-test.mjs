#!/usr/bin/env node

// Talk to an SMTP server by hand and show every word of it.
//
// Supabase's auth logs tell you a send failed but never why: a timeout, a
// refused password and a quarantined message all surface as the same
// unhelpful line. This walks the same conversation Supabase would have —
// banner, EHLO, STARTTLS, AUTH, MAIL, RCPT, DATA — printing each turn with
// the milliseconds it took, so the failure names itself.
//
// The timings are the point as much as the transcript. Supabase gives the
// whole exchange about ten seconds before it gives up, and a host can
// authenticate perfectly while still being too slow to use. A transcript
// that ends in "sent" after twenty seconds is a failure, and only the clock
// says so.
//
// No dependencies, and the password is never printed.
//
//   node scripts/smtp-test.mjs \
//     --host smtp.office365.com --port 587 \
//     --user noreply@trainerdeck.io --pass 'app-password' \
//     --from noreply@trainerdeck.io --to you@gmail.com
//
// Credentials may come from the environment instead — SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO — which keeps the password out of
// your shell history. Pass --no-send to stop after authenticating, when you
// want to check credentials without putting mail in someone's inbox.

import net from "node:net";
import tls from "node:tls";
import process from "node:process";

// Supabase's mailer deadline. Not configurable on hosted projects, so it's
// the bar every host has to clear, not a preference.
const BUDGET_MS = 10_000;

// Long enough that a slow-but-working host still finishes and gets reported
// as slow, rather than being cut off and reported as broken.
const READ_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "no-send" || key === "help") {
      out[key] = true;
      continue;
    }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      "Usage: node scripts/smtp-test.mjs [options]",
      "",
      "  --host   SMTP host          (env SMTP_HOST)",
      "  --port   port, default 587  (env SMTP_PORT)",
      "  --user   username           (env SMTP_USER)",
      "  --pass   password           (env SMTP_PASS)",
      "  --from   sender address     (env SMTP_FROM, defaults to --user)",
      "  --to     recipient address  (env SMTP_TO)",
      "  --no-send                   stop after AUTH, send nothing",
      "",
      "Port 465 is treated as implicit TLS; anything else uses STARTTLS.",
    ].join("\n"),
  );
  process.exit(0);
}

const host = args.host ?? process.env.SMTP_HOST;
const port = Number(args.port ?? process.env.SMTP_PORT ?? 587);
const user = args.user ?? process.env.SMTP_USER;
const pass = args.pass ?? process.env.SMTP_PASS;
const from = args.from ?? process.env.SMTP_FROM ?? user;
const to = args.to ?? process.env.SMTP_TO;
const send = !args["no-send"];

const missing = [
  ["--host", host],
  ["--user", user],
  ["--pass", pass],
  send ? ["--to", to] : null,
]
  .filter((pair) => pair && !pair[1])
  .map((pair) => pair[0]);

if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Try --help.`);
  process.exit(2);
}

const started = Date.now();
const marks = [];

function elapsed() {
  return Date.now() - started;
}

function stamp(text) {
  return String(elapsed()).padStart(6, " ") + "ms  " + text;
}

/** Record how long a named phase took, for the summary table. */
async function phase(name, run) {
  const at = Date.now();
  try {
    return await run();
  } finally {
    marks.push({ name, ms: Date.now() - at });
  }
}

/** Reads whole SMTP replies off a socket, continuation lines included. */
class Wire {
  constructor() {
    this.buffer = "";
    this.waiting = null;
    this.closed = null;
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.deliver();
    });
    // A server that hangs up mid-conversation is itself a diagnosis — say so
    // rather than sitting on a promise until the read timeout.
    socket.on("close", () => {
      this.closed = new Error("server closed the connection");
      this.deliver();
    });
    socket.on("error", (err) => {
      this.closed = err;
      this.deliver();
    });
  }

  deliver() {
    if (!this.waiting) return;
    // A reply is any number of "250-" continuation lines followed by one
    // "250 " line with a space. Anything less isn't complete yet.
    const match = this.buffer.match(/^(?:\d{3}-[^\n]*\n)*(\d{3})(?: [^\n]*)?\n/);
    if (!match) {
      if (this.closed) {
        const { reject, timer } = this.waiting;
        this.waiting = null;
        clearTimeout(timer);
        reject(this.closed);
      }
      return;
    }
    const raw = this.buffer.slice(0, match[0].length);
    this.buffer = this.buffer.slice(match[0].length);
    const { resolve, timer } = this.waiting;
    this.waiting = null;
    clearTimeout(timer);
    resolve({ code: Number(match[1]), text: raw.replace(/\r?\n$/, "") });
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error(`no reply within ${READ_TIMEOUT_MS / 1000}s`));
      }, READ_TIMEOUT_MS);
      this.waiting = { resolve, reject, timer };
      this.deliver();
    });
  }

  write(line, shown = line) {
    console.log(stamp("C: " + shown));
    this.socket.write(line + "\r\n");
  }

  /** Send a command and insist on a reply code we can live with. */
  async command(line, expect, shown) {
    this.write(line, shown);
    const reply = await this.read();
    for (const text of reply.text.split(/\r?\n/)) console.log(stamp("S: " + text));
    if (expect && !expect.includes(reply.code)) {
      throw Object.assign(new Error(reply.text.split(/\r?\n/).pop()), { smtp: reply.code });
    }
    return reply;
  }
}

const wire = new Wire();

function connect() {
  return new Promise((resolve, reject) => {
    // 465 is implicit TLS — the socket is encrypted before the banner. Every
    // other port starts in the clear and upgrades with STARTTLS. Microsoft
    // only offers the second, which is why a 465 setting looks like a hang
    // rather than a refusal.
    const socket =
      port === 465
        ? tls.connect({ host, port, servername: host }, () => resolve(socket))
        : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(READ_TIMEOUT_MS);
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`could not connect within ${READ_TIMEOUT_MS / 1000}s`));
    });
  });
}

function upgrade(socket) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.once("error", reject);
  });
}

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function message() {
  // A Date and Message-ID make this findable in a message trace, and a
  // plain-text body keeps content filters out of the picture — if this one
  // gets quarantined, nothing you send will get through.
  const id = `${elapsed()}.${process.pid}@smtp-test`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: TrainerDeck SMTP test`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "If this arrived, the credentials and the route both work.",
    "Check the timings in the terminal to see whether it was fast enough.",
    "",
  ].join("\r\n");
}

async function main() {
  console.log(`${send ? "Sending" : "Authenticating"} via ${host}:${port} as ${user}\n`);

  const socket = await phase("connect", connect);
  wire.attach(socket);

  await phase("banner", async () => {
    const reply = await wire.read();
    for (const text of reply.text.split(/\r?\n/)) console.log(stamp("S: " + text));
    if (reply.code !== 220) throw new Error(reply.text);
  });

  let greeting = await phase("ehlo", () => wire.command("EHLO trainerdeck.io", [250]));

  if (port !== 465) {
    if (!/STARTTLS/i.test(greeting.text)) {
      throw new Error("server does not offer STARTTLS — refusing to send a password in the clear");
    }
    await phase("starttls", async () => {
      await wire.command("STARTTLS", [220]);
      wire.attach(await upgrade(socket));
    });
    // The greeting has to be asked for again: what the server advertises
    // before TLS and after it are different lists, and AUTH usually only
    // appears in the second.
    greeting = await phase("ehlo (tls)", () => wire.command("EHLO trainerdeck.io", [250]));
  }

  if (!/AUTH[ =]/i.test(greeting.text)) {
    throw new Error("server does not advertise AUTH — SMTP authentication is disabled for this host or mailbox");
  }

  await phase("auth", async () => {
    await wire.command("AUTH LOGIN", [334]);
    await wire.command(b64(user), [334], "<username>");
    await wire.command(b64(pass), [235], "<password>");
  });

  if (send) {
    await phase("mail from", () => wire.command(`MAIL FROM:<${from}>`, [250]));
    await phase("rcpt to", () => wire.command(`RCPT TO:<${to}>`, [250, 251]));
    await phase("data", async () => {
      await wire.command("DATA", [354]);
      // Dot-stuffing: a line that is just "." would end the message early.
      const body = message().replace(/\r\n\./g, "\r\n..");
      console.log(stamp(`C: <${body.length} bytes of message>`));
      wire.socket.write(body + "\r\n.\r\n");
      const reply = await wire.read();
      for (const text of reply.text.split(/\r?\n/)) console.log(stamp("S: " + text));
      if (reply.code !== 250) throw new Error(reply.text);
    });
  }

  await wire.command("QUIT", [221]).catch(() => {});
  wire.socket.end();
  return true;
}

function summarise(ok) {
  const total = elapsed();
  console.log("\n  phase           time");
  console.log("  ─────────────────────");
  for (const mark of marks) {
    console.log(`  ${mark.name.padEnd(14)}  ${String(mark.ms).padStart(6)}ms`);
  }
  console.log(`  ${"total".padEnd(14)}  ${String(total).padStart(6)}ms\n`);

  if (!ok) return;

  if (total > BUDGET_MS) {
    console.log(
      `Authenticated and ${send ? "delivered" : "connected"}, but took ${(total / 1000).toFixed(1)}s.`,
    );
    console.log(
      `Supabase abandons a send at ${BUDGET_MS / 1000}s, so signups on this host will fail`,
    );
    console.log("intermittently no matter how the credentials are configured.");
  } else {
    console.log(`Well inside Supabase's ${BUDGET_MS / 1000}s budget.`);
  }
  if (send) console.log("Delivery is a separate question — check the inbox, and the junk folder.");
}

main()
  .then((ok) => {
    console.log(stamp(send ? "accepted for delivery" : "credentials accepted"));
    summarise(ok);
    process.exit(0);
  })
  .catch((err) => {
    console.log(stamp(`FAILED: ${err.message}`));
    summarise(false);
    // The reply code is the most useful thing on the screen, so spell out
    // what the common ones mean instead of leaving it to a search engine.
    const hint = {
      535: "credentials rejected, SMTP AUTH disabled for the mailbox, or blocked by a Conditional Access policy",
      530: "the server wanted authentication first — STARTTLS or AUTH did not complete",
      550: "sender or recipient refused; sending as an address the account does not own is the usual cause",
      554: "the message was rejected outright, often by a content or reputation filter",
    }[err.smtp];
    if (hint) console.log(`\n${err.smtp}: ${hint}`);
    process.exit(1);
  });
