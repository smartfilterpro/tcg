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
      "User-Agent": "TrainerDeck/1.0",
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
      "User-Agent": "TrainerDeck/1.0",
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
  colors?: string[];
  image_uris?: { small?: string; normal?: string; large?: string };
  card_faces?: Array<{
    type_line?: string;
    colors?: string[];
    image_uris?: { small?: string; normal?: string; large?: string };
  }>;
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  finishes?: string[]; // nonfoil | foil | etched
  tcgplayer_id?: number;
  digital?: boolean;
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
    imageLarge: images.normal ?? images.large ?? images.small ?? null,
    marketPrice: usd ?? usdFoil ?? usdEtched ?? null,
    prices: Object.keys(prices).length > 0 ? prices : null,
    tcgplayerId: c.tcgplayer_id ?? null,
  };
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

/** Free-text search for the picker: name words, optionally narrowed the
 *  Scryfall query-language way if the person typed set:/number themselves.
 *  Printings, not one-per-name — the picker's job is choosing a printing. */
export async function searchMtgCards(query: string, limit = 30): Promise<CardSummary[]> {
  const term = query.trim();
  if (!term) return [];
  const q = encodeURIComponent(term);
  try {
    const listing = await scryGet(
      `/cards/search?unique=prints&order=released&q=${q}`
    );
    const cards = (listing?.data as ScryCard[] | undefined) ?? [];
    return cards.filter((c) => !c.digital).slice(0, limit).map(scryToSummary);
  } catch {
    return [];
  }
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
export function startMtgPriceLoop(): void {
  const HOUR = 3_600_000;
  const tick = async () => {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const { scanned, updated } = await refreshMtgPrices(admin);
      if (scanned > 0) console.log(`mtg prices: ${updated}/${scanned} rows refreshed`);
    } catch (err) {
      console.warn("mtg prices: pass failed", err);
    }
  };
  setTimeout(tick, 90_000); // after boot settles
  setInterval(tick, HOUR);
}
