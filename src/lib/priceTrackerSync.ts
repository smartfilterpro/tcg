// Filling the price gap with the allowance we already pay for.
//
// The catalogue is ~20,500 cards and the Personal plan is 20,000 credits a
// day, so a full pass costs a little over one day's allowance. Until now we
// spent perhaps a dozen of those credits — one card at a time, only when
// somebody pressed "find image online" — while the daily price refresh
// crawled a few hundred cards and reported 51 of 120 with no price at all.
// The data existed; we just never asked for it.
//
// The rules, each an owner decision:
//
//   PRICES ALWAYS UPDATE. Their numbers are TCGplayer market prices — the
//   same underlying source our import reads, refreshed daily instead of
//   whenever the import last ran. Same source, fresher, wins. (Members'
//   own price_override values live on collection_items and are never
//   touched by any of this.)
//
//   EVERYTHING ELSE GAP-FILLS. Images fill only where we have none, and
//   member photos and admin-locked art are never touched.
//
//   CARDS WE DON'T HOLD ARE ADDED, under a minted tcgp-<id> row that the
//   catalogue import later folds into the real card.
//
//   MATCH EXACTLY OR SKIP. A wrong match writes a wrong price onto a real
//   card, and nobody would ever notice. Name and collector number must both
//   agree, and an ambiguous name+number pair is skipped rather than guessed.
//
// One request per SET, not per card: fetchAllInSet returns the whole set and
// still bills one credit a card, but counts about three requests against the
// per-minute limit instead of one per card.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { cleanCardName, numberKey } from "@/lib/pokemontcg";
import { budgetState, priceTrackerEnabled, ptFetch } from "@/lib/priceTracker";

export const SYNC_STATE_KEY = "price_tracker_sync";

/** Gap between whole-set requests. Their per-minute allowance is separate
 *  from the daily one and a set fetch counts as several requests against it;
 *  five in quick succession tripped it. */
const SET_INTERVAL_MS = 6_000;

/** The safety valve on adding cards: how many of their cards must be seen
 *  before the match rate means anything, and how low that rate has to fall
 *  before adding is treated as a bug rather than a gap. Half is generous —
 *  a healthy sync matches nearly everything, since both catalogues are the
 *  same game. */
const ADD_GUARD_MIN_SEEN = 300;
const ADD_GUARD_MIN_RATE = 0.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncState {
  /** Sets still to walk, in order. Held in the state so a resumed run does
   *  not pay to list them again. */
  sets: Array<{ id: string; name: string }>;
  setIndex: number;
  cardsSeen: number;
  /** How many of their cards found one of ours. The denominator that makes
   *  "3,771 new cards added" readable as either a healthy import or a
   *  broken matcher — without it the two look identical. */
  matched: number;
  /** Set when the match rate collapsed and adding was stopped. Carries the
   *  reason so the panel can say what happened rather than just going
   *  quiet. */
  addsPaused?: string | null;
  pricesFilled: number;
  imagesFilled: number;
  idsFilled: number;
  /** Printing details (rarity, type, HP, stage, set size) filled from the
   *  same responses. Counted separately so it is visible that the credit is
   *  buying more than a price. */
  detailsFilled: number;
  skippedAmbiguous: number;
  /** How many of OUR cards were loaded into the match index. Zero here with
   *  a rising cardsSeen is the signature of a broken index, which is
   *  otherwise invisible: every card is "seen" and none can ever match. */
  indexedCards: number;
  /** Set when their minute window cut a run short. Not an error — press
   *  again in a minute. */
  rateLimited: boolean;
  /** Cards we didn't hold at all, created from their record. */
  cardsAdded: number;
  /** A few of their cards that matched nothing of ours, verbatim. "Nothing
   *  matched" has two very different causes — we don't hold the card, or we
   *  hold it under a different name/number format — and only seeing real
   *  examples separates them. */
  unmatchedSamples: Array<{ set: string; name: string; num: string; key?: string }>;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  done: boolean;
}

