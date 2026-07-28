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
  attacks?: Array<{ name: string; cost?: string[]; damage?: string; text?: string }>;
  weaknesses?: Array<{ type: string; value: string }>;
  resistances?: Array<{ type: string; value: string }>;
  convertedRetreatCost?: number;
  rules?: string[];
  abilities?: Array<{ name: string; text?: string; type?: string }>;
  legalities?: { standard?: string; expanded?: string };
  regulationMark?: string;
}

/** Card knowledge for referee-mode battles, cached in cards.battle_data.
 *  Pokémon get combat stats; Trainers and Special Energy get their printed
 *  rules text; `fx` is an AI-compiled effect script added lazily. */
export interface CardBattleData {
  attacks: Array<{ name: string; cost: string[]; damage: string; text: string | null }>;
  weak: { type: string; value: string } | null;
  resist: { type: string; value: string } | null;
  retreat: number;
  /** Printed rules text (Trainer / Special Energy / rule-box lines). */
  rules?: string[];
  abilities?: Array<{ name: string; text: string }>;
  /** Evolution stage ("Basic", "Stage 1", …) — sources that don't fill
   *  subtypes (TCGdex, AI-read cards) report it here. */
  stage?: string | null;
  /** HP for sources where the cards row lacks it (AI-read customs). */
  hp?: number | null;
  /** Trainer subtype ("Supporter" / "Item" / "Stadium" / "Tool"). */
  trainerType?: string | null;
  /** Format legality when known (std = Standard, exp = Expanded). */
  legal?: { std?: boolean; exp?: boolean } | null;
  /** AI-compiled effect ops for Trainers (see battles/lib fx compiler). */
  fx?: { ops: Array<{ op: string; n?: number; note?: string }> } | null;
}

function toBattleData(card: RawCard): CardBattleData | null {
  const isPokemon = /pok[eé]mon/i.test(card.supertype ?? "");
  const rules = (card.rules ?? []).map((r) => r.trim()).filter(Boolean);
  const abilities = (card.abilities ?? [])
    .filter((a) => a.name)
    .map((a) => ({ name: a.name, text: a.text?.trim() ?? "" }));
  if (!isPokemon && rules.length === 0) return null;
  return {
    attacks: isPokemon
      ? (card.attacks ?? []).map((a) => ({
          name: a.name,
          cost: a.cost ?? [],
          damage: a.damage ?? "",
          text: a.text?.trim() || null,
        }))
      : [],
    weak: isPokemon ? card.weaknesses?.[0] ?? null : null,
    resist: isPokemon ? card.resistances?.[0] ?? null : null,
    retreat: isPokemon ? card.convertedRetreatCost ?? 0 : 0,
    ...(rules.length > 0 ? { rules } : {}),
    ...(abilities.length > 0 ? { abilities } : {}),
    ...(card.legalities
      ? {
          legal: {
            std: card.legalities.standard === "Legal",
            exp: card.legalities.expanded === "Legal",
          },
        }
      : {}),
  };
}

/** Fetch a Pokémon's combat stats by card id (null for trainers/energy,
 *  unknown ids, or API failures — battles fall back to manual damage). */
