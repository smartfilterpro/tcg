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
//
// The store lives on globalThis rather than in module scope — see below;
// Next.js gives instrumentation and the routes separate copies of a module,
// and a per-copy buffer is one that fills where nobody is reading.

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

/* ON globalThis, NOT in module scope.
 *
 * Next.js compiles instrumentation.ts into its own bundle, separate from the
 * route handlers. Module-level state therefore exists TWICE in one process:
 * the copy the background jobs write to at boot, and the copy an API route
 * sees when it imports the same file. The buffer filled up correctly and the
 * admin page read a different, permanently empty one — "entries: 0" on a
 * server that had been logging for minutes.
 *
 * console itself is a process-wide global, so the patch applied in either
 * bundle catches everything; only the storage was split. Keeping the store
 * on globalThis, keyed by a registered symbol, makes every copy of this
 * module address the same array. */
const STORE = Symbol.for("trainerdeck.logBuffer.v1");

interface Store {
  entries: LogEntry[];
  startedAt: string;
  installed: boolean;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  let s = g[STORE];
  if (!s) {
    s = { entries: [], startedAt: new Date().toISOString(), installed: false };
    g[STORE] = s;
  }
  return s;
}

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
    const { entries } = store();
    entries.push({ t: new Date().toISOString(), level, msg });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  } catch {
    // Capturing must never affect the running program.
  }
}

/** Tee console output into the ring. Idempotent — a second call in the same
 *  process is a no-op rather than a double-wrap, which would log everything
 *  twice and grow worse with each hot reload in development. */
export function installLogCapture(): void {
  const s = store();
  if (s.installed) return;
  s.installed = true;

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

  push("log", [`log capture started (process up at ${s.startedAt})`]);
}

export function recentLogs(): { startedAt: string; entries: LogEntry[] } {
  // Defensive install: if instrumentation didn't run — or ran in a bundle
  // that never reached this code path — the first read still turns capture
  // on rather than reporting an empty log forever.
  installLogCapture();
  const s = store();
  return { startedAt: s.startedAt, entries: [...s.entries] };
}

/** The same thing as a plain text file, for handing to somebody else. */
export function logsAsText(): string {
  const { startedAt, entries } = recentLogs();
  const header = [
    `TrainerDeck server log`,
    `process started: ${startedAt}`,
    `captured at:     ${new Date().toISOString()}`,
    `entries:         ${entries.length}${entries.length >= MAX_ENTRIES ? " (oldest dropped)" : ""}`,
    "",
  ].join("\n");
  return header + entries.map((e) => `${e.t} [${e.level}] ${e.msg}`).join("\n") + "\n";
}
