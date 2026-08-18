// Fallback card lookup via TCGdex (https://tcgdex.dev) — a second free,
// community-maintained card database. It typically gets brand-new sets and
// promos months before pokemontcg.io, so we consult it whenever the primary
// database returns nothing. Pricing data is spottier, so prices may be null.
import type { CardSummary } from "./types";
import { setsAgree } from "./setName";

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
  evolveFrom?: string; // the printed "Evolves from" line
  trainerType?: string; // "Supporter" | "Item" | "Stadium" | "Tool" | ...
  energyType?: string; // "Basic" | "Special"
  effect?: string; // Trainer / Special Energy rules text
  retreat?: number;
  attacks?: Array<{ cost?: string[]; name: string; effect?: string; damage?: number | string }>;
  abilities?: Array<{ type?: string; name: string; effect?: string }>;
  legal?: { standard?: boolean; expanded?: boolean };
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

/** How long to wait on TCGdex before giving up on it.
 *
 *  It is a free service consulted as a fallback, never the thing the answer
 *  depends on — so ten seconds is generous. Without a limit a single hung
 *  connection held a scan open for as long as the platform allowed, and a
 *  card lookup that returns nothing after ten seconds is worth exactly as
 *  much as one that returns nothing after five minutes. */
const TCGDEX_TIMEOUT_MS = 10_000;

async function get<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TCGDEX_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** TCGdex's finish names → the keys the rest of the app prices by.
 *
 *  Those keys are pokemontcg.io's, because that is where the price map
 *  originally came from and availableVariants/priceForVariant read them
 *  directly. TCGdex hyphenates where pokemontcg.io camel-cases, which is the
 *  whole of the difference. */
const TCGDEX_FINISHES: Record<string, string> = {
  normal: "normal",
  holofoil: "holofoil",
  "reverse-holofoil": "reverseHolofoil",
  "1st-edition": "1stEditionNormal",
  "1st-edition-holofoil": "1stEditionHolofoil",
  unlimited: "unlimitedNormal",
  "unlimited-holofoil": "unlimitedHolofoil",
};

/** Which finish to quote as the card's headline price, best first. Matches
 *  the order pokemontcg.io's extractor uses, so a card doesn't change its
 *  headline finish depending on which source happened to price it. */
const HEADLINE_ORDER = [
  "holofoil",
  "normal",
  "reverseHolofoil",
  "1stEditionHolofoil",
  "1stEditionNormal",
  "unlimitedHolofoil",
  "unlimitedNormal",
];

function usable(v: unknown): number | null {
  return typeof v === "number" && v > 0 ? v : null;
}

/** Every finish TCGdex prices, and the one to show as the headline.
 *
 *  This used to return a single number, picked by taking the FIRST TCGplayer
 *  variant the object happened to iterate — so a card owned in two finishes
 *  got one price for both, and which finish it belonged to was luck. TCGdex
 *  publishes the whole per-finish block; reading it is free and it is the
 *  same TCGplayer data the rest of the app prices in.
 *
 *  TCGPLAYER ONLY. Cardmarket is the European marketplace and quotes EUR;
 *  this app prints "$" everywhere and totals collections in dollars. It was
 *  read first, then demoted to a last resort, and is now not read at all: a
 *  euro figure in a dollar field is not an approximation, it is a wrong
 *  number wearing the right symbol. No price is the honest answer, and the
 *  app already shows that honestly. */
export function tcgdexPrices(pricing: Record<string, unknown> | undefined): {
  market: number | null;
  prices: Record<string, number | null> | null;
} {
  if (!pricing) return { market: null, prices: null };

  const tp = pricing.tcgplayer as Record<string, unknown> | undefined;
  const prices: Record<string, number | null> = {};
  if (tp) {
    for (const [theirs, ours] of Object.entries(TCGDEX_FINISHES)) {
      const block = tp[theirs] as Record<string, unknown> | undefined;
      if (!block || typeof block !== "object") continue;
      // Same preference the pokemontcg.io extractor uses: the market price
      // when there is one, then the midpoint, then the low. A finish that
      // exists but is unpriced is left out rather than stored as null —
      // otherwise it would advertise a finish nobody can value.
      const value =
        usable(block.marketPrice) ?? usable(block.midPrice) ?? usable(block.lowPrice);
      if (value != null) prices[ours] = value;
    }
  }

  for (const key of HEADLINE_ORDER) {
    const v = prices[key];
    if (v != null) {
      return { market: v, prices: Object.keys(prices).length ? prices : null };
    }
  }

  // NOTHING FROM CARDMARKET. It was the last resort here, on the reasoning
  // that a roughly right number beats none for a print no US marketplace
  // lists. That reasoning was wrong: Cardmarket quotes EUROS, the app prints
  // "$" everywhere and adds collections up in dollars, so what it bought was
  // not a rough number — it was a wrong number wearing the right symbol, and
  // silently wrong at whatever today's exchange rate is.
  //
  // A blank price says "we don't know", which is true and which the app
  // already displays honestly. Converting would need a live FX rate and a
  // label; until there is a reason to build that, no price is the accurate
  // answer.
  return { market: null, prices: null };
}

