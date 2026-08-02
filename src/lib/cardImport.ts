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

/** Space between page requests.
 *
 *  There was none: pages went out back-to-back, each one issued the instant
 *  the last returned, twenty in a row. That is the most aggressive pattern
 *  available to us against an API that is free, small, and visibly struggling
 *  — and 500s that recur at the same page while a valid key is configured
 *  look far more like load shedding than like a broken request.
 *
 *  Deliberately applied here rather than inside the pokemontcg client. A
 *  global queue would put a member's card lookup behind the import's next
 *  page, so a background job would be slowing down a scan somebody is
 *  watching. Only the bulk job waits.
 *
 *  400ms adds ~8s to a twenty-page call and is invisible next to a run that
 *  has to be restarted. */
const PAGE_INTERVAL_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // card-photos: a member's upload. card-art: the mirror's copy (037) —
  // overwriting it with the source's URL would silently un-mirror the card
  // on every re-import.
  return url.includes("/card-photos/") || url.includes("/card-art/");
}

/** Fold tcgp- duplicate rows into the real cards just imported.
 *
 *  Matched on name + collector number, the same key the price sync uses.
 *  Order matters and is load-bearing:
 *
 *    1. copy anything useful off the twin (tcgplayer_id, a price or image
 *       the real row lacks) — the twin usually holds data the import didn't
 *    2. repoint collection_items at the real row; on a (user, card, variant)
 *       conflict the person owns both rows, so quantities merge instead
 *    3. delete the twin ONLY after its items are gone — card_id cascades on
 *       delete, so deleting first would silently destroy collection entries
 */
