// Is DeckAI okay right now? Two signals, no new infrastructure.
//
// 1. Anthropic's public status page (statuspage.io JSON, polled with a
//    short cache) — the provider saying "we know".
// 2. This process's own recent Claude calls — an outage the status page
//    hasn't acknowledged yet still shows up as our requests failing. The
//    anthropic() client factory records every call's outcome here.
//
// The result feeds /api/notice: when no admin banner is live, a computed
// one appears on its own and disappears on its own. Fail-open on every
// path — a broken status check must never become its own banner.

const WINDOW_MS = 10 * 60 * 1000;

const outcomes: Array<{ at: number; ok: boolean }> = [];

/** Called by the instrumented client on every Claude API call. `ok` is
 *  false only for provider-shaped failures (5xx/529/429/connection), not
 *  for our own bad requests. */
export function recordAiOutcome(ok: boolean): void {
  const now = Date.now();
  outcomes.push({ at: now, ok });
  while (outcomes.length > 0 && outcomes[0].at < now - WINDOW_MS) outcomes.shift();
  if (outcomes.length > 500) outcomes.splice(0, outcomes.length - 500);
}

/** Does an error look like the PROVIDER failing (count it) rather than us
 *  sending a bad request (don't)? Aborts are the user's hand, not an
 *  outage. */
export function isProviderFailure(err: unknown): boolean {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (/AbortError|APIUserAbortError/.test(name)) return false;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // No HTTP status: connection refused, DNS, timeout — provider-shaped.
  return true;
}

function internalTrouble(): boolean {
  const now = Date.now();
  const recent = outcomes.filter((o) => o.at >= now - WINDOW_MS);
  const fails = recent.filter((o) => !o.ok).length;
  // Three failures AND half of recent traffic failing: single flukes and
  // one bad request in a quiet minute stay silent.
  return fails >= 3 && fails / recent.length >= 0.5;
}

// -------------------------------------------------- Anthropic status page
type Indicator = "none" | "minor" | "major" | "critical";
let statusCache: { at: number; indicator: Indicator | null } = { at: 0, indicator: null };

async function providerIndicator(): Promise<Indicator | null> {
  if (Date.now() - statusCache.at < 2 * 60 * 1000) return statusCache.indicator;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("https://status.anthropic.com/api/v2/status.json", {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    const json = (await res.json()) as { status?: { indicator?: string } };
    const raw = json.status?.indicator;
    const indicator: Indicator | null = ["none", "minor", "major", "critical"].includes(raw ?? "")
      ? (raw as Indicator)
      : null;
    statusCache = { at: Date.now(), indicator };
  } catch {
    statusCache = { at: Date.now(), indicator: null };
  }
  return statusCache.indicator;
}

export interface AiHealthNotice {
  id: string;
  body: string;
  level: "warning" | "outage";
  dismissible: true;
}

/** The banner DeckAI's current health deserves, or null for none. Ids
 *  rotate on a 6-hour bucket so a dismissed banner resurfaces while an
 *  incident drags on, without nagging within one sitting. */
export async function aiHealthNotice(): Promise<AiHealthNotice | null> {
  const bucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
  const indicator = await providerIndicator();

  if (indicator === "major" || indicator === "critical") {
    return {
      id: `ai-provider-outage-${bucket}`,
      level: "outage",
      dismissible: true,
      body:
        "The AI service behind DeckAI (Claude) is reporting an outage — chat, scanning, grading and deck building may fail until it recovers. Your collection, decks and prices are unaffected.",
    };
  }
  const internal = internalTrouble();
  if (indicator === "minor" || internal) {
    return {
      id: `ai-degraded-${bucket}`,
      level: "warning",
      dismissible: true,
      body: internal
        ? "DeckAI is having trouble reaching its AI service right now — chat, scans and deck builds may be slow or fail. This is usually brief; your collection and prices are unaffected."
        : "The AI service behind DeckAI (Claude) is reporting degraded performance — responses may be slow or occasionally fail.",
    };
  }
  return null;
}
