// Keeping long admin jobs alive across a phone falling asleep.
//
// Several admin panels drive a long job by calling a route in a loop: import
// a page, mirror a batch, sync a set, then call again. The server persists
// its progress every time, so the WORK is durable — but the loop isn't. When
// a phone screen sleeps, the browser kills the request in flight, fetch
// rejects with a bare TypeError, and the panel gives up showing "Load
// failed" on a job that was running fine and is still sitting there half
// done.
//
// Nothing was actually lost in that case; the client just stopped asking.
// So the fix belongs in the asking: wait until the tab is visible again,
// then retry. A network blip and a sleeping phone look identical from here
// and want the same response, which is why one helper covers both.

/** Resolve once the document is visible, immediately if it already is. */
export function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onChange);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/** True for the failure a dropped connection produces.
 *
 *  fetch rejects with a TypeError for every transport-level problem and
 *  carries no machine-readable cause, so this is a type check, not a string
 *  match — an HTTP error is a Response and never lands here. Deliberately
 *  broad: retrying is safe for these routes (each call is a resumable step
 *  reading server-side progress), so a false positive costs one extra
 *  request and a false negative costs the whole job. */
function isTransport(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

export interface ResilientOptions {
  /** Give up after this many consecutive transport failures. */
  attempts?: number;
  /** Called before each retry, for showing "reconnecting…" in the panel. */
  onRetry?: (attempt: number) => void;
  /** Checked before each retry; true abandons the loop. */
  stopped?: () => boolean;
  /** Abandon a single attempt after this long and retry it.
   *
   *  The default sits just above the longest maxDuration in the app, so it
   *  can only ever fire on a request the server has already given up on —
   *  which is exactly the case it exists for: a socket that died quietly
   *  and would otherwise leave the panel waiting forever. Lower it for a
   *  route you know is quick. */
  timeoutMs?: number;
}

/** Just past the 300s ceiling the long admin routes declare. */
const DEFAULT_TIMEOUT_MS = 330_000;

/** fetch that survives the screen going off.
 *
 *  Only transport failures are retried. An HTTP error response is returned
 *  untouched for the caller to handle — a 500 from the job is real news and
 *  must not be papered over by a retry. */
export async function resilientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: ResilientOptions = {}
): Promise<Response> {
  const attempts = opts.attempts ?? 6;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.stopped?.()) throw new Error("Stopped");
    try {
      // A caller's own signal wins — it usually means "the user pressed
      // stop", which is not something to override with a deadline.
      const signal = init?.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return await fetch(input, { ...init, signal });
    } catch (err) {
      if (!isTransport(err)) throw err;
      lastError = err;
      opts.onRetry?.(attempt + 1);
      // Visibility first: retrying while the screen is still off just
      // fails again and burns an attempt for nothing.
      await whenVisible();
      // Then a short backoff, because a tab that just woke up is often a
      // moment ahead of the network it is about to use.
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
    }
  }
  throw lastError instanceof Error
    ? new Error(`Lost connection — ${lastError.message}. Progress was saved; press again to resume.`)
    : new Error("Lost connection. Progress was saved; press again to resume.");
}
