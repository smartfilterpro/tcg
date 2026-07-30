// Pokémon Price Tracker (pokemonpricetracker.com) — paid API, 20,000 credits
// a day on the personal plan.
//
// Used as a FALLBACK, never a first choice. The order that matters:
//
//   1. our own cards table          — free, instant, already imported
//   2. pokemontcg.io / TCGdex       — free, and the card's own source
//   3. this                         — paid, but a real card database
//   4. the AI web search            — costs the user credits and guesses
//
// Slotting it in at 3 is the whole point: the AI search is the expensive,
// least reliable step, and every card this finds is a card that never
// reaches it. 20,000 a day is far more headroom than the free sources leave
// us needing, which is exactly why it belongs behind them rather than in
// front.
//
// ── The billing detail that shapes this whole file ───────────────────────
// Credits are charged on the REQUESTED limit, not on the number of matches:
//
//     cost = limit × (1 + includeHistory + includeEbay + includeCardmarket)
//
// So limit=50 (their default) costs 50 credits to find one card, and asking
// for five candidates costs five times what asking for one does. Every
// request here therefore pins limit=1 and sets no include flags — one credit
// per lookup, which is what makes 20,000 a day effectively unlimited for us.
// Do not raise the limit to "get more options": the extractor already ranks
// the four image sizes a single card carries.

const BASE = (process.env.POKEMONPRICETRACKER_BASE ?? "https://www.pokemonpricetracker.com/api/v2")
  .trim()
  .replace(/\/$/, "");

function apiKey(): string {
  return (process.env.POKEMONPRICETRACKER_API_KEY ?? "").trim();
}

export function priceTrackerEnabled(): boolean {
  return apiKey().length > 0;
}

/** Which header carries the key. Configurable because it is the single most
 *  likely thing to be wrong, and being able to fix it without a code change
 *  turns a redeploy into an env var edit. */
function authHeaders(): Record<string, string> {
  const key = apiKey();
  const style = (process.env.POKEMONPRICETRACKER_AUTH ?? "bearer").trim().toLowerCase();
  if (style === "x-api-key") return { "X-API-Key": key };
  if (style === "apikey") return { apikey: key };
  return { Authorization: `Bearer ${key}` };
}

/* ----------------------------------------------------------------- budget */

// 20,000 a day, and we should never be near it — but "should" is not a
// guard. Counted in memory, which means a restart forgets it, so this is a
// brake rather than a hard cap. That is the right trade here: the failure it
// prevents is a runaway loop burning the day's quota in minutes, and an
// in-memory counter catches that. A hard cap would need a database round
// trip on every lookup, to protect a limit we are not close to.
// Read per call, not once at import. Module-scope env reads freeze whatever
// the value was when the file was first loaded, which is invisible until
// something needs to change it — and makes the brake untestable besides.
function dailyBudget(): number {
  const raw = Number(process.env.POKEMONPRICETRACKER_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}
let spentToday = 0;
let budgetDay = "";
/** Their own count of what's left today, when they've told us. */
let lastRemaining: number | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function budgetState(): {
  used: number;
  cap: number;
  day: string;
  remainingUpstream: number | null;
} {
  if (budgetDay !== today()) {
    budgetDay = today();
    spentToday = 0;
    lastRemaining = null;
  }
  return { used: spentToday, cap: dailyBudget(), day: budgetDay, remainingUpstream: lastRemaining };
}

function takeBudget(): boolean {
  const state = budgetState();
  if (state.used >= state.cap) return false;
  spentToday += 1;
  return true;
}

/* ------------------------------------------------------------------ cache */

// Card art does not change. A card we have already looked up and failed to
// find art for should not be looked up again on every page view — negative
// results are cached too, for a shorter time.
const HIT_TTL = 24 * 60 * 60 * 1000;
const MISS_TTL = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: PriceTrackerCard | null }>();

/* ---------------------------------------------------------------- parsing */

const IMAGE_URL = /^https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?$/i;

/** Pull image URLs out of a response without assuming its shape.
 *
 *  Deliberately structural rather than a field path. Their exact JSON is
 *  unverified, and a parser keyed to `data.card.images.large` would return
 *  nothing — silently — if it is `data.image_url` instead. Walking for
 *  strings that ARE image URLs cannot be wrong about the shape, only about
 *  which of several images is best, which the ranking below handles.
 *
 *  Returns largest-looking first: keys mentioning large/high/hires usually
 *  are, and a card scan is worth having at the best resolution offered. */
export function extractImageUrls(json: unknown): string[] {
  const found: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();

  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") {
      if (!IMAGE_URL.test(node) || seen.has(node)) return;
      seen.add(node);
      const k = key.toLowerCase();
      // Prefer explicit "large", then anything image-ish, and push
      // thumbnails and symbols/logos to the back — a set symbol is an image
      // URL and is not the card.
      let score = 0;
      if (/large|hi_?res|high|full|original/.test(k)) score += 3;
      if (/image|img|photo|art|scan|card/.test(k)) score += 2;
      if (/small|thumb|tiny|preview/.test(k)) score -= 2;
      // Their card images come as imageCdnUrl / …200 / …400 / …800 — the
      // number is the pixel size, so read it and prefer the biggest. Without
      // this all four score identically and the winner is whichever the JSON
      // happened to list first.
      const px = /(\d{2,4})\s*$/.exec(k);
      if (px) score += Math.min(2, Number(px[1]) / 400);
      if (/logo|symbol|icon|avatar|banner/.test(k)) score -= 5;
      found.push({ url: node, score });
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, key, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, k, depth + 1);
      }
    }
  };

  walk(json, "", 0);
  return found
    .filter((f) => f.score > -3)
    .sort((a, b) => b.score - a.score)
    .map((f) => f.url);
}

