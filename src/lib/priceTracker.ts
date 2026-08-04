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

import { createAdminClient } from "@/lib/supabase/admin";

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
  if (Number.isFinite(raw) && raw > 0) return raw;
  // 20,000 — the Personal plan's actual allowance.
  //
  // This defaulted to 15,000, a deliberately cautious guess made before the
  // API's own accounting headers were being read. The guess then became the
  // binding limit: the sync stops when it gets within its reserve of the
  // cap, so a 15,000 guess against a 20,000 plan left 5,000 credits a day
  // unspent AND stalled the catalogue sweep at the same time — the worst of
  // both. The real ceiling is enforced upstream and reported on every
  // response (see effectiveRemaining), so this is now only the runaway
  // brake it was always described as.
  return 20_000;
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

/** How many credits are actually left today.
 *
 *  Upstream's number when we have one, our own arithmetic when we don't.
 *  This is the distinction that matters for anything deciding whether to
 *  keep working: our `cap` is a local guess about somebody else's plan, and
 *  a job that stops on a wrong guess stops for no reason. The API reports
 *  its true remaining balance on every response, and it cannot be wrong
 *  about its own accounting.
 *
 *  Callers should prefer this over `cap - used` for exactly that reason. */
/** Credits held back from the BACKGROUND jobs for interactive use.
 *
 *  The nightly sweep will happily spend a whole day's allowance in one run —
 *  that is what it is for — and it already stops at this floor. Nothing else
 *  did. The hourly price refresh calls the paid source once per unpriced
 *  card with no ceiling at all, so it drained the reserve the sweep had
 *  carefully left, and by the afternoon a member pressing "search every
 *  source" got a confident empty answer with no way to tell that credits
 *  were the reason.
 *
 *  Background work stops here. Anything a person is waiting on may spend
 *  below it: that is the whole point of holding it back. */
export const BACKGROUND_RESERVE = 2000;

/** May a background job spend a credit right now? */
export function backgroundBudgetOk(): boolean {
  return effectiveRemaining() > BACKGROUND_RESERVE;
}

export function effectiveRemaining(): number {
  const state = budgetState();
  return state.remainingUpstream ?? Math.max(0, state.cap - state.used);
}

function takeBudget(): boolean {
  const state = budgetState();
  if (state.used >= state.cap) return false;
  spentToday += 1;
  return true;
}

/* The restart-amnesia problem: this counter is process memory, and a deploy
 * restarts the process — so the admin panel read "0 of 15,000 used today"
 * minutes after a sync had spent thousands. Two truths fix it. The durable
 * one: the day's tally is persisted (throttled, best-effort) and re-adopted
 * on the first request after a restart. The authoritative one: the API
 * reports its own daily-remaining header on every response, and the local
 * counter is floored to cap-minus-remaining whenever it appears — upstream
 * never forgets, whatever our process did. */

const BUDGET_STATE_KEY = "pt_budget";
let hydrated = false;
let lastPersist = 0;

export async function hydrateBudget(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", BUDGET_STATE_KEY)
      .maybeSingle();
    const v = data?.value as { day?: string; used?: number; remaining?: number | null } | null;
    if (v && v.day === today() && typeof v.used === "number") {
      budgetState(); // roll the day first so we never adopt into yesterday
      if (v.used > spentToday) spentToday = v.used;
      if (lastRemaining == null && typeof v.remaining === "number") lastRemaining = v.remaining;
    }
  } catch {
    // Display/brake state only — never block lookups on it.
  }
}

