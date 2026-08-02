// The paid source's sealed-product catalogue.
//
// GET /sealed-products — booster boxes, ETBs, bundles, with TCGplayer
// pricing and official product images. This is a better source for sealed
// than eBay in every respect that matters: a canonical product name instead
// of a seller's headline, a market price instead of an asking price, a
// proper product shot instead of a photo of a box on someone's carpet, and
// a stable id to re-fetch by.
//
// So for SEALED the order is the reverse of cards: paid first, eBay as the
// fallback. That is not a contradiction of the rule used elsewhere, it is
// the same rule applied honestly — free sources go first when they hold the
// SAME data, and here they hold worse data. eBay still covers what this
// catalogue does not: Japanese product beyond its language option, oddities,
// and anything too old or too local to be listed.
//
// ── Billing ─────────────────────────────────────────────────────────────
// cost = limit × (1 + includeHistory), charged on the REQUESTED limit, not
// on matches — the same trap as /cards. So a single lookup pins limit=1 for
// one credit, and a search asks for a deliberately modest page rather than
// the default 50. includeHistory is never set: it doubles the bill for a
// chart nothing renders yet.

import { ptFetch, priceTrackerEnabled } from "@/lib/priceTracker";

export interface TrackerSealedProduct {
  tcgPlayerId: string | null;
  name: string;
  setId: string | null;
  setName: string | null;
  /** Their price field for sealed. NOT `prices.market` — that is the card
   *  shape, and reading it here would find nothing and report no price for
   *  a product that has one. */
  price: number | null;
  image: string | null;
}

/** How many results a type-ahead search asks for.
 *
 *  Every one costs a credit, so this is a spend per search, not per result
 *  used. Fifteen is enough to find the box somebody means without turning a
 *  search box into a way to spend the day's allowance — and the default of
 *  50 would cost more than three times as much for a list nobody scrolls. */
const SEARCH_LIMIT = 15;

function parse(record: Record<string, unknown>): TrackerSealedProduct | null {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const price =
    typeof record.unopenedPrice === "number" && record.unopenedPrice > 0
      ? record.unopenedPrice
      : null;
  // Biggest image first, deduped: their card shape serves the same URL under
  // several keys, and there is no reason to assume sealed differs.
  const image =
    [record.imageCdnUrl800, record.imageCdnUrl400, record.imageCdnUrl, record.imageUrl].find(
      (u): u is string => typeof u === "string" && u.length > 0
    ) ?? null;
  return {
    tcgPlayerId: typeof record.tcgPlayerId === "string" ? record.tcgPlayerId : null,
    name,
    setId: typeof record.setId === "string" ? record.setId : null,
    setName: typeof record.setName === "string" ? record.setName : null,
    price,
    image,
  };
}

/** `data` is a single object for an id lookup and an array for a search. */
function records(json: unknown): Array<Record<string, unknown>> {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") return [data as Record<string, unknown>];
  return [];
}

/* ------------------------------------------------------------------ cache */

// Sealed prices move slowly and product names never do, so a search repeated
// while somebody types the same word twice should not be paid for twice.
const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: TrackerSealedProduct[] }>();

function cached(key: string): TrackerSealedProduct[] | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit.value;
}

function remember(key: string, value: TrackerSealedProduct[]): void {
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}

/* ---------------------------------------------------------------- lookups */

/** Search sealed product by name.
 *
 *  Empty array on anything going wrong — this feeds a suggestion list, and
 *  a suggestion list that throws is worse than one that is short. */
export async function searchTrackerSealed(query: string): Promise<TrackerSealedProduct[]> {
  const q = query.trim();
  // Their endpoint requires at least one filter, and a one-character search
  // would return an arbitrary slice of the catalogue for full price.
  if (!priceTrackerEnabled() || q.length < 3) return [];

  const key = `search:${q.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const json = await ptFetch("/sealed-products", {
      search: q,
      limit: String(SEARCH_LIMIT),
      sortBy: "price",
      sortOrder: "desc",
    });
    const out = records(json)
      .map(parse)
      .filter((p): p is TrackerSealedProduct => p !== null);
    remember(key, out);
    return out;
  } catch {
    return [];
  }
}

/** One product, by their id. Exact — no name matching, so a reprice cannot
 *  drift onto a different box. One credit. */
export async function trackerSealedById(
  tcgPlayerId: string
): Promise<TrackerSealedProduct | null> {
  if (!priceTrackerEnabled() || !tcgPlayerId) return null;
  const key = `id:${tcgPlayerId}`;
  const hit = cached(key);
  if (hit) return hit[0] ?? null;
  try {
    const json = await ptFetch("/sealed-products", { tcgPlayerId, limit: "1" });
    const out = records(json)
      .map(parse)
      .filter((p): p is TrackerSealedProduct => p !== null);
    remember(key, out);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

/** Best single match for a product name. One credit. */
export async function trackerSealedByName(
  name: string
): Promise<TrackerSealedProduct | null> {
  if (!priceTrackerEnabled() || name.trim().length < 3) return null;
  const key = `one:${name.trim().toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit[0] ?? null;
  try {
    const json = await ptFetch("/sealed-products", { search: name.trim(), limit: "1" });
    const out = records(json)
      .map(parse)
      .filter((p): p is TrackerSealedProduct => p !== null);
    remember(key, out);
    return out[0] ?? null;
  } catch {
    return null;
  }
}
