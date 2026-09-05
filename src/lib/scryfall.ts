// Scryfall — the card database for the Magic: The Gathering half of the app.
//
// One source where the Pokémon side needs four. Scryfall is free, keyless,
// and carries everything in one place: every printing ever made, oracle
// text, images we're allowed to mirror, daily USD prices per finish, and —
// the part that makes buy links work on day one — the TCGplayer product id
// for nearly every card. There is no paid tier and no deck-rules endpoint
// to apply for; the only ask is a descriptive User-Agent and gentle pacing.
//
// Identity scheme: our card ids are "scry-<scryfall uuid>", set ids are
// "mtg-<setcode>". Both prefixes exist so MTG rows can never collide with
// the three Pokémon id schemes already sharing the cards table.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  rowToSummary,
  summaryToRow,
  canonicalRarity,
  CARD_SUMMARY_COLUMNS,
  type CardSummary,
  type CardSummaryRow,
  type DetectedCard,
} from "@/lib/types";
import { normalizeForSearch } from "@/lib/text";

const BASE = "https://api.scryfall.com";
const TIMEOUT_MS = 8_000;
// Scryfall asks for 50-100ms between requests. Our volume is a handful of
// calls per scan, so a simple gap between consecutive calls is plenty.
const PACE_MS = 80;