function persistBudget(): void {
  const now = Date.now();
  if (now - lastPersist < 15_000) return;
  lastPersist = now;
  try {
    const admin = createAdminClient();
    void admin
      .from("app_state")
      .upsert({
        key: BUDGET_STATE_KEY,
        value: { day: budgetDay, used: spentToday, remaining: lastRemaining },
        updated_at: new Date().toISOString(),
      })
      .then(() => {});
  } catch {
    // Best-effort.
  }
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
  // Keyed by url, so the same image reached under two keys keeps the BETTER
  // score rather than the first one seen.
  //
  // Their payload carries `imageCdnUrl` and `imageCdnUrl800` as the same
  // string. Skipping the second as a duplicate meant the 800px image was
  // scored under the unsized alias, missed the size bonus, and sorted below
  // the 400px one — the live probe returned 400, 200, 800 in that order.
  const found = new Map<string, number>();

  const walk = (node: unknown, key: string, depth: number) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") {
      if (!IMAGE_URL.test(node)) return;
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
      const prev = found.get(node);
      if (prev == null || score > prev) found.set(node, score);
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
  return [...found.entries()]
    .filter(([, score]) => score > -3)
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
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
  /** Their catalogue id. Recorded whenever we see one: it is the join key
   *  for every bulk dataset they publish, and we have no other way to get
   *  one short of fuzzy-matching names later. */
  tcgPlayerId: string | null;
  /** Which FINISH the price belongs to, as they word it ("Reverse
   *  Holofoil", "Holofoil", "Normal"). One number arrives per card, not one
   *  per finish, so without knowing which finish it describes the only
   *  honest thing to do with it is show it for all of them — which is how a
   *  reverse holo ends up displaying a normal's price as if it were its own. */
  printing: string | null;
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
  await hydrateBudget();
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
  if (Number.isFinite(remaining) && remaining >= 0) {
    lastRemaining = remaining;
    // Their count is the truth; ours is a guess that restarts can zero.
    spentToday = Math.max(spentToday, dailyBudget() - remaining);
  }
  persistBudget();

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
  tcgPlayerId?: string;
  name?: string;
  setName?: string;
  cardNumber?: string;
  imageCdnUrl?: string;
  imageCdnUrl200?: string;
  imageCdnUrl400?: string;
  imageCdnUrl800?: string;
  prices?: { market?: number; low?: number; primaryPrinting?: string };
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

/** Do two collector numbers refer to the same card?
 *
 *  Compared on the part before the slash, with leading zeros dropped, so
 *  "15/88", "15" and "015" all agree. Anything with letters keeps them —
 *  "112a" marks an alternate printing sharing a number with "112", and
 *  collapsing the two is how a full art gets a common's price.
 *
 *  A missing number on either side agrees with nothing. That is deliberate:
 *  this exists to check a widened search, and "we can't tell" must not read
 *  as "yes". */
function numbersAgree(theirs: string | undefined, ours: string | null | undefined): boolean {
  const norm = (n: string | null | undefined) =>
    (n ?? "")
      .split("/")[0]
      .trim()
      .toLowerCase()
      .replace(/^0+(?=\d)/, "");
  const a = norm(theirs);
  const b = norm(ours);
  return a.length > 0 && a === b;
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

    // A LADDER, because the set filter was quietly losing common cards.
    //
    // `set` is an exact filter on THEIR set name, which comes from
    // TCGplayer, while ours comes from pokemontcg.io. The two disagree often
    // — "SV: Paldea Evolved" against "Paldea Evolved" — and when they do,
    // the filter excludes the very card we are asking about and the answer
    // is an honest-looking "no source has a price". The set-by-set sync
    // learned this already and deliberately keys on name and number alone;
    // this lookup never got the lesson, which is how a Common in a current
    // set ends up with no price.
    //
    // So: ask with the set, then without it, then with the collector number
    // trimmed to its plain form ("15/88" → "15"). Each rung costs one credit
    // and only runs if the one above found nothing, against an allowance of
    // 20,000 a day.
    // The widened rungs need a collector number to check the answer against,
    // so they are only built when we have one. Without a number a bare-name
    // search cannot be verified, and an unverifiable widening is exactly the
    // thing that puts a wrong price on somebody's card.
    const plain = (query.number ?? "").split("/")[0].trim();
    const widened: Array<Record<string, string>> = [];
    if (plain) {
      if (query.setName) widened.push({ search, limit: "1" });
      if (plain !== (query.number ?? "").trim()) {
        widened.push({ search: [query.name, plain].filter(Boolean).join(" "), limit: "1" });
      }
    }

    // Rung one is the original query, unchanged and still trusted on its own
    // terms: the set filter makes its single answer specific enough to take.
    let json: unknown = await ptFetch("/cards", {
      search,
      ...(query.setName ? { set: query.setName } : {}),
      // ONE. Billing is limit × includes, so this is the difference between
      // 1 credit and 50 for the same answer.
      limit: "1",
    });
    let card: PtCard | null = firstCard(json);

    for (const params of widened) {
      if (card) break;
      const wider = await ptFetch("/cards", params);
      const candidate = firstCard(wider);
      // Dropping the set filter widens the search, so the answer has to be
      // CHECKED rather than taken. A bare name can return any printing of
      // it, and a confidently wrong price on somebody's card is worse than
      // no price at all — that is the whole reason the filter was there.
      if (candidate && numbersAgree(candidate.cardNumber, query.number)) {
        card = candidate;
        json = wider;
      }
    }

    let images = card ? imagesOf(card) : [];
    // Nothing in the documented places — try the tolerant walk before giving
    // up, in case the shape moved.
    if (images.length === 0) images = extractImageUrls(json);

    const price =
      typeof card?.prices?.market === "number" ? card.prices.market : extractMarketPrice(json);

    // A record counts as found if it carries ANYTHING we asked for. This
    // used to require an image, which meant a card that came back priced but
    // pictureless was reported as "not found" — the price thrown away, the
    // miss cached for an hour, and the credit spent for nothing. Art and
    // price are separate questions and a response can answer one of them.
    const tcgPlayerId = typeof card?.tcgPlayerId === "string" ? card.tcgPlayerId : null;
    const printing =
      typeof card?.prices?.primaryPrinting === "string" ? card.prices.primaryPrinting : null;
    const value: PriceTrackerCard | null =
      images.length || price != null || tcgPlayerId
        ? { images, marketPrice: price, tcgPlayerId, printing }
        : null;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // Not cached: a transient failure shouldn't suppress this source for an
    // hour, and the caller falls through to the next step regardless.
    return null;
  }
}