export function freshSyncState(): SyncState {
  const now = new Date().toISOString();
  return {
    sets: [],
    setIndex: 0,
    cardsSeen: 0,
    matched: 0,
    addsPaused: null,
    pricesFilled: 0,
    imagesFilled: 0,
    idsFilled: 0,
    detailsFilled: 0,
    skippedAmbiguous: 0,
    indexedCards: 0,
    rateLimited: false,
    cardsAdded: 0,
    unmatchedSamples: [],
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    done: false,
  };
}

/** Read the saved state, filled out to the CURRENT shape.
 *
 *  A row written by an older build is missing whatever fields have been
 *  added since, and those arrive at the UI as undefined — where a perfectly
 *  reasonable `state.indexedCards.toLocaleString()` throws and takes the
 *  whole admin page down with a blank client-side error. Persisted JSON
 *  outlives the code that wrote it, so the reader owns the defaults. */
export async function readSyncState(admin: SupabaseClient): Promise<SyncState | null> {
  const { data } = await admin
    .from("app_state")
    .select("value")
    .eq("key", SYNC_STATE_KEY)
    .maybeSingle();
  const stored = data?.value as Partial<SyncState> | undefined;
  if (!stored) return null;
  return { ...freshSyncState(), ...stored };
}

async function writeSyncState(admin: SupabaseClient, state: SyncState): Promise<void> {
  await admin
    .from("app_state")
    .upsert({ key: SYNC_STATE_KEY, value: state, updated_at: new Date().toISOString() })
    .then(() => {});
}

/* --------------------------------------------------------------- matching */

export interface OurCard {
  id: string;
  name: string;
  number: string;
  set_name: string | null;
  market_price: number | null;
  prices: Record<string, number | null> | null;
  image_small: string | null;
  image_locked: boolean | null;
  tcgplayer_id: string | null;
  /** The printing details their record also carries. Selected so patchFor
   *  can tell "we already know this" from "we have a hole here" — without
   *  them every card looks full and the rest of a paid response is dropped. */
  rarity: string | null;
  supertype: string | null;
  subtypes: string[] | null;
  types: string[] | null;
  hp: string | null;
  set_printed_total: number | null;
}

/** Their card-type enum → our supertype. Their docs give it as
 *  "Pokémon"/"Pokemon"/"Trainer"/"Energy" depending on the page, so this
 *  normalises rather than trusts. Null for anything unrecognised: a guessed
 *  supertype miscategorises a card everywhere it is read. */
export function supertypeOf(cardType: string | null | undefined): string | null {
  const t = (cardType ?? "").toLowerCase();
  if (t.startsWith("pok")) return "Pokémon";
  if (t.startsWith("train")) return "Trainer";
  if (t.startsWith("energ")) return "Energy";
  return null;
}

export interface TheirCard {
  tcgPlayerId?: string;
  name?: string;
  setName?: string;
  cardNumber?: string;
  totalSetNumber?: string;
  rarity?: string;
  cardType?: string;
  pokemonType?: string;
  hp?: number;
  stage?: string;
  prices?: { market?: number; low?: number; primaryPrinting?: string };
  imageCdnUrl800?: string;
  imageCdnUrl400?: string;
  imageCdnUrl?: string;
}

/** A brand-new card row from their record, for a card we don't hold at all.
 *
 *  The id is minted as tcgp-<tcgPlayerId> — deterministic, so re-seeing the
 *  same card upserts the same row instead of multiplying. Same pattern as
 *  the tcgdex- and custom- prefixes that already live in the id space. When
 *  the pokemontcg.io import later imports the same card under its own id,
 *  mergeTcgpDuplicates in cardImport folds this row into that one.
 *
 *  Null when their record is too thin to key reliably: a card with no name
 *  or no number could never be matched again, and an unmatchable row is a
 *  permanent duplicate waiting to happen. */
