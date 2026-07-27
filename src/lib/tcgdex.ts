// Fallback card lookup via TCGdex (https://tcgdex.dev) — a second free,
// community-maintained card database. It typically gets brand-new sets and
// promos months before pokemontcg.io, so we consult it whenever the primary
// database returns nothing. Pricing data is spottier, so prices may be null.
import type { CardSummary } from "./types";

const BASE = "https://api.tcgdex.net/v2/en";

interface TcgdexBrief {
  id: string;
  localId?: string | number;
  name: string;
  image?: string;
}

interface TcgdexCard extends TcgdexBrief {
  category?: string; // "Pokemon" | "Trainer" | "Energy"
  rarity?: string;
  hp?: number | string;
  types?: string[];
  stage?: string; // "Basic" | "Stage1" | "Stage2" | ...
  trainerType?: string; // "Supporter" | "Item" | "Stadium" | "Tool" | ...
  energyType?: string; // "Basic" | "Special"
  effect?: string; // Trainer / Special Energy rules text
  retreat?: number;
  attacks?: Array<{ cost?: string[]; name: string; effect?: string; damage?: number | string }>;
  abilities?: Array<{ type?: string; name: string; effect?: string }>;
  weaknesses?: Array<{ type: string; value?: string }>;
  resistances?: Array<{ type: string; value?: string }>;
  set?: {
    id?: string;
    name?: string;
    cardCount?: { official?: number; total?: number };
    releaseDate?: string;
  };
  pricing?: Record<string, unknown>;
}

async function get<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Best-effort price from TCGdex's pricing block (shape varies; be defensive). */
function extractTcgdexPrice(pricing: Record<string, unknown> | undefined): number | null {
  if (!pricing) return null;
  const cm = pricing.cardmarket as Record<string, unknown> | undefined;
  for (const key of ["avg30", "avg", "trendPrice", "trend", "low"]) {
    const v = cm?.[key];
    if (typeof v === "number" && v > 0) return v;
  }
  const tp = pricing.tcgplayer as Record<string, Record<string, unknown>> | undefined;
  if (tp) {
    for (const variant of Object.values(tp)) {
      if (variant && typeof variant === "object") {
        const m = (variant as Record<string, unknown>).marketPrice;
        if (typeof m === "number" && m > 0) return m;
      }
    }
  }
  return null;
}

function toSummary(card: TcgdexCard): CardSummary {
  const price = extractTcgdexPrice(card.pricing);
  // Build subtypes from TCGdex's structured fields so Basic/evolution and
  // Supporter/Item/Stadium detection works the same as primary-DB cards.
  const subtypes: string[] = [];
  if (card.stage) subtypes.push(card.stage.replace(/^Stage(\d)$/, "Stage $1"));
  if (card.trainerType) subtypes.push(card.trainerType);
  if (card.energyType === "Special") subtypes.push("Special");
  return {
    // Prefix the id so it can't collide with pokemontcg.io ids in the cards table
    id: `tcgdex-${card.id}`,
    name: card.name,
    supertype:
      card.category === "Pokemon" ? "Pokémon" : (card.category ?? null),
    subtypes,
    types: card.types ?? [],
    hp: card.hp != null ? String(card.hp) : null,
    number: String(card.localId ?? ""),
    rarity: card.rarity ?? null,
    setId: `tcgdex-${card.set?.id ?? "unknown"}`,
    setName: card.set?.name ?? "Unknown set",
    setSeries: null,
    setPrintedTotal: card.set?.cardCount?.official ?? null,
    releaseDate: card.set?.releaseDate ?? null,
    imageSmall: card.image ? `${card.image}/low.webp` : null,
    imageLarge: card.image ? `${card.image}/high.webp` : null,
    marketPrice: price,
    prices: null, // TCGdex doesn't give reliable per-finish prices
  };
}

