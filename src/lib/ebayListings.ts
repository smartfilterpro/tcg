// "What will this card cost me to buy?" — from eBay's active listings.
//
// This is the one honest use of Browse data. An asking price is the wrong
// answer to "what is my card worth" (asks on singles run well above sales)
// and exactly the right answer to "what will I pay for this", which is the
// question the deck builder's buy-list asks. Nothing here feeds valuations,
// the grading value table, or collection totals.
//
// The hard part is not the API, it's the noise. A live search for
// "pokemon charizard" returns, in its first three results:
//
//   1999 Base Set Shadowless Holo 4/102 LP-MP ............... $79.50  ← a card
//   "GUARANTEED VINTAGE - Holos, Ultra Rares, 50 Cards" ..... $24.69  ← a lot
//   "Foil Multi-Color Pack 55 Card ... Charizard Rare" ...... $11.27  ← a bundle
//
// Two of three are not the card. A naive median over that says a Charizard
// costs $24.69. So the filtering below is the feature; the search is
// plumbing.

import { SCOPE_BASE, ebayEnabled, ebayFetch, marketplace } from "@/lib/ebay";

export interface ListingPrice {
  /** Cheapest credible listing, including shipping where eBay reports it. */
  low: number;
  /** Middle of the filtered set — more robust than the low, which is often
   *  a damaged copy or a seller with a story. */
  median: number;
  /** How many listings survived filtering. Below ~3 the numbers are weak and
   *  the UI should say so rather than pretending to precision. */
  count: number;
  currency: string;
  /** A normal eBay search page, so the reader can check our work. */
  url: string;
}

/* --------------------------------------------------------------- filtering */

// Multi-card items. These are the big distortion: a 50-card lot priced at
// $24.69 looks like a cheap single to any code that only reads the number.
const MULTI = [
  /\b(lot|lots|bundle|bulk|joblot|job\s?lot|collection|wholesale)\b/i,
  /\b\d{2,}\s*(cards?|pcs|pieces|ct)\b/i,
  /\bx\s?\d{2,}\b/i,
  /\b(booster|pack|packs|box|tin|etb|elite\s?trainer|blister|repack|mystery|grab\s?bag)\b/i,
];

// Not the physical card at all. Code cards are the worst of these: they're
// real eBay listings, cost about a dollar, and match the card's name exactly.
const NOT_A_CARD = [
  /\b(code\s?cards?|online\s?code|ptcgl|ptcgo|digital|email\s?delivery)\b/i,
  /\b(proxy|custom|orica|fan\s?art|replica|not\s?official|metal\s?card|gold\s?plated)\b/i,
  /\b(sleeve|binder|playmat|deck\s?box|toploader|display|poster|sticker|plush)\b/i,
];

// Graded copies are real singles at a different price altogether — a PSA 10
// can be ten times the raw card. Someone buying playables wants the raw one.
const GRADED = /\b(psa|bgs|cgc|sgc|ace)\s?(10|9\.5|9|8\.5|8|7)?\b|\bgraded\b|\bgem\s?mt\b/i;

// Condition floors. A creased copy legitimately sells for less, and quoting
// it as "from $0.40" sends someone to a card they'd be unhappy with.
const DAMAGED = /\b(damaged|poor|heavily\s?played|hp\b|creased|water\s?damage|as\s?is)\b/i;

interface Summary {
  title: string;
  total: number;
  currency: string;
}

function excluded(title: string): boolean {
  return (
    MULTI.some((re) => re.test(title)) ||
    NOT_A_CARD.some((re) => re.test(title)) ||
    GRADED.test(title) ||
    DAMAGED.test(title)
  );
}

/** Every significant word of the card's name has to appear. Cheap, and it
 *  catches the searches that drift onto a different card entirely. */
function nameMatches(title: string, name: string): boolean {
  const haystack = title.toLowerCase();
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .every((w) => haystack.includes(w));
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------------------------------------------ cache */

// In memory, never persisted. Two reasons, and the second is the binding one:
// prices move slowly enough that six hours is fine, and eBay's API License
// Agreement limits how long their data may be retained. A cache that dies
// with the process cannot drift out of compliance while nobody is looking.
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: ListingPrice | null }>();

