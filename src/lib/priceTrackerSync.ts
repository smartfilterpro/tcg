// Filling the price gap with the allowance we already pay for.
//
// The catalogue is ~20,500 cards and the Personal plan is 20,000 credits a
// day, so a full pass costs a little over one day's allowance. Until now we
// spent perhaps a dozen of those credits — one card at a time, only when
// somebody pressed "find image online" — while the daily price refresh
// crawled a few hundred cards and reported 51 of 120 with no price at all.
// The data existed; we just never asked for it.
//
// Two rules shape the whole file:
//
//   GAP-FILL, NEVER OVERWRITE. A card that already has a price keeps it.
//   Replacing the valuation source wholesale is a different decision from
//   using an allowance, and quietly doing the first while being asked for
//   the second would be wrong.
//
//   MATCH EXACTLY OR SKIP. A wrong match writes a wrong price onto a real
//   card, and nobody would ever notice. Name and collector number must both
//   agree, and an ambiguous name+number pair is skipped rather than guessed.
//
// One request per SET, not per card: fetchAllInSet returns the whole set and
// still bills one credit a card, but counts about three requests against the
// per-minute limit instead of one per card.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";
import { cleanCardName, numberKey } from "@/lib/pokemontcg";
import { budgetState, priceTrackerEnabled, ptFetch } from "@/lib/priceTracker";

export const SYNC_STATE_KEY = "price_tracker_sync";

export interface SyncState {
  /** Sets still to walk, in order. Held in the state so a resumed run does
   *  not pay to list them again. */
  sets: Array<{ id: string; name: string }>;
  setIndex: number;
  cardsSeen: number;
  pricesFilled: number;
  imagesFilled: number;
  idsFilled: number;
  skippedAmbiguous: number;
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
    pricesFilled: 0,
    imagesFilled: 0,
    idsFilled: 0,
    skippedAmbiguous: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    done: false,
  };
}

export async function readSyncState(admin: SupabaseClient): Promise<SyncState | null> {
  const { data } = await admin
    .from("app_state")
    .select("value")
    .eq("key", SYNC_STATE_KEY)
    .maybeSingle();
  return (data?.value as SyncState | undefined) ?? null;
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
}

export interface TheirCard {
  tcgPlayerId?: string;
  name?: string;
  setName?: string;
  cardNumber?: string;
  prices?: { market?: number; low?: number };
  imageCdnUrl800?: string;
  imageCdnUrl400?: string;
  imageCdnUrl?: string;
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

export interface Patch {
  id: string;
  market_price?: number;
  prices?: Record<string, number | null>;
  image_small?: string;
  image_large?: string;
  tcgplayer_id?: string;
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

  // GAP-FILL. A card that already has a price keeps it.
  const market = theirs.prices?.market;
  if (ours.market_price == null && typeof market === "number" && market > 0) {
    patch.market_price = market;
    // Seed the per-finish map too, or the collection's finish-aware pricing
    // still shows nothing for a card whose headline price we just set.
    patch.prices = { ...(ours.prices ?? {}), normal: market };
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

  return useful ? patch : null;
}

/* ------------------------------------------------------------------- run */

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
  const maxSets = Math.max(1, Math.min(60, opts.maxSets ?? 12));
  const reserve = Math.max(0, opts.reserve ?? 2000);

  const previous = await readSyncState(admin);
  const state =
    opts.restart || !previous || previous.done ? freshSyncState() : { ...previous, error: null };

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
    const { data: ours } = await fetchAllRows<OurCard>(() =>
      admin
        .from("cards")
        .select("id, name, number, set_name, market_price, prices, image_small, image_locked, tcgplayer_id")
        .order("id")
    );
    const { byKey, ambiguous } = buildIndex(ours);

    let setsThisRun = 0;
    while (state.setIndex < state.sets.length && setsThisRun < maxSets) {
      const budget = budgetState();
      if (budget.cap - budget.used <= reserve) break;

      const set = state.sets[state.setIndex];
      const json = (await ptFetch("/cards", {
        setId: set.id,
        fetchAllInSet: "true",
        limit: "200",
      })) as { data?: TheirCard[] | TheirCard };
      const cards = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];

      const patches: Patch[] = [];
      for (const theirs of cards) {
        state.cardsSeen += 1;
        const key = indexKey(theirs.name ?? "", theirs.cardNumber);
        if (ambiguous.has(key)) {
          state.skippedAmbiguous += 1;
          continue;
        }
        const mine = byKey.get(key);
        if (!mine) continue;
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
