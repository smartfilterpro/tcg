// Bulk-importing the whole card catalogue.
//
// Cards used to arrive one at a time, only when somebody scanned, searched
// for or built with one. That makes search depend on a live API call, leaves
// the deck builder guessing about cards nobody has touched yet, and means
// prices are only ever as fresh as the last per-card refresh.
//
// The catalogue is small enough to just hold: ~20,000 cards at 250 a page is
// about 80 requests, and the same responses carry TCGplayer prices, so one
// import prices the entire catalogue in the time the per-card refresh takes
// to do a hundred.
//
// The whole job is resumable. It records its page cursor in app_state, so a
// serverless timeout costs one page rather than the run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { searchAllCardsPage } from "@/lib/pokemontcg";
import { summaryToRow } from "@/lib/types";

export const IMPORT_STATE_KEY = "card_import";

/** pokemontcg.io's maximum. Fewer, larger pages beats more, smaller ones. */
export const IMPORT_PAGE_SIZE = 250;

export interface CardImportState {
  /** Next page to fetch, 1-based. */
  page: number;
  /** Rows written so far this run (inserts and updates both count). */
  written: number;
  /** Rows whose artwork was deliberately left alone. */
  imagesPreserved: number;
  totalCount: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  done: boolean;
}

export function freshImportState(): CardImportState {
  const now = new Date().toISOString();
  return {
    page: 1,
    written: 0,
    imagesPreserved: 0,
    totalCount: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    done: false,
  };
}

export async function readImportState(admin: SupabaseClient): Promise<CardImportState | null> {
  const { data } = await admin
    .from("app_state")
    .select("value")
    .eq("key", IMPORT_STATE_KEY)
    .maybeSingle();
  return (data?.value as CardImportState | undefined) ?? null;
}

async function writeImportState(admin: SupabaseClient, state: CardImportState): Promise<void> {
  await admin
    .from("app_state")
    .upsert({ key: IMPORT_STATE_KEY, value: state, updated_at: new Date().toISOString() })
    .then(() => {});
}

/** Artwork we must not overwrite with the database's stock scan.
 *
 *  Two cases, and only one of them is flagged in a column. `image_locked` is
 *  set when an admin curates a card. But an ordinary member uploading a photo
 *  just writes image_small, with nothing marking it — so a blind import would
 *  silently replace every member's photo with the stock image, and the photos
 *  exist precisely because the stock image was missing or wrong. Uploads live
 *  in the card-photos storage bucket, which is what makes them recognisable. */
function keepsItsImage(row: { image_locked?: boolean | null; image_small?: string | null }): boolean {
  if (row.image_locked === true) return true;
  const url = row.image_small ?? "";
  return url.includes("/card-photos/");
}

/** Import one page. Returns whether more pages remain. */
async function importOnePage(
  admin: SupabaseClient,
  state: CardImportState
): Promise<{ more: boolean }> {
  const { cards, totalCount } = await searchAllCardsPage(state.page, IMPORT_PAGE_SIZE);
  state.totalCount = totalCount;
  if (cards.length === 0) return { more: false };

  const rows = cards.map(summaryToRow);

  // Which of these we already hold, and which of those keep their artwork.
  const { data: existing } = await admin
    .from("cards")
    .select("id, image_small, image_locked")
    .in(
      "id",
      rows.map((r) => r.id)
    );
  const protectedIds = new Set(
    ((existing ?? []) as Array<{ id: string; image_small: string | null; image_locked: boolean | null }>)
      .filter(keepsItsImage)
      .map((r) => r.id)
  );

  // Two upserts, because a single call can't vary its columns per row. The
  // second omits the image columns entirely; PostgREST's ON CONFLICT only
  // assigns the columns it was given, so the existing artwork is untouched.
  //
  // A card the API has no picture for also goes in the second group. Writing
  // its null over whatever we hold can only ever lose something — and cards
  // missing from the database are exactly the ones somebody has bothered to
  // photograph or find an image for by hand.
  const keepsImage = (r: (typeof rows)[number]) => protectedIds.has(r.id) || r.image_small == null;
  const plain = rows.filter((r) => !keepsImage(r));
  const keepImages = rows
    .filter(keepsImage)
    .map(({ image_small: _s, image_large: _l, ...rest }) => rest);

  if (plain.length > 0) {
    const { error } = await admin.from("cards").upsert(plain, { onConflict: "id" });
    if (error) throw error;
  }
  if (keepImages.length > 0) {
    const { error } = await admin.from("cards").upsert(keepImages, { onConflict: "id" });
    if (error) throw error;
  }

  state.written += rows.length;
  state.imagesPreserved += keepImages.length;
  state.page += 1;

  const seen = (state.page - 1) * IMPORT_PAGE_SIZE;
  return { more: cards.length === IMPORT_PAGE_SIZE && (totalCount == null || seen < totalCount) };
}

/** Work through up to `maxPages` pages, then save progress and return.
 *
 *  Bounded on purpose: the caller has a request timeout, and a run that dies
 *  mid-page would otherwise lose everything. Call it again to continue. */
export async function runCardImport(
  admin: SupabaseClient,
  maxPages: number,
  opts?: { restart?: boolean }
): Promise<CardImportState> {
  const previous = await readImportState(admin);
  const state =
    opts?.restart || !previous || previous.done || previous.error
      ? freshImportState()
      : { ...previous, error: null };

  try {
    for (let i = 0; i < maxPages; i++) {
      const { more } = await importOnePage(admin, state);
      state.updatedAt = new Date().toISOString();
      if (!more) {
        state.done = true;
        state.finishedAt = state.updatedAt;
        break;
      }
      // Save as we go: a timeout on page 40 must not throw away 39 pages.
      await writeImportState(admin, state);
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.updatedAt = new Date().toISOString();
  }

  await writeImportState(admin, state);
  return state;
}
