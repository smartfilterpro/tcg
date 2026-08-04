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

/* ------------------------------------------------------- request handling */

// Worth another go. 5xx is pokemontcg.io failing on its own side, 429 is
// quota, and the timeouts are load. None of them say the request was wrong.
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Interactive callers — a scan waiting on a card lookup. Few tries, short
 *  waits: somebody is watching a spinner. */
const ATTEMPTS = 3;
/** The bulk import. Nobody is waiting on any single page, and giving an
 *  overloaded server twenty seconds to recover beats losing the run. */
export const IMPORT_ATTEMPTS = 5;

/** Say what actually happened.
 *
 *  The old message was `pokemontcg.io 500:` and nothing else — the body was
 *  empty, so the interesting half of the string was blank and the reader was
 *  left with a bare number. A 500 with no body is a specific, diagnosable
 *  thing: their servers fell over, our request was fine, and trying again
 *  later is the entire remedy. Say that instead of implying a mistake. */
function describeFailure(status: number, body: string, url: string): string {
  const target = `${new URL(url).pathname}${new URL(url).search}`;
  const detail = body.trim() ? body.trim().slice(0, 300) : "empty response body";
  const nature =
    status >= 500
      ? "pokemontcg.io's own servers failed — nothing is wrong with the request, and it usually clears on its own"
      : status === 429
        ? "rate limited"
        : "the request was rejected";
  const key = (process.env.POKEMONTCG_API_KEY ?? "").trim()
    ? "An API key is configured."
    : "No POKEMONTCG_API_KEY is set — unauthenticated callers get a much smaller quota.";
  return `pokemontcg.io ${status} on ${target} (${detail}). ${nature}. ${key}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET and parse, retrying the failures that are worth retrying.
 *
 *  The catalogue import fetches ~80 pages in a row. Without this, a single
 *  blip anywhere in that sequence ends the run — which is exactly what
 *  happened: one 500 on page 1 and the whole import wrote nothing. */
async function apiFetchJson(
  url: string,
  attempts = ATTEMPTS
): Promise<Record<string, unknown>> {
  let last = "pokemontcg.io could not be reached";
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 4s, 8s, capped — with jitter so a burst of failures doesn't
      // reconverge into a synchronised thundering retry. Two seconds of
      // total patience (the old schedule) is nothing to a server that is
      // still coming back up.
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const jittered = backoff * (0.75 + Math.random() * 0.5);
      // If they told us how long to wait, believe them over our own guess.
      await sleep(Math.max(jittered, retryAfterMs));
      retryAfterMs = 0;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: headers(),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      last = `pokemontcg.io network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (res.ok) return (await res.json()) as Record<string, unknown>;

    // Honoured for 429 and 503 alike — it's the server telling us when it
    // will be ready, which is better information than any backoff curve.
    const after = Number(res.headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) retryAfterMs = Math.min(after * 1000, 30_000);

    last = describeFailure(res.status, await res.text().catch(() => ""), url);
    // A 400 or a 404 will say the same thing every time.
    if (!RETRYABLE.has(res.status)) break;
  }
  throw new Error(`${last} (${attempts} attempts)`);
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
  const json = (await apiFetchJson(url.toString())) as { data: RawCard | RawCard[] };
  return Array.isArray(json.data) ? json.data : [json.data];
}

/** Escape values used inside a Lucene-style query. */
function esc(v: string): string {
  return v.replace(/["\\]/g, "");
}

/** A set-name clause the search engine will actually expand.
 *
 *  This used to be `set.name:"<name>*"` — a quoted phrase with a trailing
 *  wildcard. Lucene does not expand wildcards inside quotes: the asterisk is
 *  matched as a literal character, so the clause looked for a set whose name
 *  ends in "*" and found nothing, every time. A search for "trick or trade"
 *  therefore never reached "Trick or Trade BOOster Bundle 2024" and the whole
 *  external half of a set listing silently returned empty.
 *
 *  Unquoted, one wildcard term per word, ANDed by the engine's default. That
 *  matches any set carrying all of the words — which is what somebody typing
 *  part of a set name means — and it still works for the one-word promo codes
 *  ("SVP") this was originally written for. */
export function setNameClause(setName: string): string {
  const tokens = esc(setName)
    .toLowerCase()
    .split(/[^a-z0-9é]+/i)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return `set.name:${esc(setName)}*`;
  return tokens.map((t) => `set.name:${t}*`).join(" ");
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
  if (opts.setName) clauses.push(setNameClause(opts.setName));
  if (clauses.length === 0) return [];
  const cards = await apiGet("/cards", {
    q: clauses.join(" "),
    pageSize: String(opts.pageSize ?? 12),
    orderBy: "-set.releaseDate",
  });
  return cards.map(toSummary);
}

/** One page of the entire catalogue, for the bulk import.
 *
 *  No query at all — every card, ordered by id so the paging is stable. An
 *  unstable order (release date, say) would let a card slip between pages as
 *  new sets land, and the import would silently miss it. `totalCount` comes
 *  from the response envelope, which is the only way to know how far there
 *  is to go. */
export async function searchAllCardsPage(
  page: number,
  pageSize: number
): Promise<{ cards: CardSummary[]; totalCount: number | null }> {
  const url = new URL(`${BASE}/cards`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("orderBy", "id");
  const json = (await apiFetchJson(url.toString(), IMPORT_ATTEMPTS)) as {
    data?: RawCard[];
    totalCount?: number;
  };
  return {
    cards: (json.data ?? []).map(toSummary),
    totalCount: typeof json.totalCount === "number" ? json.totalCount : null,
  };
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