/** Headline price only, for callers that don't store a per-finish map. */
function extractTcgdexPrice(pricing: Record<string, unknown> | undefined): number | null {
  return tcgdexPrices(pricing).market;
}

function toSummary(card: TcgdexCard): CardSummary {
  // The whole pricing block, not just the headline. tcgdexPrices already
  // maps every finish TCGdex publishes onto the keys the app prices by; this
  // was calling the headline-only helper and then hard-coding prices: null
  // beside a comment saying TCGdex has no per-finish data. It does — that
  // comment predated the extractor and outlived the fact.
  const { market: price, prices } = tcgdexPrices(card.pricing);
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
    prices,
    // And what the card DOES, from the record already in hand. Every TCGdex
    // detail response carries attacks, abilities, effect text, weakness,
    // resistance, retreat, stage and legality; keeping them here means the
    // card arrives complete instead of being fetched again later for the
    // half that was thrown away.
    battleData: tcgdexBattleData(card),
  };
}

/** Refresh pricing for a card we stored from TCGdex ("tcgdex-" id prefix). */
export async function getTcgdexPriceById(prefixedId: string): Promise<number | null> {
  return (await getTcgdexPricesById(prefixedId)).market;
}

/** The same lookup, keeping the per-finish map instead of discarding it.
 *
 *  One request either way — the pricing block arrives with the card whether
 *  anyone reads it or not. */
export async function getTcgdexPricesById(prefixedId: string): Promise<{
  market: number | null;
  prices: Record<string, number | null> | null;
}> {
  const id = prefixedId.replace(/^tcgdex-/, "");
  const card = await get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
  return card ? tcgdexPrices(card.pricing) : { market: null, prices: null };
}

/** Image URLs for a TCGdex-sourced card ("tcgdex-" id prefix).
 *
 *  Worth asking for even when the card was stored without a picture: search
 *  results come back as briefs, and only the first few get their details
 *  fetched, so plenty of cards are saved image-less while TCGdex has one all
 *  along. Cheaper and far more reliable than sending an AI to search the web
 *  for a picture the source database already holds. */
export async function getTcgdexImageById(
  prefixedId: string
): Promise<{ small: string; large: string } | null> {
  const id = prefixedId.replace(/^tcgdex-/, "");
  const card = await get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
  if (!card?.image) return null;
  return { small: `${card.image}/low.webp`, large: `${card.image}/high.webp` };
}

/** Combat/battle data for a TCGdex-sourced card ("tcgdex-" id prefix) —
 *  same shape the primary database produces, so referee-mode attack
 *  buttons, HP, stages, and card text work for new-set cards too. */
/** A TCGdex card record, converted to the shape the app stores.
 *
 *  Split out of getTcgdexBattleDataById so toSummary can use it on a record
 *  it ALREADY HOLDS. Every TCGdex card detail carries the card's attacks,
 *  abilities, effect text, weakness, resistance, retreat, stage and format
 *  legality — and toSummary was keeping the name, the number and the picture
 *  and dropping the rest, so anything that wanted the text fetched the same
 *  card a second time to get what the first response had already delivered.
 *  Same mistake the pokemontcg.io path was making, in the other client. */
export function tcgdexBattleData(
  card: TcgdexCard
): import("./pokemontcg").CardBattleData | null {
  if (!card.name) return null;
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
    ...(card.evolveFrom?.trim() ? { evolvesFrom: card.evolveFrom.trim() } : {}),
    hp: Number.isFinite(hpNum) && hpNum > 0 ? hpNum : null,
    trainerType: card.trainerType ?? null,
    ...(card.legal ? { legal: { std: card.legal.standard === true, exp: card.legal.expanded === true } } : {}),
  };
}