export async function getBattleDataById(id: string): Promise<CardBattleData | null> {
  try {
    const cards = await apiGet(`/cards/${encodeURIComponent(id)}`, {});
    return cards[0] ? toBattleData(cards[0]) : null;
  } catch {
    return null;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  const key = (process.env.POKEMONTCG_API_KEY ?? "").trim();
  if (key) h["X-Api-Key"] = key;
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

/** Punctuation-heavy names, keyed by their punctuation-stripped lowercase
 *  form → the exact database spelling. */
const NAME_ALIASES: Record<string, string> = {
  "farfetchd": "Farfetch'd",
  "farfetch d": "Farfetch'd",
  "sirfetchd": "Sirfetch'd",
  "sirfetch d": "Sirfetch'd",
  "mr mime": "Mr. Mime",
  "mr rime": "Mr. Rime",
  "mime jr": "Mime Jr.",
  "ho oh": "Ho-Oh",
  "hooh": "Ho-Oh",
  "porygon z": "Porygon-Z",
  "type null": "Type: Null",
  "jangmo o": "Jangmo-o",
  "hakamo o": "Hakamo-o",
  "kommo o": "Kommo-o",
  "flabebe": "Flabébé",
  "nidoran f": "Nidoran♀",
  "nidoran female": "Nidoran♀",
  "nidoran m": "Nidoran♂",
  "nidoran male": "Nidoran♂",
};

/** Normalize a card name for searching: straighten curly quotes/dashes the
 *  vision model (or a phone keyboard) may produce, collapse whitespace, map
 *  punctuation-stripped spellings to the database's exact form, and restore
 *  the é in "Pokémon …" trainer card names. */
export function cleanCardName(raw: string): string {
  let s = raw
    .normalize("NFC")
    .replace(/[\u2018\u2019\u201B`\u00B4]/g, "'") // curly/backtick apostrophes → '
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-") // en/em dashes → hyphen
    .replace(/\s+/g, " ")
    .trim();
  const key = s
    .toLowerCase()
    .replace(/[.'":\-♀♂!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const alias = NAME_ALIASES[key];
  if (alias) return alias;
  // Alias + suffix, e.g. "mr mime ex" → "Mr. Mime ex" (search is case-insensitive)
  for (const [k, v] of Object.entries(NAME_ALIASES)) {
    if (key.startsWith(k + " ")) return v + key.slice(k.length);
  }
  if (/\bpokemon\b/i.test(s)) s = s.replace(/pokemon/gi, "Pokémon");
  return s;
}

/** The DB is inconsistent about collector numbers: some sets store "95",
 *  others "095", promos use letter prefixes ("SWSH095", "SM210", "TG12").
 *  Generate the plausible spellings so one search catches them all. */
export function numberVariants(n: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };
  const raw = esc(n).trim().replace(/\s+/g, "");
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const hasLetters = /[A-Za-z]/.test(raw);
  if (digits && !hasLetters) {
    // Order matters: the first spelling is the one a single-term retry uses,
    // and plain numbers are stored unpadded upstream. Leading a query with
    // "013" is what made searching a printed "013/223" come up empty while
    // "13/223" worked.
    const stripped = digits.replace(/^0+(?=\d)/, "");
    push(stripped); // "13" — how the database stores it
    push(stripped.padStart(3, "0")); // "013" — how the card prints it
    push(raw.toUpperCase());
  } else {
    push(raw.toUpperCase()); // "SWSH095" — promos really are stored padded
    push(raw.replace(/^0+(?=\d)/, "").toUpperCase());
    if (digits) {
      const stripped = digits.replace(/^0+(?=\d)/, "");
      push(stripped);
      push(stripped.padStart(3, "0"));
    }
  }
  return out;
}

function numberClause(n: string): string | null {
  const variants = numberVariants(n);
  if (variants.length === 0) return null;
  if (variants.length === 1) return `number:${variants[0]}`;
  return `(${variants.map((v) => `number:${v}`).join(" OR ")})`;
}

/** A single-word name goes in unquoted so the trailing wildcard actually
 *  expands. Inside quotes the wildcard is not applied, which turned a search
 *  for a full name like "Rayquaza" into an exact-name match — fewer results
 *  than the truncated "Rayquaz", which found nothing and so fell through to
 *  the broader token search. Names with spaces or punctuation still need the
 *  quoted phrase; the token fallback covers those. */
function nameClause(cleaned: string): string {
  const safe = esc(cleaned);
  if (SIMPLE_WORD.test(safe)) return `name:${safe}*`;
  return `name:"${safe}*"`;
}

const SIMPLE_WORD = /^[A-Za-z0-9À-ɏ]+$/;

/** A contains-match, which a prefix can't do: "pikachu" finds "Surfing
 *  Pikachu" and "sandwich" finds "Herbed Sandwich". Multi-word queries use
 *  their longest word, since a wildcard inside a quoted phrase isn't
 *  expanded. */
function nameContainsClause(cleaned: string): string | null {
  const word = cleaned
    .split(/\s+/)
    .filter((w) => SIMPLE_WORD.test(w))
    .sort((a, b) => b.length - a.length)[0];
  if (!word || word.length < 3) return null;
  return `name:*${esc(word)}*`;
}

/** Digits-only, zero-stripped comparison key: "SWSH095" → "95". */
export function numberKey(n: string | null | undefined): string {
  return (n ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

/** Search cards by (partial) name and/or collector number / set size.
 *  `nameTokens` matches on word-parts only (punctuation-blind) — use as a
 *  fallback when the exact name phrase finds nothing. */
export async function searchCards(opts: {
  name?: string;
  nameTokens?: string;
  /** Match the name anywhere, not just at the start. */
  nameContains?: string;
  number?: string;
  /** Exactly this collector number, with no spelling expansion — used to
   *  retry one spelling at a time. */
  numberExact?: string;
  printedTotal?: string;
  setName?: string;
  pageSize?: number;
}): Promise<CardSummary[]> {
  const clauses: string[] = [];
  if (opts.name) clauses.push(nameClause(cleanCardName(opts.name)));
  if (opts.nameContains) {
    const clause = nameContainsClause(cleanCardName(opts.nameContains));
    if (clause) clauses.push(clause);
    else return [];
  }
  if (opts.nameTokens) {
    const tokens = cleanCardName(opts.nameTokens)
      .toLowerCase()
      .split(/[^a-z0-9é]+/i)
      .filter((t) => t.length >= 2);
    for (const t of tokens) clauses.push(`name:${esc(t)}*`);
  }
  if (opts.numberExact) {
    clauses.push(`number:${esc(opts.numberExact)}`);
  } else if (opts.number) {
    const clause = numberClause(opts.number);
    if (clause) clauses.push(clause);
  }
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
  // Pass 3: punctuation-blind word matching (handles apostrophes, periods,
  // hyphens, é — "Farfetch'd", "Mr. Mime", "Ho-Oh", "Pokémon Catcher")
  if (candidates.length === 0 && detected.name) {
    try {
      candidates = await searchCards({
        nameTokens: detected.name,
        number: detected.collectorNumber ?? undefined,
        pageSize: 12,
      });
    } catch {
      candidates = [];
    }
    if (candidates.length === 0) {
      try {
        candidates = await searchCards({ nameTokens: detected.name, pageSize: 12 });
      } catch {
        candidates = [];
      }
    }
  }

  if (candidates.length === 0) return { match: null, candidates: [] };

  // Score: number match (exact beats digits-only), printed-total match,
  // and set hints. Digits-only comparison bridges promo prefixes and
  // leading zeros ("SWSH095" vs "095" vs "95").
  const exact = (n: string | null) => (n ?? "").replace(/^0+(?=\d)/, "").toLowerCase();
  const scored = candidates.map((c) => {
    let score = 0;
    if (detected.collectorNumber) {
      if (exact(c.number) === exact(detected.collectorNumber)) score += 4;
      else if (numberKey(c.number) && numberKey(c.number) === numberKey(detected.collectorNumber))
        score += 3;
    }
    if (detected.setTotal) {
      if (/\d/.test(detected.setTotal)) {
        // Numeric total: compare against the set's printed size
        if (
          c.setPrintedTotal != null &&
          String(c.setPrintedTotal) === numberKey(detected.setTotal)
        )
          score += 3;
      } else {
        // Letters-only "total" (e.g. 095/SVP) is a promo-set code
        const code = detected.setTotal.toLowerCase();
        if (c.setName.toLowerCase().includes(code) || c.setId.toLowerCase().includes(code))
          score += 3;
      }
    }
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