/** Everything one lookup can tell us about a card: price AND artwork.
 *
 *  One credit buys the whole card record, so reading only the price off it
 *  — which is what this did at first — throws away the picture we already
 *  paid for. Both come back from the same call; a card that needs either
 *  gets both.
 *
 *  Returns nulls on anything unexpected: an absent price or image is the
 *  status quo, and a wrong one is worse than none. */
export async function priceTrackerCard(query: {
  name: string;
  setName?: string | null;
  number?: string | null;
}): Promise<{
  market: number | null;
  image: string | null;
  tcgPlayerId: string | null;
  printing: string | null;
}> {
  try {
    const card = await findCard(query);
    if (!card) return { market: null, image: null, tcgPlayerId: null, printing: null };
    // findCard has already ranked the images and read the price off the
    // documented fields; re-walking its return value would only re-derive
    // what it just decided, less well.
    return {
      market: card.marketPrice,
      image: card.images[0] ?? null,
      // Their catalogue id, kept because it is the join key for every bulk
      // dataset they publish and we have no other way to obtain one. It
      // arrives free with a lookup we already paid for.
      tcgPlayerId: card.tcgPlayerId,
      printing: card.printing,
    };
  } catch {
    return { market: null, image: null, tcgPlayerId: null, printing: null };
  }
}

/** Price only, for callers that don't care about art. Same one credit. */
export async function priceTrackerMarketPrice(query: {
  name: string;
  setName?: string | null;
  number?: string | null;
}): Promise<number | null> {
  return (await priceTrackerCard(query)).market;
}