/** The same conversion, for a card we hold only by id. */
export async function getTcgdexBattleDataById(
  prefixedId: string
): Promise<import("./pokemontcg").CardBattleData | null> {
  const id = prefixedId.replace(/^tcgdex-/, "");
  const card = await get<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
  return card ? tcgdexBattleData(card) : null;
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

/** Every card in a set, found by (part of) the set's name.
 *
 *  The reason this exists: TCGdex carries promo products — Trick or Trade
 *  bundles, blisters, tins — months before pokemontcg.io catalogues them,
 *  and those are exactly the sets somebody types a set name to enter. The
 *  card search here can only filter by name and number, so a set listing had
 *  no way to reach TCGdex at all and fell back on whichever sources happened
 *  to have imported the set already.
 *
 *  Two requests: find the set, then fetch it whole. The set endpoint returns
 *  its full card list, so there is no paging to get wrong. */
export async function tcgdexSetCards(setName: string): Promise<CardSummary[]> {
  const wanted = setName.trim().toLowerCase();
  if (!wanted) return [];

  const sets = await get<Array<{ id: string; name?: string }>>(`${BASE}/sets`);
  if (!Array.isArray(sets)) return [];
  // Every set whose name contains what was typed. More than one is normal —
  // "trick or trade" matches the 2022, 2023 and 2024 bundles — and showing
  // all of them beats guessing which year somebody meant.
  const matches = sets
    .filter((s) => (s.name ?? "").toLowerCase().includes(wanted))
    .slice(0, 4);
  if (matches.length === 0) return [];

  const detailed = await Promise.all(
    matches.map((s) =>
      get<{ cards?: TcgdexBrief[]; name?: string }>(`${BASE}/sets/${encodeURIComponent(s.id)}`)
    )
  );

  // The set endpoint's card list is brief — id, localId, name, image — which
  // is everything a picker row needs. Fetching full detail for a 90-card set
  // would be 90 requests against a free service for data nobody has asked to
  // see yet, so the brief is mapped directly and the detail arrives when the
  // card is actually added.
  const out: CardSummary[] = [];
  for (let i = 0; i < detailed.length; i++) {
    const set = detailed[i];
    if (!set?.cards) continue;
    for (const c of set.cards) {
      out.push({
        id: `tcgdex-${c.id}`,
        name: c.name,
        supertype: null,
        subtypes: [],
        types: [],
        hp: null,
        number: String(c.localId ?? ""),
        rarity: null,
        setId: `tcgdex-${matches[i].id}`,
        setName: set.name ?? matches[i].name ?? setName,
        setSeries: null,
        setPrintedTotal: null,
        releaseDate: null,
        imageSmall: c.image ? `${c.image}/low.webp` : null,
        imageLarge: c.image ? `${c.image}/high.webp` : null,
        marketPrice: null,
        prices: null,
      });
    }
  }
  return out;
}

/** Artwork for a card we know by name and number rather than by TCGdex id.
 *
 *  The by-id lookup only helps cards that CAME from TCGdex. Most imageless
 *  cards came from somewhere else — a promo pokemontcg.io never scanned, a
 *  set that arrived early — and for those the only way in is a search.
 *  Free, so it belongs ahead of the paid tracker in any gap-filling chain.
 */
export async function findTcgdexImage(query: {
  name: string;
  number?: string | null;
  /** The set OUR card is in. Required in practice — see below. */
  setName?: string | null;
}): Promise<string | null> {
  try {
    const hits = await searchTcgdex({
      name: query.name,
      number: query.number ?? undefined,
      pageSize: 8,
    });
    // Prefer a hit whose number matches; a name-only match on a card with
    // dozens of printings is a coin flip, and the wrong art is worse than
    // none because nobody looks at it again.
    const key = (n: string | null | undefined) =>
      (n ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    const wanted = key(query.number);
    const byNumber = wanted ? hits.filter((c) => key(c.number) === wanted) : [];

    // AND THE SET, because a name and a number are not a card.
    //
    // A promo bundle reprints a card at its ORIGINAL collector number, so
    // "Haunter #103" is a Temporal Forces card AND a Trick or Trade card,
    // and this function's answer is written straight into image_small. It
    // picked whichever the search ranked first. The result is a card in your
    // binder showing a picture of a different printing — which then looks
    // like a scanning bug, or a wrong card, and is neither.
    //
    // With no set to check against there is nothing to verify a widened
    // match with, so the number match stands alone exactly as before; every
    // caller in the app passes one.
    const wantedSet = query.setName?.trim();
    // With a number, only cards carrying it are candidates; without one,
    // everything is, and the set is then the only thing doing the work.
    const pool = wanted ? byNumber : hits;
    const pick = wantedSet
      ? pool.find((c) => setsAgree(c.setName, wantedSet))
      : (wanted ? byNumber[0] : hits[0]);

    // Said out loud when the set is the ONLY reason a picture was refused.
    //
    // This guard trades coverage for correctness, and the coverage it costs
    // is otherwise invisible: a card simply stays without art and looks like
    // a card TCGdex doesn't carry. If these lines start naming sets that are
    // plainly the same set written two ways, the rule needs widening rather
    // than the cards needing pictures.
    if (!pick && wantedSet && pool.length > 0) {
      console.log(
        `tcgdex art: "${query.name}" #${query.number ?? "?"} — ${pool.length} number match(es), ` +
          `none from "${wantedSet}" (theirs: ${[...new Set(pool.map((c) => c.setName ?? "?"))]
            .slice(0, 4)
            .join(", ")}). No picture taken.`
      );
    }
    return pick?.imageLarge ?? pick?.imageSmall ?? null;
  } catch {
    return null;
  }
}