function cached(key: string): { hit: boolean; value: ListingPrice | null } {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.at > TTL_MS) return { hit: false, value: null };
  return { hit: true, value: entry.value };
}

function remember(key: string, value: ListingPrice | null): void {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first — Map preserves it, and an exact LRU isn't worth
    // the bookkeeping for a cache this size.
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/* ----------------------------------------------------------------- lookup */

export interface CardQuery {
  name: string;
  /** Collector number, e.g. "185/193" or "185". Sharpens the search a lot. */
  number?: string | null;
  setName?: string | null;
}

function searchTerms(card: CardQuery): string {
  // The number goes in verbatim — "4/102", not "4". Sellers write the full
  // collector number in titles, and stripping the denominator turns a precise
  // term into a digit that matches everything. A single character is dropped
  // for the same reason: it narrows nothing and costs relevance.
  const number = (card.number ?? "").trim();
  return ["pokemon", card.name, number.length > 1 ? number : ""].filter(Boolean).join(" ");
}

export function searchUrl(card: CardQuery): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchTerms(card))}`;
}

/** Asking prices for one card. Null when eBay is off, the search fails, or
 *  nothing credible survives filtering — all three mean "say nothing", never
 *  "show a zero". */
export async function listingPrice(card: CardQuery): Promise<ListingPrice | null> {
  if (!ebayEnabled()) return null;

  const key = `${marketplace()}|${searchTerms(card)}`;
  const hit = cached(key);
  if (hit.hit) return hit.value;

  let items: Array<Record<string, unknown>> = [];
  try {
    const json = await ebayFetch("/buy/browse/v1/item_summary/search", {
      params: {
        q: searchTerms(card),
        limit: 50,
        // Fixed price only: an auction's current bid is not what the card
        // costs, it's what someone has bid so far with hours left to run.
        filter: "buyingOptions:{FIXED_PRICE}",
      },
      scopes: [SCOPE_BASE],
    });
    items = (json.itemSummaries as Array<Record<string, unknown>>) ?? [];
  } catch {
    // A failed price lookup must never break the page it decorates. Not
    // cached, so a transient failure doesn't suppress prices for six hours.
    return null;
  }

  const summaries: Summary[] = [];
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title : "";
    if (!title || excluded(title) || !nameMatches(title, card.name)) continue;

    const price = item.price as { value?: string; currency?: string } | undefined;
    const value = Number(price?.value);
    if (!Number.isFinite(value) || value <= 0) continue;

    // Shipping is part of what it costs. Free-shipping listings report 0;
    // ones that don't report it at all are taken at face value rather than
    // guessed at.
    const shipping = (item.shippingOptions as Array<{ shippingCost?: { value?: string } }>) ?? [];
    const ship = Math.min(
      ...shipping.map((s) => Number(s.shippingCost?.value)).filter((n) => Number.isFinite(n)),
      Infinity
    );
    summaries.push({
      title,
      total: value + (Number.isFinite(ship) ? ship : 0),
      currency: price?.currency ?? "USD",
    });
  }

  if (summaries.length === 0) {
    remember(key, null);
    return null;
  }

  const totals = summaries.map((s) => s.total).sort((a, b) => a - b);
  const result: ListingPrice = {
    low: Math.round(totals[0] * 100) / 100,
    median: Math.round(median(totals) * 100) / 100,
    count: totals.length,
    currency: summaries[0].currency,
    url: searchUrl(card),
  };
  remember(key, result);
  return result;
}

/** Prices for several cards. Sequential on purpose: Browse allows roughly
 *  5,000 calls a day, and a deck's buy-list is a dozen cards at most, so
 *  there is nothing to gain from hammering it in parallel. */
export async function listingPrices(
  cards: CardQuery[]
): Promise<Record<string, ListingPrice | null>> {
  const out: Record<string, ListingPrice | null> = {};
  for (const card of cards) {
    out[card.name] = await listingPrice(card);
  }
  return out;
}