/** Any USD-looking price in the response, best effort. Same reasoning as the
 *  images: structural rather than keyed to an unverified field path. */
export function extractMarketPrice(json: unknown): number | null {
  let best: { value: number; score: number } | null = null;
  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "number" && Number.isFinite(node) && node > 0 && node < 1_000_000) {
      const k = key.toLowerCase();
      let score = 0;
      if (/market/.test(k)) score += 3;
      if (/price|value|usd/.test(k)) score += 2;
      if (/low|high|mid/.test(k)) score -= 1;
      if (/id|count|qty|quantity|number|total|rank|year/.test(k)) score -= 10;
      if (score > 0 && (!best || score > best.score)) best = { value: node, score };
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, key, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, k, depth + 1);
      }
    }
  };
  walk(json, "", 0);
  return best ? (best as { value: number }).value : null;
}

/* ---------------------------------------------------------------- lookup */

export interface PriceTrackerCard {
  images: string[];
  marketPrice: number | null;
  /** Kept for the admin probe, so the shape can be inspected once. */
  raw?: unknown;
}

export class PriceTrackerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PriceTrackerError";
  }
}

/** One request.
 *
 *  Also reads their accounting headers: X-API-Calls-Consumed is what this
 *  call actually cost and X-RateLimit-Daily-Remaining is the balance after
 *  it. Both beat our own guess, so the local counter is corrected from them
 *  whenever they appear — a local tally can only ever drift. */
export async function ptFetch(
  path: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  if (!priceTrackerEnabled()) throw new PriceTrackerError("No API key configured.", 503);
  if (!takeBudget()) {
    throw new PriceTrackerError(
      `Daily budget of ${dailyBudget().toLocaleString()} requests is used up.`,
      429
    );
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { ...authHeaders(), Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const consumed = Number(res.headers.get("x-api-calls-consumed"));
  if (Number.isFinite(consumed) && consumed > 1) {
    // We asked for one credit's worth and were charged more — worth knowing
    // immediately rather than at the end of a month.
    spentToday += consumed - 1;
  }
  const remaining = Number(res.headers.get("x-ratelimit-daily-remaining"));
  if (Number.isFinite(remaining)) lastRemaining = remaining;

  const text = await res.text();
  if (!res.ok) {
    throw new PriceTrackerError(
      `pokemonpricetracker ${res.status} on ${path}: ${text.slice(0, 200) || "empty body"}`,
      res.status
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PriceTrackerError(`Response was not JSON: ${text.slice(0, 200)}`, 502);
  }
}

/** Their documented card shape, as much of it as we use. */
interface PtCard {
  name?: string;
  setName?: string;
  cardNumber?: string;
  imageCdnUrl?: string;
  imageCdnUrl200?: string;
  imageCdnUrl400?: string;
  imageCdnUrl800?: string;
  prices?: { market?: number; low?: number };
}

/** Card art from the documented fields, biggest first.
 *
 *  Read directly rather than by walking the JSON. /sets returns images under
 *  exactly the same key names as /cards, so anything structural would happily
 *  hand back a set logo as if it were the card. The tolerant walk stays as a
 *  fallback for a response that doesn't match this shape at all. */
function imagesOf(card: PtCard): string[] {
  // Deduped: in their own documented example imageCdnUrl and imageCdnUrl800
  // are the SAME url, so without this the downloader fetches the identical
  // file twice before trying a genuinely different size.
  return [
    ...new Set(
      [card.imageCdnUrl800, card.imageCdnUrl400, card.imageCdnUrl, card.imageCdnUrl200].filter(
        (u): u is string => typeof u === "string" && u.length > 0
      )
    ),
  ];
}

/** `data` is a single object for an id lookup and an array for a search. */
function firstCard(json: unknown): PtCard | null {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) return (data[0] as PtCard) ?? null;
  if (data && typeof data === "object") return data as PtCard;
  return null;
}

/** Look a card up by name, set and number. Null on anything going wrong —
 *  this is a fallback, and it must never be the reason a page fails. */
export async function findCard(query: {
  name: string;
  setName?: string | null;
  number?: string | null;
}): Promise<PriceTrackerCard | null> {
  if (!priceTrackerEnabled()) return null;

  const key = [query.name, query.setName ?? "", query.number ?? ""].join("|").toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? HIT_TTL : MISS_TTL)) return hit.value;

  try {
    // One multi-word `search` rather than separate name/number filters: it
    // spans name, setName, cardNumber and rarity, and handles the "4/102"
    // form directly, which is how collector numbers are written.
    const search = [query.name, query.number ?? ""].filter(Boolean).join(" ");
    const json = await ptFetch("/cards", {
      search,
      ...(query.setName ? { set: query.setName } : {}),
      // ONE. Billing is limit × includes, so this is the difference between
      // 1 credit and 50 for the same answer.
      limit: "1",
    });

    const card = firstCard(json);
    let images = card ? imagesOf(card) : [];
    // Nothing in the documented places — try the tolerant walk before giving
    // up, in case the shape moved.
    if (images.length === 0) images = extractImageUrls(json);

    const price =
      typeof card?.prices?.market === "number" ? card.prices.market : extractMarketPrice(json);

    const value: PriceTrackerCard | null = images.length
      ? { images, marketPrice: price }
      : null;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // Not cached: a transient failure shouldn't suppress this source for an
    // hour, and the caller falls through to the next step regardless.
    return null;
  }
}