let lastCallAt = 0;
async function pace(): Promise<void> {
  const wait = lastCallAt + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** GET a Scryfall endpoint. 404 is an answer ("no such card"), not an
 *  error — everything else throws so callers' fallbacks engage. */
async function scryGet(path: string): Promise<Record<string, unknown> | null> {
  await pace();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/json",
      // Scryfall's API guidelines require identifying yourself.
      "User-Agent": "TCGdeck/1.0",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall ${res.status} for ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

async function scryPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  await pace();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "TCGdeck/1.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Scryfall ${res.status} for ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

/** The slice of a Scryfall card object we read. Double-faced cards carry
 *  their images (and often their types) per face; the front face speaks
 *  for the card. */
interface ScryCard {
  id: string;
  name: string;
  set: string; // set code, e.g. "mh3"
  set_name: string;
  collector_number: string;
  rarity: string; // common | uncommon | rare | mythic | special | bonus
  released_at?: string;
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  legalities?: Record<string, string>; // "legal" | "not_legal" | "banned" | "restricted"
  image_uris?: { small?: string; normal?: string; large?: string };
  card_faces?: Array<{
    name?: string;
    type_line?: string;
    oracle_text?: string;
    mana_cost?: string;
    power?: string;
    toughness?: string;
    colors?: string[];
    image_uris?: { small?: string; normal?: string; large?: string };
  }>;
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  finishes?: string[]; // nonfoil | foil | etched
  tcgplayer_id?: number;
  digital?: boolean;
}

/** How a Magic card plays, stored in cards.battle_data — the same column
 *  the Pokémon reader fills, wearing a different shape.
 *
 *  `rules` is deliberately the one field shared with the Pokémon shape:
 *  the card-details endpoint and the card sheet render bd.rules verbatim,
 *  so putting the type line, mana cost, oracle text and P/T there makes
 *  every existing text panel show real Magic card text with no renderer
 *  changes. The structured fields alongside are what the deck builder and
 *  coach read. Scryfall's oracle data is authoritative — no AI read, ever. */
export interface MtgBattleData {
  game: "mtg";
  rules: string[];
  type_line: string | null;
  mana_cost: string | null;
  colors: string[];
  color_identity: string[];
  power: string | null;
  toughness: string | null;
  keywords: string[];
  legalities: Record<string, string>;
}

export function mtgBattleDataOf(c: ScryCard): MtgBattleData {
  const faces = c.card_faces?.length ? c.card_faces : [c];
  const rules: string[] = [];
  for (const f of faces) {
    const head = [
      faces.length > 1 && "name" in f && f.name ? f.name : null,
      f.mana_cost || null,
      f.type_line ?? null,
      f.power != null && f.toughness != null ? `${f.power}/${f.toughness}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (head) rules.push(head);
    if (f.oracle_text) rules.push(f.oracle_text);
  }
  const front = faces[0];
  return {
    game: "mtg",
    rules,
    type_line: c.type_line ?? front.type_line ?? null,
    mana_cost: c.mana_cost ?? front.mana_cost ?? null,
    colors: c.colors ?? front.colors ?? [],
    color_identity: c.color_identity ?? [],
    power: c.power ?? front.power ?? null,
    toughness: c.toughness ?? front.toughness ?? null,
    keywords: c.keywords ?? [],
    legalities: c.legalities ?? {},
  };
}

const COLOR_NAMES: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
};

function toNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Scryfall card → our shared CardSummary shape.
 *
 *  The mapping bends MTG onto the Pokémon-shaped columns deliberately —
 *  supertype holds the primary card type ("Creature", "Instant"), subtypes
 *  the words after the em-dash ("Goblin Wizard"), types the color names —
 *  because every list, filter and value calculation in the app reads those
 *  columns, and this way they all work unmodified. */
export function scryToSummary(c: ScryCard): CardSummary {
  const face = c.card_faces?.[0];
  const typeLine = c.type_line ?? face?.type_line ?? "";
  // "Legendary Creature — Goblin Wizard" → super "Creature", subs ["Goblin","Wizard"]
  const [left, right] = typeLine.split("—").map((s) => s.trim());
  const leftWords = (left ?? "").split(/\s+/).filter(Boolean);
  // The card type is the last non-supertype word run; keep it simple: drop
  // known supertype modifiers and join what's left ("Artifact Creature").
  const MODIFIERS = new Set(["Legendary", "Basic", "Snow", "World", "Ongoing", "Token"]);
  const core = leftWords.filter((w) => !MODIFIERS.has(w));
  const supertype = core.length > 0 ? core.join(" ") : left || null;

  const colors = (c.colors ?? face?.colors ?? []).map((x) => COLOR_NAMES[x] ?? x);
  const images = c.image_uris ?? face?.image_uris ?? {};

  const prices: Record<string, number | null> = {};
  const finishes = new Set(c.finishes ?? []);
  const usd = toNumber(c.prices?.usd);
  const usdFoil = toNumber(c.prices?.usd_foil);
  const usdEtched = toNumber(c.prices?.usd_etched);
  if (finishes.has("nonfoil") || usd != null) prices.normal = usd;
  if (finishes.has("foil") || usdFoil != null) prices.foil = usdFoil;
  if (finishes.has("etched") || usdEtched != null) prices.etched = usdEtched;

  return {
    id: `scry-${c.id}`,
    game: "mtg",
    name: c.name,
    supertype,
    subtypes: right ? right.split(/\s+/).filter(Boolean) : [],
    types: colors,
    hp: null,
    number: c.collector_number,
    rarity: canonicalRarity(c.rarity),
    setId: `mtg-${c.set}`,
    setName: c.set_name,
    setSeries: null,
    setPrintedTotal: null,
    releaseDate: c.released_at ?? null,
    imageSmall: images.small ?? images.normal ?? null,
    // large (672px) over normal (488px): this is what the zoom shows on a
    // desktop, where 488 source pixels behind a ~480px card reads soft on
    // any HiDPI screen.
    imageLarge: images.large ?? images.normal ?? images.small ?? null,
    marketPrice: usd ?? usdFoil ?? usdEtched ?? null,
    prices: Object.keys(prices).length > 0 ? prices : null,
    tcgplayerId: c.tcgplayer_id ?? null,
    battleData: mtgBattleDataOf(c),
  };
}

/** One card's play data, fetched fresh from Scryfall and written to the
 *  catalogue. The ensureCardText ladder calls this for scry- ids — Magic's
 *  entire "read the card" step is one free API call. */
export async function fetchScryBattleData(
  admin: SupabaseClient,
  cardId: string
): Promise<MtgBattleData | null> {
  if (!cardId.startsWith("scry-")) return null;
  try {
    const raw = await scryGet(`/cards/${cardId.slice("scry-".length)}`);
    if (!raw) return null;
    const bd = mtgBattleDataOf(raw as unknown as ScryCard);
    await admin.from("cards").update({ battle_data: bd }).eq("id", cardId).then(() => {});
    return bd;
  } catch {
    return null;
  }
}

/** Fill battle_data for every listed MTG card that lacks it, in Scryfall's
 *  75-id batches. Returns the play data by card id (present rows included),
 *  so the deck builder can warm a whole collection in a couple of calls. */
export async function ensureMtgBattleData(
  admin: SupabaseClient,
  ids: string[]
): Promise<Map<string, MtgBattleData>> {
  const out = new Map<string, MtgBattleData>();
  const scryIds = [...new Set(ids.filter((id) => id.startsWith("scry-")))];
  if (scryIds.length === 0) return out;

  let missing: string[] = scryIds;
  try {
    const { data } = await admin
      .from("cards")
      .select("id, battle_data")
      .in("id", scryIds.slice(0, 1000));
    const held = (data ?? []) as Array<{ id: string; battle_data: MtgBattleData | null }>;
    for (const row of held) {
      if (row.battle_data && (row.battle_data as { game?: string }).game === "mtg") {
        out.set(row.id, row.battle_data);
      }
    }
    missing = scryIds.filter((id) => !out.has(id));
  } catch {
    // battle_data column predates every MTG row; a read failure just means
    // everything fetches fresh below.
  }

  for (let i = 0; i < missing.length; i += 75) {
    const chunk = missing.slice(i, i + 75);
    try {
      const res = await scryPost("/cards/collection", {
        identifiers: chunk.map((id) => ({ id: id.slice("scry-".length) })),
      });
      const found = (res?.data as ScryCard[] | undefined) ?? [];
      for (const c of found) {
        const bd = mtgBattleDataOf(c);
        out.set(`scry-${c.id}`, bd);
        await admin
          .from("cards")
          .update({ battle_data: bd })
          .eq("id", `scry-${c.id}`)
          .then(() => {});
      }
    } catch (err) {
      console.warn("mtg battle data: batch failed", err);
    }
  }
  return out;
}

/** MTG collector numbers compare after leading zeros go: "0123" is "123".
 *  Letters stay — "123a" and promo stars are identity, exactly as on the
 *  Pokémon side. */
export function mtgNumberKey(n: string | null | undefined): string {
  return (n ?? "")
    .split("/")[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^0+(?=\d)/, "");
}

/** Does a detected set hint match this card's set? The scanner reports the
 *  printed set CODE (bottom-left, "MH3"), but people typing in the picker
 *  may use the set's name — accept either. */
function mtgSetAgrees(card: CardSummary, hint: string | null | undefined): boolean {
  const h = (hint ?? "").trim().toLowerCase();
  if (!h) return true;
  const code = card.setId.replace(/^mtg-/, "").toLowerCase();
  if (h === code) return true;
  const name = normalizeForSearch(card.setName);
  return name === normalizeForSearch(h) || name.includes(normalizeForSearch(h));
}

/** Our own catalogue first — every MTG card anyone saved is a local row,
 *  so repeat scans of the same binder never leave the building. */
export async function matchMtgLocal(
  supabase: SupabaseClient,
  detected: DetectedCard
): Promise<CardSummary | null> {
  if (!detected.name) return null;
  const wanted = normalizeForSearch(detected.name);
  if (!wanted) return null;
  try {
    const { data, error } = await supabase
      .from("cards")
      .select(CARD_SUMMARY_COLUMNS)
      .eq("game", "mtg")
      .like("name_key", `${wanted}%`)
      .order("name_key")
      .order("id")
      .limit(60);
    if (error) throw error;
    const rows = (data ?? []) as unknown as CardSummaryRow[];
    // Exact name, or the front face of a double-faced card ("Fable of the
    // Mirror-Breaker // Reflection of Kiki-Jiki" answers for its front).
    const all = rows
      .map(rowToSummary)
      .filter((r) => {
        const n = normalizeForSearch(r.name);
        return n === wanted || n.startsWith(`${wanted} `);
      });
    if (all.length === 0) return null;

    const key = mtgNumberKey(detected.collectorNumber);
    let hits = key ? all.filter((r) => mtgNumberKey(r.number) === key) : all;
    if (hits.length === 0) hits = all;
    const withSet = hits.filter((r) => mtgSetAgrees(r, detected.setNameHint));
    if (withSet.length > 0) hits = withSet;

    // Unambiguous only: one candidate, or one exact number+set winner.
    if (hits.length === 1) return hits[0];
    if (key && detected.setNameHint && hits.length > 1) return hits[0];
    return null;
  } catch (err) {
    // Pre-072 database (no game column) or any other hiccup: external path.
    console.warn(`scan: local MTG match failed for "${detected.name}"`, err);
    return null;
  }
}

/** Scryfall lookup for a scanned card: set code + collector number is
 *  exact; otherwise a fuzzy name resolve, then that card's printings to
 *  find the one matching what the photo showed. */
export async function matchMtgCard(
  detected: DetectedCard
): Promise<{ match: CardSummary | null; candidates: CardSummary[] }> {
  const code = (detected.setNameHint ?? "").trim().toLowerCase();
  const num = (detected.collectorNumber ?? "").trim().toLowerCase();

  // Exact printing: /cards/{set}/{number}. Only worth trying with a short
  // code (set NAMES 404 here and cost a round trip).
  if (/^[a-z0-9]{3,5}$/.test(code) && num) {
    try {
      const exact = await scryGet(`/cards/${code}/${encodeURIComponent(num)}`);
      if (exact) {
        const summary = scryToSummary(exact as unknown as ScryCard);
        return { match: summary, candidates: [summary] };
      }
    } catch {
      // fall through to the name path
    }
  }

  if (!detected.name) return { match: null, candidates: [] };
  let named: Record<string, unknown> | null = null;
  try {
    named = await scryGet(`/cards/named?fuzzy=${encodeURIComponent(detected.name)}`);
  } catch {
    return { match: null, candidates: [] };
  }
  if (!named) return { match: null, candidates: [] };

  const canonical = scryToSummary(named as unknown as ScryCard);
  // Printings, newest first, so the candidate list shows the versions a
  // person is most likely holding.
  let prints: CardSummary[] = [canonical];
  try {
    const uri = named.prints_search_uri as string | undefined;
    if (uri) {
      const url = new URL(uri);
      const listing = await scryGet(`${url.pathname}${url.search}`);
      const cards = (listing?.data as ScryCard[] | undefined) ?? [];
      const mapped = cards.filter((c) => !c.digital).slice(0, 12).map(scryToSummary);
      if (mapped.length > 0) prints = mapped;
    }
  } catch {
    // canonical alone is still an answer
  }

  const key = mtgNumberKey(detected.collectorNumber);
  const rank = (c: CardSummary) =>
    (key && mtgNumberKey(c.number) === key ? 0 : 2) +
    (detected.setNameHint && mtgSetAgrees(c, detected.setNameHint) ? 0 : 1);
  const sorted = [...prints].sort((a, b) => rank(a) - rank(b));
  return { match: sorted[0] ?? null, candidates: sorted };
}

/** Resolve many card names at once — Scryfall's collection endpoint takes
 *  75 identifiers per request, so a whole decklist is one or two calls
 *  instead of a rate-limited crawl. Resolved cards are stashed into the
 *  catalogue (insert-only; the price loop owns them from there) and come
 *  back keyed by normalizeForSearch of the full name AND the front face,
 *  so "Fable of the Mirror-Breaker" finds its // card. */
export async function resolveMtgNames(
  admin: SupabaseClient,
  names: string[]
): Promise<Map<string, CardSummary>> {
  const out = new Map<string, CardSummary>();
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 75) {
    const res = await scryPost("/cards/collection", {
      identifiers: uniq.slice(i, i + 75).map((name) => ({ name })),
    });
    const found = ((res?.data as ScryCard[] | undefined) ?? []).filter((c) => !c.digital);
    for (const c of found) {
      const s = scryToSummary(c);
      const keys = new Set([
        normalizeForSearch(s.name),
        normalizeForSearch(s.name.split("//")[0].trim()),
      ]);
      for (const k of keys) if (k && !out.has(k)) out.set(k, s);
    }
    if (found.length > 0) {
      try {
        await admin.from("cards").upsert(
          found.map((c) => summaryToRow(scryToSummary(c))),
          { onConflict: "id", ignoreDuplicates: true }
        );
      } catch {
        // Pre-072, or a transient write failure — the resolution itself
        // still answers; the stash is a bonus for next time.
      }
    }
  }
  return out;
}

/** A collector number read out of a picker query, when there is one.
 *
 *  People type numbers the way the card prints them — "489", "#489",
 *  "489/281", "ancestor dragon 489", "fdn 489" — and a plain text search
 *  treats every one of those as name words, which match nothing. The
 *  number (with a leading-zeros variant, since sources disagree about
 *  "0489") and whatever precedes it come back separately so each search
 *  path can use them its own way. Null when the term carries no number. */
function mtgNumberQuery(term: string): { rest: string; nums: string[] } | null {
  const m = term.match(/^(.*?)[\s#]*(\d{1,4}[a-z]?)(?:\s*\/\s*\S+)?$/i);
  if (!m) return null;
  const nums = [...new Set([m[2], m[2].replace(/^0+(?=.)/, "")])];
  return { rest: m[1].replace(/#/g, "").trim(), nums };
}

/** The Scryfall queries a picker term is worth trying, in order: number
 *  readings first (cn: filter, plus a set-code reading when the words
 *  before the number look like one), the raw term last — so a name that
 *  genuinely ends in digits still finds its card. */
function mtgSearchQueries(term: string): string[] {
  const out: string[] = [];
  const parsed = mtgNumberQuery(term);
  if (parsed) {
    for (const n of parsed.nums) {
      if (!parsed.rest) {
        out.push(`cn:${n}`);
      } else {
        out.push(`${parsed.rest} cn:${n}`);
        if (/^[a-z0-9]{3,5}$/i.test(parsed.rest)) {
          out.push(`set:${parsed.rest.toLowerCase()} cn:${n}`);
        }
      }
    }
  }
  if (!out.includes(term)) out.push(term);
  return out;
}

/** Free-text search for the picker: name words, collector numbers, or the
 *  Scryfall query language if the person typed set:/cn: themselves.
 *  Printings, not one-per-name — the picker's job is choosing a printing. */
export async function searchMtgCards(query: string, limit = 30): Promise<CardSummary[]> {
  const term = query.trim();
  if (!term) return [];
  // First reading that finds anything wins; Scryfall answers an empty
  // search with a 404, which lands in the catch and tries the next.
  for (const q of mtgSearchQueries(term)) {
    try {
      const listing = await scryGet(
        `/cards/search?unique=prints&order=released&q=${encodeURIComponent(q)}`
      );
      const cards = ((listing?.data as ScryCard[] | undefined) ?? []).filter((c) => !c.digital);
      if (cards.length > 0) return cards.slice(0, limit).map(scryToSummary);
    } catch {
      // No matches under this reading — try the next.
    }
  }
  return [];
}

/** Picker search for MTG: our own rows first (instant, and they carry the
 *  member-visible prices), then Scryfall for everything we've never held,
 *  deduped by id. */
export async function runMtgSearch(
  supabase: SupabaseClient,
  query: string
): Promise<CardSummary[]> {
  const term = query.trim();
  if (!term) return [];
  let local: CardSummary[] = [];
  try {
    const wanted = normalizeForSearch(term);
    if (wanted) {
      const { data } = await supabase
        .from("cards")
        .select(CARD_SUMMARY_COLUMNS)
        .eq("game", "mtg")
        .like("name_key", `${wanted}%`)
        .order("name_key")
        .order("id")
        .limit(30);
      local = ((data ?? []) as unknown as CardSummaryRow[]).map(rowToSummary);
    }
    // A collector number in the term matches our rows on number too — the
    // name-prefix query above can't see "489", and rows we already hold
    // carry the member-visible prices, so they belong ahead of Scryfall's.
    const parsed = mtgNumberQuery(term);
    if (parsed) {
      let q = supabase
        .from("cards")
        .select(CARD_SUMMARY_COLUMNS)
        .eq("game", "mtg")
        .in("number", parsed.nums)
        .limit(20);
      const restKey = normalizeForSearch(parsed.rest);
      if (restKey) q = q.like("name_key", `${restKey}%`);
      const { data } = await q;
      const have = new Set(local.map((c) => c.id));
      for (const row of (data ?? []) as unknown as CardSummaryRow[]) {
        if (!have.has(row.id)) local.push(rowToSummary(row));
      }
    }
  } catch {
    // pre-072 database — Scryfall alone still answers
  }
  const remote = await searchMtgCards(term);
  const seen = new Set(local.map((c) => c.id));
  return [...local, ...remote.filter((c) => !seen.has(c.id))].slice(0, 40);
}

/** Refresh prices (and any missing images) for the stalest MTG rows, in
 *  Scryfall's 75-per-request batches. Returns how many rows were updated.
 *
 *  This is the ENTIRE price pipeline for MTG — one source, no
 *  corroboration ladder, none of the Pokémon refresh's guard machinery,
 *  because there is no second database to disagree with and Scryfall's
 *  daily aggregates don't produce the single-listing spikes the guards
 *  exist for. */
export async function refreshMtgPrices(
  admin: SupabaseClient,
  opts?: { max?: number; staleHours?: number }
): Promise<{ scanned: number; updated: number }> {
  const max = opts?.max ?? 300;
  const staleHours = opts?.staleHours ?? 20;
  const cutoff = new Date(Date.now() - staleHours * 3_600_000).toISOString();

  let rows: Array<{ id: string; image_small: string | null }> = [];
  try {
    const { data, error } = await admin
      .from("cards")
      .select("id, image_small, price_updated_at")
      .eq("game", "mtg")
      .or(`price_updated_at.is.null,price_updated_at.lt.${cutoff}`)
      .order("price_updated_at", { ascending: true, nullsFirst: true })
      .limit(max);
    if (error) throw error;
    rows = (data ?? []) as typeof rows;
  } catch {
    return { scanned: 0, updated: 0 }; // pre-072: nothing to do yet
  }
  if (rows.length === 0) return { scanned: 0, updated: 0 };

  let updated = 0;
  for (let i = 0; i < rows.length; i += 75) {
    const chunk = rows.slice(i, i + 75);
    const identifiers = chunk.map((r) => ({ id: r.id.replace(/^scry-/, "") }));
    let found: ScryCard[] = [];
    try {
      const res = await scryPost("/cards/collection", { identifiers });
      found = (res?.data as ScryCard[] | undefined) ?? [];
    } catch (err) {
      console.warn("mtg prices: batch failed", err);
      continue;
    }
    const stamp = new Date().toISOString();
    for (const c of found) {
      const s = scryToSummary(c);
      const patch: Record<string, unknown> = {
        market_price: s.marketPrice,
        prices: s.prices,
        price_updated_at: stamp,
      };
      const had = chunk.find((r) => r.id === s.id);
      if (had && !had.image_small && s.imageSmall) {
        patch.image_small = s.imageSmall;
        patch.image_large = s.imageLarge;
      }
      const { error } = await admin.from("cards").update(patch).eq("id", s.id);
      if (!error) updated++;
    }
    // Cards Scryfall no longer knows (shouldn't happen) still get stamped,
    // so one bad id can't wedge itself at the front of the queue forever.
    const foundIds = new Set(found.map((c) => `scry-${c.id}`));
    const missing = chunk.filter((r) => !foundIds.has(r.id)).map((r) => r.id);
    if (missing.length > 0) {
      await admin
        .from("cards")
        .update({ price_updated_at: stamp })
        .in("id", missing);
    }
  }
  return { scanned: rows.length, updated };
}

/** Hourly tick, daily work: refresh whatever has gone stale. Piggybacks on
 *  the same long-lived process as the other loops. */
/** Fill the Magic trending tab with the most-built commanders.
 *
 *  Magic has no Limitless: the tournament sites are scraping-only and
 *  forbid it, and scraped HTML fails silently — the one failure mode this
 *  app refuses. Scryfall's edhrec_rank is the honest alternative: how
 *  often the EDHREC community builds with each card, served keyless by an
 *  API that invites the use. One request, most-popular first.
 *
 *  Rows land in meta_decks as source='scryfall' (075): replaced wholesale
 *  by each successful pull, never touching curated rows — an admin's
 *  hand-written archetype always wins its name. Each row is a commander,
 *  not a decklist; the deck builder takes it from there. */
/** One commander's most-played cards, from EDHREC's public page JSON.
 *
 *  The Scryfall feed names WHO is popular; this answers WHAT those decks
 *  run, which is the part that makes a trending row a decklist instead of
 *  a single card. json.edhrec.com serves each commander page's data as
 *  plain JSON — the same numbers the site renders, fetched once a day for
 *  a dozen commanders.
 *
 *  A representative core, not a full 99: the high-synergy picks and
 *  staples EDHREC leads with, capped at 40 cards plus the commander.
 *  Null on any failure or shape change — the caller falls back to the
 *  single-commander spotlight, which is exactly what shipped before this
 *  existed. */
async function edhrecDeckFor(
  c: ScryCard
): Promise<Array<{ name: string; count: number; category: string }> | null> {
  // Front face only, accents folded, punctuation dropped: EDHREC's slug
  // for "Azusa, Lost but Seeking" is "azusa-lost-but-seeking".
  const slug = c.name
    .split("//")[0]
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
  if (!slug) return null;
  try {
    const res = await fetch(`https://json.edhrec.com/pages/commanders/${slug}.json`, {
      headers: { "User-Agent": "TCGdeck/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      container?: {
        json_dict?: {
          cardlists?: Array<{ header?: string; cardviews?: Array<{ name?: string }> }>;
        };
      };
    };
    const lists = json?.container?.json_dict?.cardlists;
    if (!Array.isArray(lists)) return null;

    const categoryFor = (header: string): string =>
      /creature/i.test(header) ? "creature" : /land/i.test(header) ? "land" : "spell";
    // High-synergy picks and staples first — the lists EDHREC itself leads
    // with — then the per-type lists fill out the rest.
    const weight = (h?: string) =>
      /high synergy/i.test(h ?? "") ? 0 : /top cards/i.test(h ?? "") ? 1 : 2;
    const ordered = [...lists].sort((a, b) => weight(a.header) - weight(b.header));

    const seen = new Set([normalizeForSearch(c.name)]);
    const out: Array<{ name: string; count: number; category: string }> = [
      { name: c.name, count: 1, category: "commander" },
    ];
    for (const list of ordered) {
      for (const cv of list.cardviews ?? []) {
        const name = (cv?.name ?? "").trim();
        if (!name) continue;
        const key = normalizeForSearch(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ name, count: 1, category: categoryFor(list.header ?? "") });
        if (out.length > 40) return out;
      }
    }
    return out.length > 1 ? out : null;
  } catch {
    return null;
  }
}

export async function syncMtgCommanderMeta(admin: SupabaseClient): Promise<string> {
  const listing = await scryGet(
    // order=edhrec: most-built first. Cards banned in Commander can still
    // carry a rank, so the legality filter matters.
    `/cards/search?order=edhrec&q=${encodeURIComponent("is:commander legal:commander")}`
  );
  const cards = ((listing?.data as ScryCard[] | undefined) ?? []).filter((c) => !c.digital);
  if (cards.length === 0) throw new Error("Scryfall returned no commanders");
  const top = cards.slice(0, 12);

  // Stash each commander's card row so the trending page can resolve its
  // image, price and buy link — a spotlight with no picture and "$0.00
  // (+1 unpriced)" was the row telling on its own missing data. Insert
  // only; rows someone already holds keep their enrichments, and the
  // hourly price loop owns updates from here.
  try {
    const rows = top.map((c) => summaryToRow(scryToSummary(c)));
    await admin.from("cards").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  } catch {
    // The meta rows still stand; prices fill on the next hourly pass.
  }

  const { data: existing, error: readErr } = await admin
    .from("meta_decks")
    .select("id, archetype, source")
    .eq("game", "mtg")
    .eq("format", "commander");
  if (readErr) throw readErr;
  const curated = new Set(
    (existing ?? [])
      .filter((r) => r.source === "curated")
      .map((r) => (r.archetype as string).toLowerCase())
  );
  const scryByName = new Map(
    (existing ?? [])
      .filter((r) => r.source === "scryfall")
      .map((r) => [(r.archetype as string).toLowerCase(), r.id as string])
  );

  const now = new Date().toISOString();
  let wrote = 0;
  let withDecks = 0;
  const keep = new Set<string>();
  const deckNames = new Set<string>();
  for (const c of top) {
    const key = c.name.toLowerCase();
    if (curated.has(key)) continue;
    keep.add(key);
    const identity = (c.card_faces?.[0]?.colors ?? c.colors ?? []).join("") || "C";
    // The commander's most-played cards, so the row expands into a real
    // decklist with owned/missing math like the Pokémon rows. Null keeps
    // the single-card spotlight this feed shipped with.
    const deck = await edhrecDeckFor(c);
    if (deck) {
      withDecks += 1;
      for (const d of deck) deckNames.add(d.name);
    }
    const row = {
      archetype: c.name,
      game: "mtg",
      format: "commander",
      share: null,
      placements: null,
      core_cards: deck ?? [{ name: c.name, count: 1, category: "commander" }],
      source: "scryfall",
      window_days: null,
      notes:
        `${c.type_line ?? "Legendary Creature"} · ${identity} · one of the most-built commanders on EDHREC` +
        (deck ? " — shown with its most-played cards" : ""),
      updated_at: now,
    };
    const id = scryByName.get(key);
    const { error } = id
      ? await admin.from("meta_decks").update(row).eq("id", id)
      : await admin.from("meta_decks").insert(row);
    if (!error) wrote += 1;
    // Gentle pacing between EDHREC page fetches — a dozen a day, no rush.
    await new Promise((r) => setTimeout(r, 250));
  }
  const stale = [...scryByName.entries()].filter(([k]) => !keep.has(k)).map(([, id]) => id);
  if (stale.length > 0) {
    await admin.from("meta_decks").delete().in("id", stale).then(() => {});
  }

  // Stash catalogue rows for decklist cards we've never held, by name, so
  // the trending page resolves images, prices and buy links instead of
  // rendering forty grey rows. Insert-only, same stance as the commander
  // stash; the hourly price loop owns them from here. Names overlap
  // heavily across commanders (every deck runs Sol Ring), so this settles
  // to a handful of batches after the first run.
  try {
    const names = [...deckNames];
    const keyOf = new Map(names.map((n) => [n, normalizeForSearch(n)]));
    const have = new Set<string>();
    const keys = [...new Set([...keyOf.values()])].filter(Boolean);
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await admin
        .from("cards")
        .select("name_key")
        .like("id", "scry-%")
        .in("name_key", keys.slice(i, i + 100))
        .limit(1000);
      for (const r of data ?? []) have.add(r.name_key as string);
    }
    const need = names.filter((n) => !have.has(keyOf.get(n) ?? ""));
    for (let i = 0; i < need.length; i += 75) {
      const res = await scryPost("/cards/collection", {
        identifiers: need.slice(i, i + 75).map((name) => ({ name })),
      });
      const found = ((res?.data as ScryCard[] | undefined) ?? []).filter((cc) => !cc.digital);
      if (found.length > 0) {
        await admin
          .from("cards")
          .upsert(found.map((cc) => summaryToRow(scryToSummary(cc))), {
            onConflict: "id",
            ignoreDuplicates: true,
          });
      }
    }
  } catch {
    // Rows resolve as people scan the cards; the lists still render.
  }

  return (
    `mtg meta: top ${wrote} commanders written` +
    (withDecks ? `, ${withDecks} with EDHREC decklists` : "") +
    (stale.length ? `, ${stale.length} rotated out` : "")
  );
}