export function rowFromTheirs(
  theirs: TheirCard,
  set: { id: string; name: string }
): Record<string, unknown> | null {
  const name = cleanCardName(theirs.name ?? "");
  const number = (theirs.cardNumber ?? "").trim();
  const tcgId = (theirs.tcgPlayerId ?? "").trim();
  if (!name || !number || !tcgId) return null;

  const supertype = supertypeOf(theirs.cardType);

  const market = typeof theirs.prices?.market === "number" ? theirs.prices.market : null;
  const image = theirs.imageCdnUrl800 ?? theirs.imageCdnUrl400 ?? theirs.imageCdnUrl ?? null;
  const total = Number((theirs.totalSetNumber ?? "").replace(/\D/g, ""));

  return {
    id: `tcgp-${tcgId}`,
    name,
    supertype,
    subtypes: theirs.stage ? [theirs.stage] : [],
    types: theirs.pokemonType ? [theirs.pokemonType] : [],
    hp: typeof theirs.hp === "number" ? String(theirs.hp) : null,
    number,
    rarity: theirs.rarity ?? null,
    set_id: `tcgp-set-${set.id}`,
    set_name: theirs.setName ?? set.name,
    set_series: null,
    set_printed_total: Number.isFinite(total) && total > 0 ? total : null,
    release_date: null,
    image_small: image,
    image_large: image,
    market_price: market,
    prices:
      market != null ? { [variantKeyFor(theirs.prices?.primaryPrinting) ?? "normal"]: market } : null,
    price_updated_at: new Date().toISOString(),
    tcgplayer_id: tcgId,
  };
}

/** Index key: normalised name plus normalised collector number.
 *
 *  Set names are NOT part of it. Their set names come from TCGplayer and
 *  ours from pokemontcg.io, and the two disagree often enough — "SV: Paldea
 *  Evolved" against "Paldea Evolved", "Sword & Shield" against "SWSH" — that
 *  keying on them would drop most of the catalogue. Name and number together
 *  are specific enough that a collision is a genuine ambiguity rather than a
 *  near miss, and collisions are counted and skipped. */
export function indexKey(name: string, number: string | null | undefined): string {
  return `${cleanCardName(name ?? "").toLowerCase()}|${numberKey(number ?? "") ?? ""}`;
}

/** The keys one of THEIR cards might be filed under, best guess first.
 *
 *  Their records come from TCGplayer, whose product names and collector
 *  numbers are written for a shop, not a catalogue. Two differences break a
 *  naive key outright:
 *
 *    "58/102"  — a collector number written with its set size. numberKey
 *                strips non-digits, so this becomes "58102" and matches
 *                nothing; ours is plain "58".
 *    "Pikachu - 58/102" — the number repeated inside the product name, and
 *                sometimes a bare "Pikachu - 58".
 *
 *  Each is undone and the resulting keys tried in turn. Every variant is a
 *  no-op on data that was already clean, so this cannot make matching worse
 *  — and a card matched on a later variant is the same card, not a fuzzy
 *  guess: name and number must still both agree exactly. */