/** Refresh pricing for a card we stored from TCGdex ("tcgdex-" id prefix). */
export async function getTcgdexPriceById(prefixedId: string): Promise<number | null> {
  const id = prefixedId.replace(/^tcgdex-/, "");
  const card = await get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
  return card ? extractTcgdexPrice(card.pricing) : null;
}

/** Combat/battle data for a TCGdex-sourced card ("tcgdex-" id prefix) —
 *  same shape the primary database produces, so referee-mode attack
 *  buttons, HP, stages, and card text work for new-set cards too. */
export async function getTcgdexBattleDataById(
  prefixedId: string
): Promise<import("./pokemontcg").CardBattleData | null> {
  const id = prefixedId.replace(/^tcgdex-/, "");
  const card = await get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
  if (!card || !card.name) return null;
  const isPokemon = card.category === "Pokemon";
  const rules = [card.effect?.trim()].filter((r): r is string => !!r);
  const hpNum = typeof card.hp === "number" ? card.hp : parseInt(String(card.hp ?? ""), 10);
  return {
    attacks: isPokemon
      ? (card.attacks ?? []).map((a) => ({
          name: a.name,
          cost: a.cost ?? [],
          damage: a.damage != null ? String(a.damage) : "",
          text: a.effect?.trim() || null,
        }))
      : [],
    weak: card.weaknesses?.[0]
      ? { type: card.weaknesses[0].type, value: card.weaknesses[0].value ?? "×2" }
      : null,
    resist: card.resistances?.[0]
      ? { type: card.resistances[0].type, value: card.resistances[0].value ?? "-30" }
      : null,
    retreat: card.retreat ?? 0,
    ...(rules.length > 0 ? { rules } : {}),
    ...((card.abilities ?? []).length > 0
      ? {
          abilities: card.abilities!
            .filter((a) => a.name)
            .map((a) => ({ name: a.name, text: a.effect?.trim() ?? "" })),
        }
      : {}),
    stage: card.stage ? card.stage.replace(/^Stage(\d)$/, "Stage $1") : null,
    hp: Number.isFinite(hpNum) && hpNum > 0 ? hpNum : null,
    trainerType: card.trainerType ?? null,
  };
}

/** Search TCGdex by name and/or collector number. */
export async function searchTcgdex(opts: {
  name?: string;
  number?: string;
  pageSize?: number;
}): Promise<CardSummary[]> {
  if (!opts.name && !opts.number) return [];
  const params = new URLSearchParams();
  if (opts.name) params.set("name", opts.name);
  if (opts.number) {
    // TCGdex filtering is a contains-match, so the zero-stripped digits
    // catch "095", "95", and "SWSH095" alike.
    params.set("localId", opts.number.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || opts.number);
  }

  let briefs = await get<TcgdexBrief[]>(`${BASE}/cards?${params.toString()}`);
  // Name + number found nothing (the number may be misread or formatted
  // differently) — retry on name alone rather than giving up.
  if ((!Array.isArray(briefs) || briefs.length === 0) && opts.name && opts.number) {
    briefs = await get<TcgdexBrief[]>(
      `${BASE}/cards?${new URLSearchParams({ name: opts.name }).toString()}`
    );
  }
  if (!Array.isArray(briefs) || briefs.length === 0) return [];

  // Put number-matching briefs first so they survive the detail-fetch cap.
  if (opts.number) {
    const wanted = opts.number.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    if (wanted) {
      const briefKey = (b: TcgdexBrief) =>
        String(b.localId ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
      briefs = [...briefs].sort(
        (a, b) => (briefKey(b) === wanted ? 1 : 0) - (briefKey(a) === wanted ? 1 : 0)
      );
    }
  }

  // Briefs lack set/rarity info — fetch details for the first few.
  const limit = Math.min(opts.pageSize ?? 8, 12);
  const detailed = await Promise.all(
    briefs.slice(0, limit).map((b) => get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(b.id)}`))
  );
  return detailed
    .filter((c): c is TcgdexCard => !!c && !!c.name)
    .map(toSummary);
}