const MTG_META_STATE_KEY = "mtg_meta_synced_at";
const DAY_MS = 24 * 3_600_000;

export function startMtgPriceLoop(): void {
  const HOUR = 3_600_000;
  const tick = async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    try {
      const { scanned, updated } = await refreshMtgPrices(admin);
      if (scanned > 0) console.log(`mtg prices: ${updated}/${scanned} rows refreshed`);
    } catch (err) {
      console.warn("mtg prices: pass failed", err);
    }
    // Daily, not hourly: commander popularity moves by the week. The claim
    // is written BEFORE the sync so a failure waits for tomorrow instead
    // of hammering Scryfall every hour of a bad day.
    try {
      const { data } = await admin
        .from("app_state")
        .select("value")
        .eq("key", MTG_META_STATE_KEY)
        .maybeSingle();
      const last = Date.parse((data?.value as { at?: string } | null)?.at ?? "");
      if (Number.isFinite(last) && Date.now() - last < DAY_MS) return;
      await admin.from("app_state").upsert({
        key: MTG_META_STATE_KEY,
        value: { at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
      console.log(await syncMtgCommanderMeta(admin));
    } catch (err) {
      // Pre-074/075 databases land here (no game column / source refused) —
      // quiet by design; curated rows still carry the tab.
      console.warn("mtg meta: sync skipped", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(tick, 90_000); // after boot settles
  setInterval(tick, HOUR);
}