async function mergeTcgpDuplicates(
  admin: SupabaseClient,
  pageRows: Array<{ id: string; name: string; number: string }>
): Promise<void> {
  const names = [...new Set(pageRows.map((r) => r.name))];
  if (names.length === 0) return;
  const { data: twins } = await admin
    .from("cards")
    .select("id, name, number, tcgplayer_id, market_price, prices, image_small")
    .like("id", "tcgp-%")
    .in("name", names);
  if (!twins || twins.length === 0) return;

  // Same normalisation the price sync matches on, and for the same reason:
  // a twin's number and name came from TCGplayer, where "58/102" and
  // "Pikachu - 58/102" are how a card is written. Stripping non-digits alone
  // turned "58/102" into 58102, so the twins this function exists to clean
  // up could never be found — the merge quietly did nothing. Both are no-ops
  // on a number and name that were already plain.
  const numKey = (n: string) =>
    (n ?? "").split("/")[0].replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const nameKey = (n: string) =>
    (n ?? "")
      .replace(/\s*[-–—]\s*#?\d+\s*(?:\/\s*\w+)?\s*$/, "")
      .trim()
      .toLowerCase();
  const realByKey = new Map(
    pageRows.map((r) => [`${nameKey(r.name)}|${numKey(r.number)}`, r.id])
  );

  for (const twin of twins) {
    const realId = realByKey.get(
      `${nameKey(twin.name as string)}|${numKey(twin.number as string)}`
    );
    if (!realId || realId === twin.id) continue;

    // 1. Anything the twin knows that the real row doesn't.
    const { data: real } = await admin
      .from("cards")
      .select("tcgplayer_id, market_price, image_small, image_locked")
      .eq("id", realId)
      .maybeSingle();
    if (!real) continue;
    const patch: Record<string, unknown> = {};
    if (!real.tcgplayer_id && twin.tcgplayer_id) patch.tcgplayer_id = twin.tcgplayer_id;
    if (real.market_price == null && twin.market_price != null) {
      patch.market_price = twin.market_price;
      patch.prices = twin.prices;
    }
    if (!real.image_small && !real.image_locked && twin.image_small) {
      patch.image_small = twin.image_small;
      patch.image_large = twin.image_small;
    }
    if (Object.keys(patch).length > 0) {
      await admin.from("cards").update(patch).eq("id", realId).then(() => {});
    }

    // 2. Repoint what people own. Row by row, because a (user, card, variant)
    // conflict means they own both twins and the quantities must merge.
    const { data: items } = await admin
      .from("collection_items")
      .select("id, user_id, variant, quantity")
      .eq("card_id", twin.id);
    let stranded = 0;
    for (const item of items ?? []) {
      const { error: moveErr } = await admin
        .from("collection_items")
        .update({ card_id: realId })
        .eq("id", item.id);
      if (!moveErr) continue;
      // They own the card under both ids: add the twin's copies to the real
      // row's entry, then drop the twin's entry.
      const { data: existing } = await admin
        .from("collection_items")
        .select("id, quantity")
        .eq("user_id", item.user_id)
        .eq("card_id", realId)
        .eq("variant", item.variant)
        .maybeSingle();
      if (existing) {
        const { error: qtyErr } = await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + (item.quantity as number) })
          .eq("id", existing.id);
        if (!qtyErr) {
          await admin.from("collection_items").delete().eq("id", item.id).then(() => {});
          continue;
        }
      }
      stranded += 1;
    }

    // 3. The twin goes only when nothing points at it — card_id cascades on
    // delete, so a premature delete destroys collection entries.
    if (stranded === 0) {
      await admin.from("cards").delete().eq("id", twin.id).then(() => {});
    }
  }
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

  // Fold any tcgp- twins of this page's cards into the real rows.
  //
  // The price sync creates cards we don't hold yet under tcgp-<id> ids. When
  // the import later brings in the same physical card under its pokemontcg.io
  // id, that twin must not linger: two rows for one card splits collections
  // and poisons name+number matching with a permanent ambiguity. Best-effort
  // — a merge failure costs a duplicate, never the page.
  try {
    await mergeTcgpDuplicates(admin, rows);
  } catch {
    /* the page still counts */
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
  // Resume after a failure — do NOT start over.
  //
  // `previous.error` used to force a fresh state, so a transient upstream
  // 500 on page 60 meant the next click on "Continue import" quietly threw
  // away 15,000 cards of progress and began again at page 1. The button says
  // continue; it has to continue. Starting over is what `restart` is for,
  // and it is a deliberate click on a different control.
  const state =
    opts?.restart || !previous || previous.done
      ? freshImportState()
      : { ...previous, error: null };

  try {
    for (let i = 0; i < maxPages; i++) {
      // Before every page but the first — no reason to make the caller wait
      // for a request that hasn't strained anything yet.
      if (i > 0) await sleep(PAGE_INTERVAL_MS);
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

/* ------------------------------------------------------------- background */

// The import runs itself, same rail as the price refresher, the art mirror
// and the price sync — and for a reason those three already proved: a job
// that only advances while an admin holds a phone awake is a job that stops
// at 21% on a free API's timeout and waits for somebody to notice.
//
// The panel is unchanged and still drives the job when pressed. Both write
// the same app_state row, so a manual run and the loop pick up each other's
// progress; the claim below stops them running the same page twice.

const IMPORT_LOOP_CLAIM_KEY = "card_import_loop";
const IMPORT_TICK_MS = 10 * 60_000;
/** While pages remain. Short, because an unfinished catalogue is the thing
 *  every other feature is waiting on. */
const IMPORT_HOT_GAP_MS = 9 * 60_000;
/** Once it's complete. The catalogue gains cards when sets release, so a
 *  weekly re-walk is enough to keep it current. */
const IMPORT_REST_GAP_MS = 7 * 24 * 3600_000;

export function startCardImportLoop() {
  const tick = async () => {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const current = await readImportState(admin);
      const gap = current?.done ? IMPORT_REST_GAP_MS : IMPORT_HOT_GAP_MS;
      const cutoff = new Date(Date.now() - gap).toISOString();
      await admin
        .from("app_state")
        .upsert({ key: IMPORT_LOOP_CLAIM_KEY }, { onConflict: "key", ignoreDuplicates: true })
        .then(() => {});
      const { data: claimed, error } = await admin
        .from("app_state")
        .update({ updated_at: new Date().toISOString() })
        .eq("key", IMPORT_LOOP_CLAIM_KEY)
        .lt("updated_at", cutoff)
        .select("key");
      if (error || !claimed || claimed.length === 0) return;

      // A finished catalogue re-walks from the top to pick up new sets;
      // an unfinished one continues. Never restart a run in progress —
      // that is the click that threw away 15,000 cards before.
      const state = await runCardImport(admin, 12, { restart: current?.done === true });
      if (state.written > 0 || state.error) {
        console.log(
          `card import loop: page ${state.page}, ${state.written} written` +
            (state.done ? " — catalogue complete" : "") +
            (state.error ? ` — ERROR: ${state.error}` : "")
        );
      }
    } catch (err) {
      console.error("card import loop error", err);
    }
  };
  setTimeout(tick, 4 * 60_000);
  setInterval(tick, IMPORT_TICK_MS);
}
