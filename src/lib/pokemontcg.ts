// Thin client for the pokemontcg.io v2 API (the card reference database).
import type { CardSummary } from "./types";

const BASE = "https://api.pokemontcg.io/v2";

interface RawPrices {
  [variant: string]: { market?: number | null; mid?: number | null; low?: number | null } | undefined;
}

interface RawCard {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  types?: string[];
  hp?: string;
  number: string;
  rarity?: string;
  set: {
    id: string;
    name: string;
    series?: string;
    printedTotal?: number;
    releaseDate?: string;
  };
  images?: { small?: string; large?: string };
  tcgplayer?: { prices?: RawPrices };
  cardmarket?: { prices?: { averageSellPrice?: number; trendPrice?: number } };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.POKEMONTCG_API_KEY) h["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
  return h;
}

/** Best-effort USD market price across print variants. */
function extractPrice(card: RawCard): number | null {
  const prices = card.tcgplayer?.prices;
  if (prices) {
    // Prefer the variant order most people care about
    const order = [
      "holofoil",
      "normal",
      "reverseHolofoil",
      "1stEditionHolofoil",
      "1stEditionNormal",
      "unlimitedHolofoil",
    ];
    for (const key of order) {
      const v = prices[key];
      if (v?.market != null) return v.market;
      if (v?.mid != null) return v.mid;
    }
    // Any other variant
    for (const key of Object.keys(prices)) {
      const v = prices[key];
      if (v?.market != null) return v.market;
    }
  }
  const cm = card.cardmarket?.prices;
  if (cm?.averageSellPrice != null) return cm.averageSellPrice;
  if (cm?.trendPrice != null) return cm.trendPrice;
  return null;
}

/** Per-finish price map — the keys tell us which finishes exist for the card. */
function extractPriceMap(card: RawCard): Record<string, number | null> | null {
  const prices = card.tcgplayer?.prices;
  if (!prices) return null;
  const map: Record<string, number | null> = {};
  for (const key of Object.keys(prices)) {
    const v = prices[key];
    map[key] = v?.market ?? v?.mid ?? v?.low ?? null;
  }
  return Object.keys(map).length > 0 ? map : null;
}

export function toSummary(card: RawCard): CardSummary {
  return {
    id: card.id,
    name: card.name,
    supertype: card.supertype ?? null,
    subtypes: card.subtypes ?? [],
    types: card.types ?? [],
    hp: card.hp ?? null,
    number: card.number,
    rarity: card.rarity ?? null,
    setId: card.set.id,
    setName: card.set.name,
    setSeries: card.set.series ?? null,
    setPrintedTotal: card.set.printedTotal ?? null,
    releaseDate: card.set.releaseDate ?? null,
    imageSmall: card.images?.small ?? null,
    imageLarge: card.images?.large ?? null,
    marketPrice: extractPrice(card),
    prices: extractPriceMap(card),
  };
}

async function apiGet(path: string, params: Record<string, string>): Promise<RawCard[]> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: headers(), cache: "no-store" });
  if (!res.ok) {
    throw new Error(`pokemontcg.io ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { data: RawCard | RawCard[] };
  return Array.isArray(json.data) ? json.data : [json.data];
}

/** Escape values used inside a Lucene-style query. */
function esc(v: string): string {
  return v.replace(/["\\]/g, "");
}

/** Search cards by (partial) name and/or collector number / set size. */
export async function searchCards(opts: {
  name?: string;
  number?: string;
  printedTotal?: string;
  setName?: string;
  pageSize?: number;
}): Promise<CardSummary[]> {
  const clauses: string[] = [];
  if (opts.name) clauses.push(`name:"${esc(opts.name)}*"`);
  if (opts.number) clauses.push(`number:${esc(opts.number).replace(/^0+(?=\d)/, "")}`);
  if (opts.printedTotal)
    clauses.push(`set.printedTotal:${esc(opts.printedTotal).replace(/^0+(?=\d)/, "")}`);
  if (opts.setName) clauses.push(`set.name:"${esc(opts.setName)}*"`);
  if (clauses.length === 0) return [];
  const cards = await apiGet("/cards", {
    q: clauses.join(" "),
    pageSize: String(opts.pageSize ?? 12),
    orderBy: "-set.releaseDate",
  });
  return cards.map(toSummary);
}

export async function getCardById(id: string): Promise<CardSummary | null> {
  try {
    const cards = await apiGet(`/cards/${encodeURIComponent(id)}`, {});
    return cards[0] ? toSummary(cards[0]) : null;
  } catch {
    return null;
  }
}

/** Given what Claude detected on a card, find the best DB match + alternatives. */
export async function matchDetectedCard(detected: {
  name: string;
  collectorNumber: string | null;
  setTotal: string | null;
  setNameHint: string | null;
}): Promise<{ match: CardSummary | null; candidates: CardSummary[] }> {
  let candidates: CardSummary[] = [];

  // Pass 1: name + number (most precise)
  if (detected.name && detected.collectorNumber) {
    try {
      candidates = await searchCards({ name: detected.name, number: detected.collectorNumber });
    } catch {
      candidates = [];
    }
  }
  // Pass 2: name only
  if (candidates.length === 0 && detected.name) {
    try {
      candidates = await searchCards({ name: detected.name, pageSize: 12 });
    } catch {
      candidates = [];
    }
  }

  if (candidates.length === 0) return { match: null, candidates: [] };

  // Score: number match, printed-total match, set-name hint match
  const normNum = (n: string | null) => (n ?? "").replace(/^0+(?=\d)/, "").toLowerCase();
  const scored = candidates.map((c) => {
    let score = 0;
    if (detected.collectorNumber && normNum(c.number) === normNum(detected.collectorNumber)) score += 4;
    if (detected.setTotal && c.setPrintedTotal != null && String(c.setPrintedTotal) === normNum(detected.setTotal)) score += 3;
    if (
      detected.setNameHint &&
      c.setName.toLowerCase().includes(detected.setNameHint.toLowerCase())
    )
      score += 2;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { match: scored[0].c, candidates: scored.map((s) => s.c) };
}
