// Keeping the last stretch of server log where an admin can reach it.
//
// The background jobs narrate themselves to the console — what the price
// sync matched, what the art mirror failed on, why a run stopped. On Railway
// that output lives in the platform's log viewer, which means diagnosing
// anything requires a desktop, the right project open, and the right
// deployment selected before the interesting lines scroll away.
//
// So the process keeps its own copy: a bounded ring of recent lines that an
// admin can read or download from the app itself. It is a diagnostic aid,
// not a logging system — Railway's own logs remain the complete record, and
// this is the slice you can get at from a phone.
//
// PER PROCESS. A restart empties it and a second instance has its own; both
// are visible in the header the route returns, so a gap is never mistaken
// for silence.

export type LogLevel = "log" | "warn" | "error";

export interface LogEntry {
  t: string;
  level: LogLevel;
  msg: string;
}

/** Enough to cover several hours of job output without holding memory that
 *  matters. Each entry is a short line; 1,000 of them is well under a
 *  megabyte. */
const MAX_ENTRIES = 1000;

const buffer: LogEntry[] = [];
const startedAt = new Date().toISOString();
let installed = false;

/** Render one console argument.
 *
 *  Errors first and deliberately: the default string form of an Error is
 *  "[object Object]" under JSON.stringify and loses the stack, which is the
 *  only part worth having. */
function render(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`.trim();
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg);
  } catch {
    // Circular, or a getter that throws. Never let logging be the thing
    // that breaks the request that was being logged.
    return String(arg);
  }
}

function push(level: LogLevel, args: unknown[]): void {
  try {
    const msg = args.map(render).join(" ").slice(0, 4000);
    buffer.push({ t: new Date().toISOString(), level, msg });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  } catch {
    // Capturing must never affect the running program.
  }
}

/** Tee console output into the ring. Idempotent — a second call in the same
 *  process is a no-op rather than a double-wrap, which would log everything
 *  twice and grow worse with each hot reload in development. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }

  // The two failures that otherwise leave no trace at all: a background loop
  // rejecting outside its try, and a throw with nobody to catch it. Both are
  // exactly what someone would open this log to find.
  process.on("unhandledRejection", (reason) => {
    push("error", ["unhandled rejection:", reason]);
  });
  process.on("uncaughtException", (err) => {
    push("error", ["uncaught exception:", err]);
    // Rethrowing is not ours to decide — Node's default handling still
    // applies because this listener does not replace it for logging alone.
  });

  push("log", [`log capture started (process up at ${startedAt})`]);
}

export function recentLogs(): { startedAt: string; entries: LogEntry[] } {
  return { startedAt, entries: [...buffer] };
}

/** The same thing as a plain text file, for handing to somebody else. */
export function logsAsText(): string {
  const header = [
    `TrainerDeck server log`,
    `process started: ${startedAt}`,
    `captured at:     ${new Date().toISOString()}`,
    `entries:         ${buffer.length}${buffer.length >= MAX_ENTRIES ? " (oldest dropped)" : ""}`,
    "",
  ].join("\n");
  return header + buffer.map((e) => `${e.t} [${e.level}] ${e.msg}`).join("\n") + "\n";
}