export function theirKeys(
  name: string | null | undefined,
  number: string | null | undefined
): string[] {
  const rawName = (name ?? "").trim();
  const rawNumber = (number ?? "").trim();

  const names = new Set<string>([rawName]);
  // " - 58/102" or " - 58" at the end of a product name.
  const trimmed = rawName.replace(/\s*[-–—]\s*#?\d+\s*(?:\/\s*\w+)?\s*$/, "").trim();
  if (trimmed) names.add(trimmed);

  const numbers = new Set<string>([rawNumber]);
  // "58/102" → "58". Only the part before the slash is the card's own number.
  if (rawNumber.includes("/")) {
    const head = rawNumber.split("/")[0].trim();
    if (head) numbers.add(head);
  }

  const keys: string[] = [];
  for (const n of names) {
    for (const num of numbers) {
      const key = indexKey(n, num);
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** Our catalogue, keyed for matching. Keys hit by more than one card are
 *  marked ambiguous and never matched — two different cards sharing a name
 *  and number means we cannot tell which one a price belongs to. */
export function buildIndex(cards: OurCard[]): {
  byKey: Map<string, OurCard>;
  ambiguous: Set<string>;
} {
  const byKey = new Map<string, OurCard>();
  const ambiguous = new Set<string>();
  for (const c of cards) {
    const key = indexKey(c.name, c.number);
    if (byKey.has(key)) {
      ambiguous.add(key);
      continue;
    }
    byKey.set(key, c);
  }
  for (const key of ambiguous) byKey.delete(key);
  return { byKey, ambiguous };
}

/** Their printing names → our per-finish price keys. Unknown names return
 *  null and the per-finish map is left alone — writing a guessed key would
 *  invent a finish the card doesn't come in, and availableVariants() treats
 *  the map's keys as the list of finishes that exist. */
export function variantKeyFor(printing: string | null | undefined): string | null {
  const t = (printing ?? "").trim().toLowerCase();
  if (!t || t === "normal" || t === "unlimited") return "normal";
  if (t === "holofoil") return "holofoil";
  if (t === "reverse holofoil") return "reverseHolofoil";
  if (t === "1st edition" || t === "1st edition normal") return "1stEditionNormal";
  if (t === "1st edition holofoil") return "1stEditionHolofoil";
  if (t === "unlimited holofoil") return "unlimitedHolofoil";
  return null;
}

export interface Patch {
  id: string;
  market_price?: number;
  prices?: Record<string, number | null>;
  image_small?: string;
  image_large?: string;
  tcgplayer_id?: string;
  rarity?: string;
  supertype?: string;
  subtypes?: string[];
  types?: string[];
  hp?: string;
  set_printed_total?: number;
}

/** What, if anything, one of their cards adds to one of ours. Returns null
 *  when it adds nothing — which is the common case once a set is filled, and
 *  is why a second run over the same set costs credits but writes nothing. */
export function patchFor(ours: OurCard, theirs: TheirCard): Patch | null {
  const patch: Patch = { id: ours.id };
  let useful = false;

  // The join key for every dataset they publish. Recorded even when nothing
  // else is missing — it is the thing we have none of.
  if (!ours.tcgplayer_id && typeof theirs.tcgPlayerId === "string") {
    patch.tcgplayer_id = theirs.tcgPlayerId;
    useful = true;
  }

  // PRICES ALWAYS UPDATE — same source as the import (TCGplayer), fresher.
  // Skipped when equal, so an already-current card writes nothing.
  const market = theirs.prices?.market;
  if (typeof market === "number" && market > 0 && market !== ours.market_price) {
    patch.market_price = market;
    const key = variantKeyFor(theirs.prices?.primaryPrinting);
    const existing = ours.prices ?? {};
    if (key) {
      patch.prices = { ...existing, [key]: market };
    } else if (Object.keys(existing).length === 0) {
      // No finish stated and no map to respect: seed the headline finish so
      // finish-aware pricing shows something rather than nothing.
      patch.prices = { normal: market };
    }
    // A stated-but-unknown finish updates market_price only, leaving the
    // per-finish map to the source that understands it.
    useful = true;
  }

  const image = theirs.imageCdnUrl800 ?? theirs.imageCdnUrl400 ?? theirs.imageCdnUrl;
  // Never touch admin-locked art or a member's own photo — same rule the
  // catalogue import follows, for the same reason: those exist precisely
  // because the stock image was missing or wrong.
  const memberPhoto = (ours.image_small ?? "").includes("/card-photos/");
  if (!ours.image_small && !ours.image_locked && !memberPhoto && typeof image === "string") {
    patch.image_small = image;
    patch.image_large = image;
    useful = true;
  }

  // THE REST OF THE RECORD, which we were paying for and dropping.
  //
  // One credit buys the whole card, and this function used to read four
  // fields off it. Everything below already exists as a column, already
  // arrives in the same response, and costs nothing more to keep. Gap-fill
  // only — a value we already hold is never overwritten, because ours comes
  // from pokemontcg.io, which is the authority on how a card is printed.
  if (!ours.rarity && typeof theirs.rarity === "string" && theirs.rarity.trim()) {
    patch.rarity = theirs.rarity.trim();
    useful = true;
  }
  if (!ours.supertype) {
    const st = supertypeOf(theirs.cardType);
    if (st) {
      patch.supertype = st;
      useful = true;
    }
  }
  if (!ours.hp && typeof theirs.hp === "number" && theirs.hp > 0) {
    patch.hp = String(theirs.hp);
    useful = true;
  }
  if ((ours.types?.length ?? 0) === 0 && typeof theirs.pokemonType === "string" && theirs.pokemonType.trim()) {
    patch.types = [theirs.pokemonType.trim()];
    useful = true;
  }
  if ((ours.subtypes?.length ?? 0) === 0 && typeof theirs.stage === "string" && theirs.stage.trim()) {
    patch.subtypes = [theirs.stage.trim()];
    useful = true;
  }
  // The one that is worth more than it looks: set_printed_total is how the
  // assistant decides whether our copy of a set is COMPLETE or whether it
  // must say so. Without it, "what am I missing from this set?" is answered
  // against an unknown denominator.
  if (ours.set_printed_total == null) {
    const total = Number((theirs.totalSetNumber ?? "").replace(/\D/g, ""));
    if (Number.isFinite(total) && total > 0) {
      patch.set_printed_total = total;
      useful = true;
    }
  }

  return useful ? patch : null;
}

/* ------------------------------------------------------------------- run */

/* ------------------------------------------------------------- background */

// The sync runs itself now, same rail as the price refresher and the art
// mirror: a self-scheduling loop on the long-lived server with an
// app_state claim so two instances can't double-run. While a pass is
// unfinished it walks a slice of sets every few minutes (in-process, so
// no proxy timeout — bigger slices than the admin panel's); once a pass
// completes it rests ~20 hours, then starts over, because upstream
// refreshes prices daily and a finished pass is only fresh for a day.
// The admin panel keeps working exactly as before — same persisted state,
// so a manual run and the loop pick up each other's progress.

const LOOP_CLAIM_KEY = "pt_sync_loop";
const LOOP_TICK_MS = 10 * 60_000;
const LOOP_HOT_GAP_MS = 7 * 60_000;
const LOOP_REST_GAP_MS = 20 * 3600_000;

export function startPriceSyncLoop() {
  const tick = async () => {
    try {
      if (!priceTrackerEnabled()) return;
      const admin = createAdminClient();
      const current = await readSyncState(admin);
      // Rest once a pass is done; run hot while sets remain. A brand-new
      // install (no state) counts as work to do.
      const gap = current?.done ? LOOP_REST_GAP_MS : LOOP_HOT_GAP_MS;
      const cutoff = new Date(Date.now() - gap).toISOString();
      await admin
        .from("app_state")
        .upsert({ key: LOOP_CLAIM_KEY }, { onConflict: "key", ignoreDuplicates: true })
        .then(() => {});
      const { data: claimed, error } = await admin
        .from("app_state")
        .update({ updated_at: new Date().toISOString() })
        .eq("key", LOOP_CLAIM_KEY)
        .lt("updated_at", cutoff)
        .select("key");
      if (error || !claimed || claimed.length === 0) return;

      const state = await runPriceSync(admin, {
        maxSets: 10,
        // A finished pass restarts to keep prices daily-fresh.
        restart: current?.done === true,
      });
      if (state.cardsSeen > 0 || state.error) {
        console.log(
          `price sync loop: set ${state.setIndex}, ${state.pricesFilled} prices, ` +
            `${state.cardsAdded} added${state.rateLimited ? " — rate limited, will resume" : ""}` +
            (state.error ? ` — ERROR: ${state.error}` : "")
        );
      }
    } catch (err) {
      console.error("price sync loop error", err);
    }
  };
  setTimeout(tick, 3 * 60_000);
  setInterval(tick, LOOP_TICK_MS);
}

export interface SyncOptions {
  /** Stop after this many sets, so one invocation stays inside a request. */
  maxSets?: number;
  /** Leave this many credits spare for on-demand lookups. */
  reserve?: number;
  restart?: boolean;
}

/** Work through the catalogue set by set, filling gaps. Resumable: a run
 *  stops on a set boundary and the next continues from there. */
export async function runPriceSync(
  admin: SupabaseClient,
  opts: SyncOptions = {}
): Promise<SyncState> {
  if (!priceTrackerEnabled()) {
    throw new Error("POKEMONPRICETRACKER_API_KEY isn't set.");
  }
  // Small by default. Twelve sets with six-second spacing is a ninety-second
  // request, which is past what Railway's proxy will sit through — it
  // answers with a plain-text "upstream error" page instead. The panel calls
  // repeatedly; each call stays well inside the timeout.
  const maxSets = Math.max(1, Math.min(60, opts.maxSets ?? 3));
  const reserve = Math.max(0, opts.reserve ?? 2000);

  const previous = await readSyncState(admin);
  const state =
    opts.restart || !previous || previous.done
      ? freshSyncState()
      : { ...previous, error: null, rateLimited: false };

  try {
    // The set list, once per pass rather than once per run.
    if (state.sets.length === 0) {
      const sets: Array<{ id: string; name: string }> = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const json = (await ptFetch("/sets", {
          limit: "100",
          offset: String(offset),
        })) as { data?: Array<Record<string, unknown>> };
        const page = json.data ?? [];
        for (const s of page) {
          const id = (s.tcgPlayerId ?? s.id) as string | undefined;
          if (id) sets.push({ id: String(id), name: String(s.name ?? "") });
        }
        if (page.length < 100) break;
      }
      state.sets = sets;
      state.setIndex = 0;
    }

    // Our whole catalogue, once. 20,000 rows is a few megabytes and one pass
    // of paging — far cheaper than a query per card.
    // Checked, not assumed.
    //
    // This select names tcgplayer_id, which only exists after migration 033.
    // Without it the whole query fails, the index comes back empty, and the
    // sync walks the entire catalogue matching nothing at all — 404 cards
    // seen, zero filled, no error anywhere. Swallowing this error made a
    // configuration problem look like a matching problem.
    const { data: ours, error: ourError } = await fetchAllRows<OurCard>(() =>
      admin
        .from("cards")
        .select(
          "id, name, number, set_name, market_price, prices, image_small, image_locked, tcgplayer_id, rarity, supertype, subtypes, types, hp, set_printed_total"
        )
        .order("id")
    );
    if (ourError) {
      throw new Error(
        /tcgplayer_id/.test(ourError.message)
          ? "The cards table has no tcgplayer_id column — run supabase/migrations/033_tcgplayer_ids.sql first."
          : `Couldn't read our catalogue: ${ourError.message}`
      );
    }
    if (ours.length === 0) {
      throw new Error("Our cards table is empty — run the card catalogue import first.");
    }
    const { byKey, ambiguous } = buildIndex(ours);
    state.indexedCards = byKey.size;

    let setsThisRun = 0;
    while (state.setIndex < state.sets.length && setsThisRun < maxSets) {
      const budget = budgetState();
      if (budget.cap - budget.used <= reserve) break;

      const set = state.sets[state.setIndex];

      // Their minute window is stricter than the daily one, and a whole-set
      // fetch counts several requests against it. Five sets back-to-back was
      // enough to trip it. Spaced out, so a run walks steadily instead of
      // sprinting into a wall.
      if (setsThisRun > 0) await sleep(SET_INTERVAL_MS);

      let json: { data?: TheirCard[] | TheirCard };
      try {
        json = (await ptFetch("/cards", {
          setId: set.id,
          fetchAllInSet: "true",
          limit: "200",
        })) as { data?: TheirCard[] | TheirCard };
      } catch (err) {
        // 429 is not a failure, it is a pause. Stop here with progress saved
        // and let the next press carry on rather than recording an error
        // over a run that was working.
        if (err instanceof Error && /429|rate limit/i.test(err.message)) {
          state.rateLimited = true;
          break;
        }
        throw err;
      }
      const cards = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];

      const patches: Patch[] = [];
      for (const theirs of cards) {
        state.cardsSeen += 1;
        const keys = theirKeys(theirs.name, theirs.cardNumber);
        const key = keys[0];
        if (keys.some((k) => ambiguous.has(k))) {
          state.skippedAmbiguous += 1;
          continue;
        }
        let mine: OurCard | undefined;
        for (const k of keys) {
          mine = byKey.get(k);
          if (mine) break;
        }
        if (mine) state.matched += 1;
        if (!mine) {
          // A card we don't hold at all: add it rather than skip it. The
          // catalogue is only as complete as its sources, and this source is
          // holding a full record in its hands. Guarded by the ambiguity set
          // — a key two of OUR cards already share can't safely gain a third
          // — and by rowFromTheirs returning null for records too thin to
          // ever match again.
          //
          // …and guarded by the match rate, which is the guard that was
          // missing. Adding is for the handful of cards a source has and we
          // don't. When almost NOTHING matches, the honest reading is that
          // the matcher is broken, not that we are missing 97% of the
          // Pokémon catalogue — and the difference matters because one
          // outcome is a filled gap and the other is tens of thousands of
          // duplicate rows that then cost storage, bandwidth and a cleanup.
          // Pausing is free and reversible; the run keeps updating the
          // cards it DID match.
          if (state.addsPaused == null && state.cardsSeen >= ADD_GUARD_MIN_SEEN) {
            const rate = state.matched / state.cardsSeen;
            if (rate < ADD_GUARD_MIN_RATE) {
              state.addsPaused =
                `Only ${Math.round(rate * 100)}% of their cards matched ours over the ` +
                `first ${state.cardsSeen.toLocaleString()} seen. That reads as a matching ` +
                `problem rather than a genuinely missing catalogue, so adding new cards ` +
                `stopped. Prices and images for matched cards are still being updated. ` +
                `Check the unmatched examples below to see how their names and numbers ` +
                `are written.`;
            }
          }
          if (!ambiguous.has(key) && state.addsPaused == null) {
            const row = rowFromTheirs(theirs, set);
            if (row) {
              const { error: insErr } = await admin
                .from("cards")
                .upsert(row, { onConflict: "id" });
              if (!insErr) {
                state.cardsAdded += 1;
                // Into the index, so the same card met again this run (a
                // reprint list, a shared promo) updates rather than re-adds.
                byKey.set(key, {
                  id: row.id as string,
                  name: row.name as string,
                  number: row.number as string,
                  set_name: row.set_name as string | null,
                  market_price: row.market_price as number | null,
                  prices: row.prices as Record<string, number | null> | null,
                  image_small: row.image_small as string | null,
                  image_locked: false,
                  tcgplayer_id: row.tcgplayer_id as string,
                  // rowFromTheirs already wrote these, so the index has to
                  // carry them too — otherwise meeting the card again this
                  // run reads them as holes and patches what it just set.
                  rarity: row.rarity as string | null,
                  supertype: row.supertype as string | null,
                  subtypes: row.subtypes as string[],
                  types: row.types as string[],
                  hp: row.hp as string | null,
                  set_printed_total: row.set_printed_total as number | null,
                });
                continue;
              }
            }
          }
          // Verbatim, plus the key we looked them up under — the name and
          // number alone say what they sent, and the key says what we made
          // of it, which is where a mismatch actually lives.
          if (state.unmatchedSamples.length < 25) {
            state.unmatchedSamples.push({
              set: set.name,
              name: theirs.name ?? "?",
              num: theirs.cardNumber ?? "?",
              key,
            });
          }
          continue;
        }
        const patch = patchFor(mine, theirs);
        if (patch) patches.push(patch);
      }

      for (const patch of patches) {
        const { id, ...fields } = patch;
        const { error } = await admin
          .from("cards")
          .update({ ...fields, price_updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) continue;
        if (fields.market_price != null) state.pricesFilled += 1;
        if (fields.image_small) state.imagesFilled += 1;
        if (fields.tcgplayer_id) state.idsFilled += 1;
        if (
          fields.rarity ||
          fields.supertype ||
          fields.hp ||
          fields.types ||
          fields.subtypes ||
          fields.set_printed_total != null
        ) {
          state.detailsFilled += 1;
        }
      }

      state.setIndex += 1;
      setsThisRun += 1;
      state.updatedAt = new Date().toISOString();
      await writeSyncState(admin, state);
    }

    if (state.setIndex >= state.sets.length) {
      state.done = true;
      state.finishedAt = new Date().toISOString();
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  state.updatedAt = new Date().toISOString();
  await writeSyncState(admin, state);
  return state;
}
