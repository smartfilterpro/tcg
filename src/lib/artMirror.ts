// Mirroring card artwork into our own storage.
//
// The catalogue stores card data, but until now the pictures were hotlinked
// from whichever database supplied them — a render-time dependency on
// third-party servers whose outages we've already met. Owner decision:
// hold our own copy. This walks cards whose images still point elsewhere,
// downloads them, uploads them to the public card-art bucket, and repoints
// the row, preserving the original URL in source_image_* for provenance
// and re-mirroring.
//
// It runs in admin-driven batches, not one big job: each batch is one HTTP
// request that stays comfortably inside the proxy timeout, and the cursor
// (last examined card id) lives with the client, so a stopped run resumes
// wherever it left off. Cards it can't fetch stay pointed at the source and
// remain eligible for the next run — except for art the source says is
// permanently GONE, which after a few tries is re-sourced from another free
// database or, failing that, cleared: a URL that 404s renders as a broken
// image and makes the card look like it already has a picture, which is how
// these cards stayed broken and invisible to every filler we have.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { findTcgdexImage } from "@/lib/tcgdex";

const BUCKET = "card-art";

/** Pause between downloads. This walks other people's servers by the
 *  thousand, and the polite pace is also the pace that doesn't get us
 *  rate-limited half way through a set. */
const DOWNLOAD_INTERVAL_MS = 150;

/** How many cards to scan per batch (cheap: one DB page) and how many to
 *  actually mirror (expensive: up to two downloads + uploads each). 20
 *  cards × 2 images × ~1s is under half the proxy timeout. */
const SCAN_WINDOW = 1000;
const MIRROR_PER_BATCH = 20;

/** Mirror only cards somebody owns.
 *
 *  The catalogue is ~33,000 cards and members collectively own a small
 *  fraction of them. Mirroring the whole thing spent 1.5GB on artwork for
 *  cards nobody has ever looked at and blew a 1GB storage quota — for no
 *  benefit, because an unowned card's picture is only ever seen if someone
 *  searches for it, and view-time mirroring (the /art route) grabs THAT one
 *  the moment they do.
 *
 *  So the sweep works the owned set and the long tail stays hotlinked until
 *  it is actually wanted.
 *
 *  NOW FALSE: on Supabase Pro the whole catalogue's artwork is ~3GB against
 *  a 100GB allowance, which restores the actual goal — every card the app
 *  can show is served from our own storage, including cards nobody owns yet
 *  but that search, the deck builder's buy-list and TrainerAI all display.
 *  Set back to true if storage ever gets tight; reclaimUnowned() is the
 *  matching refund. */
const OWNED_ONLY = false;

const MAX_BYTES = 8_000_000;
const MIN_BYTES = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return url;
}

/** A URL we should copy: real, absolute, and not already ours — which
 *  covers both mirrored art and member photos in one test, since both
 *  live under our storage host. */
function isThirdParty(url: string | null | undefined, ours: string): boolean {
  return !!url && /^https?:\/\//i.test(url) && !url.startsWith(ours);
}

export interface MirrorRow {
  id: string;
  image_small: string | null;
  image_large: string | null;
  /** Present when the caller already has them; used to re-source artwork
   *  whose URL is permanently dead. Fetched on demand when absent, which is
   *  rare — only a hard failure needs them. */
  name?: string | null;
  number?: string | null;
  /** Admin-curated art is never blanked, whatever the source says. */
  image_locked?: boolean | null;
  /** Failures so far, when the caller selected it. Lets a successful mirror
   *  skip the reset write for the overwhelming majority of cards that never
   *  failed in the first place. */
  art_attempts?: number | null;
}

export interface MirrorBatchResult {
  scanned: number;
  mirrored: number;
  /** Cards passed over because they've failed repeatedly and are in the
   *  retry cool-off. Reported so a stalled-looking sweep can be told from
   *  one that is deliberately not re-trying dead art. */
  skipped?: number;
  failed: Array<{ id: string; reason: string }>;
  /** Cursor for the next batch: the last card id this batch examined. */
  lastId: string | null;
  /** True when the scan reached the end of the cards table. */
  done: boolean;
}

/** Is this failure permanent, or is the source just having a bad day?
 *
 *  The distinction decides everything downstream: a bad day deserves a
 *  retry, a 404 deserves a different source. pokemontcg.io returns hard
 *  404s for whole sets whose images it never published, and retrying those
 *  on every sweep forever is how a fixed number of dead cards turns into an
 *  unbounded amount of work. Timeouts, resets and 5xx are NOT permanent —
 *  treating those as fatal would discard good cards on a bad afternoon. */
function isPermanentFailure(reason: string): boolean {
  // 401 and 403 used to be in this list and are not any more.
  //
  // The consequence of "permanent" is that the card's art URL is eventually
  // erased, so the bar has to be "the file is gone", not "we were refused".
  // A CDN answers 403 for hotlink protection and for rate limiting — both
  // temporary, both about us rather than the file — and treating that as
  // proof of deletion threw away a working URL because we asked too often.
  // 404/410 are the file being gone, 451 is it being legally removed, 400 is
  // a URL that cannot be requested at all, and a non-image response means
  // there is no picture at the other end whatever the status says.
  return /HTTP (?:400|404|410|451)\b/.test(reason) || /not an image/.test(reason);
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: { Accept: "image/*", "User-Agent": "TrainerDeck art mirror" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`served ${contentType || "no content-type"}, not an image`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < MIN_BYTES) throw new Error(`only ${buffer.length} bytes`);
  if (buffer.length > MAX_BYTES) throw new Error(`${Math.round(buffer.length / 1e6)}MB — too large`);
  return { buffer, contentType };
}

function extOf(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

/** Find a live URL for a card whose stored one is gone.
 *
 *  A 404 does not mean the picture doesn't exist — it means the source we
 *  happened to record doesn't have it. TCGdex publishes art for plenty of
 *  what pokemontcg.io never did, the McDonald's promos among them.
 *
 *  FREE SOURCES ONLY, deliberately. This runs inside a loop that ticks
 *  every few minutes over tens of thousands of cards; a paid lookup here
 *  would be an unbudgeted third consumer of the daily credits and could
 *  spend thousands of them on a bad sweep. The paid source still reaches
 *  these cards — see the give-up path below, which clears the dead URL so
 *  the nightly refresher sees an ordinary missing image and fills it under
 *  its own budget.
 *
 *  Null when the free sources don't have it, which is a real answer: some
 *  cards have no published scan, and knowing that is what ends the loop. */
async function resourceArt(
  admin: SupabaseClient,
  row: MirrorRow,
  deadUrls: string[]
): Promise<string | null> {
  let name = row.name ?? null;
  let number = row.number ?? null;
  if (!name) {
    const { data } = await admin
      .from("cards")
      .select("name, number")
      .eq("id", row.id)
      .maybeSingle();
    name = (data?.name as string | null) ?? null;
    number = (data?.number as string | null) ?? null;
  }
  if (!name) return null;

  const free = await findTcgdexImage({ name, number });
  // A source that hands back the same dead URL has told us nothing.
  return free && !deadUrls.includes(free) ? free : null;
}

/** Copy one card's images. Updates only the sides that succeeded — a card
 *  whose large image failed keeps its third-party large URL and stays
 *  eligible for the next run. Exported for the on-demand art route, which
 *  mirrors a card the moment someone first views it. */
export async function mirrorCard(
  admin: SupabaseClient,
  row: MirrorRow,
  ours: string
): Promise<{ ok: boolean; reason?: string }> {
  const safeId = row.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const patch: Record<string, string> = {};
  let firstFailure: string | null = null;

  // Many sources serve one URL for both sizes; download it once.
  const jobs: Array<{ field: "image_small" | "image_large"; url: string }> = [];
  if (isThirdParty(row.image_small, ours)) jobs.push({ field: "image_small", url: row.image_small! });
  if (isThirdParty(row.image_large, ours) && row.image_large !== row.image_small) {
    jobs.push({ field: "image_large", url: row.image_large! });
  }

  for (const job of jobs) {
    try {
      const { buffer, contentType } = await fetchImage(job.url);
      const kind = job.field === "image_small" ? "small" : "large";
      const path = `${safeId}/${kind}.${extOf(contentType)}`;
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType, upsert: true });
      if (error) throw new Error(`storage: ${error.message}`);
      patch[job.field] = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      patch[job.field === "image_small" ? "source_image_small" : "source_image_large"] = job.url;
    } catch (err) {
      firstFailure ??= `${job.url}: ${err instanceof Error ? err.message : "failed"}`;
    }
    await sleep(DOWNLOAD_INTERVAL_MS);
  }

  // The shared-URL case: one download serves both fields.
  if (patch.image_small && row.image_large === row.image_small) {
    patch.image_large = patch.image_small;
    patch.source_image_large = row.image_small!;
  }

  // Nothing downloaded, and the source said the file is GONE rather than
  // busy. Retrying that on the next sweep — which is what used to happen,
  // forever — cannot succeed. Go find the picture somewhere else instead;
  // the card is rendering broken to members until someone does.
  if (Object.keys(patch).length === 0 && firstFailure && isPermanentFailure(firstFailure)) {
    const dead = [row.image_small, row.image_large].filter((u): u is string => !!u);
    const replacement = await resourceArt(admin, row, dead);
    if (replacement) {
      try {
        const { buffer, contentType } = await fetchImage(replacement);
        const path = `${safeId}/small.${extOf(contentType)}`;
        const { error } = await admin.storage
          .from(BUCKET)
          .upload(path, buffer, { contentType, upsert: true });
        if (!error) {
          const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
          patch.image_small = url;
          patch.image_large = url;
          // The replacement is the provenance now — the old URL is a 404
          // and recording it would only send a future re-mirror back to it.
          patch.source_image_small = replacement;
          patch.source_image_large = replacement;
        }
      } catch {
        // The new source didn't pan out either. Fall through and record the
        // failure, which is what stops this card being retried on repeat.
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    const attempts = await recordFailure(admin, row.id, row.art_attempts ?? null);
    // Out of attempts on a URL the source says is GONE, and no free
    // replacement exists. Clear it.
    //
    // A dead URL is strictly worse than no URL. It renders as a broken
    // image to members, it makes every "does this card need art?" check
    // answer no, and it is the reason the paid filler never looked at these
    // cards — they don't *look* like they're missing a picture. Emptying it
    // shows the proper placeholder and hands the card to the nightly
    // refresher, which can spend a credit on it under a real budget.
    //
    // Never for admin-locked art: somebody chose that picture on purpose,
    // and a 404 today is not our licence to erase their choice.
    if (
      attempts >= MAX_ART_ATTEMPTS &&
      firstFailure &&
      isPermanentFailure(firstFailure) &&
      row.image_locked !== true
    ) {
      // The dead URL is KEPT, in the source_image_* columns that already
      // exist to remember where a mirrored picture came from.
      //
      // Clearing image_small without recording what was there destroys the
      // only evidence of which artwork this card is supposed to have — and
      // "the source said 404" is a judgement made by this code from three
      // fetches, not a fact. Writing it aside costs one column and makes the
      // decision reversible; the restore path at revertMirror already reads
      // exactly these columns.
      const { error } = await admin
        .from("cards")
        .update({
          image_small: null,
          image_large: null,
          source_image_small: row.image_small,
          source_image_large: row.image_large,
        })
        .eq("id", row.id);
      if (error) {
        // Older database without the source_ columns: still clear the dead
        // URL, since a broken picture is the thing members actually see.
        await admin
          .from("cards")
          .update({ image_small: null, image_large: null })
          .eq("id", row.id)
          .then(() => {});
      }
    }
    return { ok: false, reason: firstFailure ?? "nothing to mirror" };
  }
  const { error } = await admin.from("cards").update(patch).eq("id", row.id);
  if (error) return { ok: false, reason: `db: ${error.message}` };
  // Only for cards that actually have a history — which is almost none of
  // them, so this stays a no-op write instead of one per mirrored card.
  if ((row.art_attempts ?? 0) > 0) await clearFailure(admin, row.id);
  // A partial success still moved the row forward; report the failed side.
  return firstFailure ? { ok: true, reason: firstFailure } : { ok: true };
}

/** Count a failure so the sweep can stop spending attempts on this card.
 *
 *  Best-effort in the strongest sense: if migration 044 hasn't run, these
 *  columns don't exist and the update fails — and the mirror must carry on
 *  behaving exactly as it did before, retrying everything. Bookkeeping is
 *  never a reason for the actual job to stop working. */
async function recordFailure(
  admin: SupabaseClient,
  id: string,
  known: number | null
): Promise<number> {
  try {
    let current = known;
    if (current == null) {
      const { data } = await admin.from("cards").select("art_attempts").eq("id", id).maybeSingle();
      current = (data?.art_attempts as number | null) ?? 0;
    }
    const attempts = current + 1;
    const { error } = await admin
      .from("cards")
      .update({ art_attempts: attempts, art_failed_at: new Date().toISOString() })
      .eq("id", id);
    // Without the columns there is no counter, so nothing may act on one —
    // returning 0 keeps the give-up path from firing on an unrecorded
    // failure, which would blank art after a single bad fetch.
    if (error) return 0;
    return attempts;
  } catch {
    return 0;
  }
}

/** A card that mirrored is a card with no history worth keeping. */
async function clearFailure(admin: SupabaseClient, id: string): Promise<void> {
  try {
    await admin
      .from("cards")
      .update({ art_attempts: 0, art_failed_at: null })
      .eq("id", id)
      .then(() => {});
  } catch {
    // As above.
  }
}

/** Give up on a card after this many consecutive failures… */
const MAX_ART_ATTEMPTS = 3;
/** …and try it again this long afterwards. A cool-off rather than a
 *  tombstone: sources do add missing scans, and a card nobody can picture
 *  today may be pictured next month. Thirty days is short enough to catch
 *  that and long enough that dead sets stop costing anything. */
const ART_RETRY_AFTER_DAYS = 30;

/** The columns the scan wants, including the two that only exist after
 *  migration 044. Selected as one string so the fallback below can swap it
 *  wholesale rather than rebuilding the query. */
const SCAN_COLUMNS =
  "id, image_small, image_large, name, number, image_locked, art_attempts, art_failed_at";
const SCAN_COLUMNS_LEGACY = "id, image_small, image_large, name, number, image_locked";

/** True when an error is Postgres saying a column doesn't exist. */
function isMissingColumn(message: string): boolean {
  return /art_attempts|art_failed_at/.test(message);
}

export async function mirrorBatch(
  admin: SupabaseClient,
  after: string | null
): Promise<MirrorBatchResult> {
  const ours = supabaseUrl();
  const coolOff = new Date(
    Date.now() - ART_RETRY_AFTER_DAYS * 24 * 3600_000
  ).toISOString();
  let rows: MirrorRow[];
  if (OWNED_ONLY) {
    // The work list is what people own. Read it whole (a few thousand rows
    // at most), sort it so the cursor means something, and take the slice
    // after the cursor — the same resumable walk, over a smaller world.
    const { data: owned } = await fetchAllRows<{ card_id: string }>(() =>
      admin.from("collection_items").select("card_id").order("card_id")
    );
    const ids = [...new Set((owned ?? []).map((r) => r.card_id))]
      .sort()
      .filter((id) => !after || id > after)
      .slice(0, SCAN_WINDOW);
    if (ids.length === 0) {
      return { scanned: 0, mirrored: 0, failed: [], lastId: null, done: true };
    }
    const chunks: MirrorRow[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      const load = async (columns: string) => {
        const { data, error } = await admin
          .from("cards")
          .select(columns)
          .in("id", slice)
          .order("id");
        return { data: data as unknown as MirrorRow[] | null, error };
      };
      let { data, error } = await load(SCAN_COLUMNS);
      if (error && isMissingColumn(error.message)) ({ data, error } = await load(SCAN_COLUMNS_LEGACY));
      chunks.push(...(data ?? []));
    }
    rows = chunks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    const build = async (columns: string) => {
      let q = admin.from("cards").select(columns).order("id").limit(SCAN_WINDOW);
      if (after) q = q.gt("id", after);
      const { data, error } = await q;
      return { data: data as unknown as MirrorRow[] | null, error };
    };
    let { data, error } = await build(SCAN_COLUMNS);
    if (error && isMissingColumn(error.message)) {
      // Migration 044 hasn't run. Fall back to the old behaviour rather
      // than stopping: retrying dead cards forever is the bug we're fixing,
      // but it beats not mirroring anything at all.
      ({ data, error } = await build(SCAN_COLUMNS_LEGACY));
    }
    if (error) throw new Error(error.message);
    rows = (data ?? []) as unknown as MirrorRow[];
  }

  // Cards in cool-off are dropped from the work list rather than filtered
  // in SQL, so the cursor still advances past them — filtering in the query
  // would make every scan re-walk the same dead rows to find live ones.
  const skippable = (row: MirrorRow & { art_failed_at?: string | null }) =>
    (row.art_attempts ?? 0) >= MAX_ART_ATTEMPTS &&
    typeof row.art_failed_at === "string" &&
    row.art_failed_at > coolOff;

  let mirrored = 0;
  let attempts = 0;
  let skipped = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  let lastId: string | null = after;
  let examinedAll = true;

  for (const row of rows) {
    const needs =
      isThirdParty(row.image_small, ours) || isThirdParty(row.image_large, ours);
    if (needs && skippable(row)) {
      skipped++;
      lastId = row.id;
      continue;
    }
    if (needs) {
      // The cap counts ATTEMPTS, not successes — on a day the source is
      // down, counting successes would grind through the whole scan
      // window at one download-timeout per card before returning.
      if (attempts >= MIRROR_PER_BATCH) {
        // Batch is full; the cursor stops BEFORE this card so the next
        // batch picks it up.
        examinedAll = false;
        break;
      }
      attempts++;
      const result = await mirrorCard(admin, row, ours);
      if (result.ok) mirrored++;
      if (!result.ok || result.reason) {
        failed.push({ id: row.id, reason: result.reason ?? "failed" });
      }
    }
    lastId = row.id;
  }

  return {
    scanned: rows.length,
    mirrored,
    skipped,
    failed,
    lastId,
    done: examinedAll && rows.length < SCAN_WINDOW,
  };
}

/* ------------------------------------------------------------- reclaim */

export interface ReclaimResult {
  examined: number;
  reverted: number;
  filesRemoved: number;
  done: boolean;
  cursor: string | null;
}

/** Give back the space spent on cards nobody owns.
 *
 *  The full-catalogue sweep mirrored thousands of cards no member holds.
 *  Turning the sweep off stops the growth but doesn't refund it — this
 *  does: for each mirrored card that nobody owns, point the row back at
 *  the source URL we kept in source_image_* and delete the stored files.
 *
 *  Nothing is lost. The source URL is where the picture came from, so the
 *  card renders exactly as it did before it was ever mirrored, and if
 *  anyone views it the /art route mirrors it again on the spot. Rows with
 *  no source URL on file are left alone — reverting those would blank a
 *  card, and a blank card is worse than a byte of storage.
 */
export async function reclaimUnowned(
  admin: SupabaseClient,
  cursor: string | null,
  budget = 300
): Promise<ReclaimResult> {
  const ours = supabaseUrl();
  const mirroredPrefix = `${ours}/storage/v1/object/public/${BUCKET}/`;

  const { data: owned } = await fetchAllRows<{ card_id: string }>(() =>
    admin.from("collection_items").select("card_id").order("card_id")
  );
  const ownedIds = new Set((owned ?? []).map((r) => r.card_id));

  let q = admin
    .from("cards")
    .select("id, image_small, image_large, source_image_small, source_image_large, image_locked")
    .like("image_small", `${mirroredPrefix}%`)
    .order("id")
    .limit(budget);
  if (cursor) q = q.gt("id", cursor);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    image_small: string | null;
    image_large: string | null;
    source_image_small: string | null;
    source_image_large: string | null;
    image_locked: boolean | null;
  }>;

  let reverted = 0;
  let filesRemoved = 0;
  let last: string | null = cursor;
  const paths: string[] = [];

  for (const row of rows) {
    last = row.id;
    if (ownedIds.has(row.id)) continue;
    // An admin chose this picture deliberately; it isn't ours to undo.
    if (row.image_locked === true) continue;
    if (!row.source_image_small) continue;

    const { error: upErr } = await admin
      .from("cards")
      .update({
        image_small: row.source_image_small,
        image_large: row.source_image_large ?? row.source_image_small,
        source_image_small: null,
        source_image_large: null,
      })
      .eq("id", row.id);
    if (upErr) continue;
    reverted++;

    // Delete AFTER the row stops pointing at the file, never before: the
    // other order leaves a window where the card renders a 404.
    for (const url of [row.image_small, row.image_large]) {
      if (url && url.startsWith(mirroredPrefix)) {
        const path = url.slice(mirroredPrefix.length).split("?")[0];
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
  }

  for (let i = 0; i < paths.length; i += 100) {
    const { data: removed } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    filesRemoved += removed?.length ?? 0;
  }

  return {
    examined: rows.length,
    reverted,
    filesRemoved,
    done: rows.length < budget,
    cursor: last,
  };
}

// --- The background loop -------------------------------------------------
//
// The mirror runs itself: a self-scheduling loop on the long-lived Railway
// process, same pattern as the price refresher. While there's a backlog it
// chews through ~100 cards every few minutes (a fresh catalogue takes
// about a day); once a full pass finds the catalogue clean it drops to a
// six-hour sweep that catches whatever new imports brought in. The admin
// panel stays as a window into it, and its button just runs a burst on
// demand — nothing depends on anyone pressing it.

const STATE_KEY = "art_mirror";

/** Batches per background run: ~100 attempted cards, a few minutes — long
 *  enough to make progress, short enough that a restart loses little and
 *  the run finishes well inside the claim window. */
const BATCHES_PER_RUN = 5;
const TICK_MS = 10 * 60_000;
const BACKLOG_GAP_MS = 8 * 60_000;
const IDLE_GAP_MS = 6 * 3600_000;

export interface MirrorLoopState {
  /** Where the current pass has scanned to; null between passes. */
  cursor: string | null;
  ranAt?: string;
  lastRunMirrored?: number;
  lastRunFailed?: number;
  mirroredTotal?: number;
  /** True while a pass is mid-catalogue — the loop runs hot until a full
   *  pass completes, then coasts. */
  backlog?: boolean;
  lastError?: string | null;
}

export async function readMirrorLoopState(admin: SupabaseClient): Promise<MirrorLoopState | null> {
  try {
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    const value = data?.value as MirrorLoopState | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function startArtMirrorLoop() {
  const tick = async () => {
    try {
      const admin = createAdminClient();
      const state = (await readMirrorLoopState(admin)) ?? { cursor: null };
      // Hot while there's known work; a long coast once a pass came back
      // clean. Never-ran counts as backlog — the first pass IS the work.
      const gap = state.backlog === false ? IDLE_GAP_MS : BACKLOG_GAP_MS;
      const cutoff = new Date(Date.now() - gap).toISOString();
      // Ensure the row exists, then claim it only if it's stale — zero rows
      // updated means another instance (or a recent run) beat us to it.
      await admin
        .from("app_state")
        .upsert({ key: STATE_KEY }, { onConflict: "key", ignoreDuplicates: true })
        .then(() => {});
      const { data: claimed, error } = await admin
        .from("app_state")
        .update({ updated_at: new Date().toISOString() })
        .eq("key", STATE_KEY)
        .lt("updated_at", cutoff)
        .select("key");
      if (error || !claimed || claimed.length === 0) return;

      let cursor = state.cursor ?? null;
      let mirrored = 0;
      let failedCount = 0;
      let skippedCount = 0;
      const failureSamples: string[] = [];
      let done = false;
      let lastError: string | null = null;
      try {
        for (let i = 0; i < BATCHES_PER_RUN; i++) {
          const result = await mirrorBatch(admin, cursor);
          mirrored += result.mirrored;
          failedCount += result.failed.length;
          skippedCount += result.skipped ?? 0;
          // The reasons, not just the count — "12 failed" is the same line
          // whether the source is down or the URLs are dead, and those want
          // opposite responses.
          for (const f of result.failed) {
            if (failureSamples.length < 5) failureSamples.push(`${f.id}: ${f.reason}`);
          }
          cursor = result.lastId;
          if (result.done) {
            done = true;
            cursor = null; // next pass starts from the top
            break;
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      const next: MirrorLoopState = {
        cursor,
        ranAt: new Date().toISOString(),
        lastRunMirrored: mirrored,
        lastRunFailed: failedCount,
        mirroredTotal: (state.mirroredTotal ?? 0) + mirrored,
        // A completed pass means coast — even if some cards failed, they
        // stay hotlinked and the six-hour sweep retries them; running hot
        // on a permanently dead source would just hammer it.
        backlog: !done,
        lastError,
      };
      await admin
        .from("app_state")
        .upsert({ key: STATE_KEY, value: next, updated_at: new Date().toISOString() })
        .then(() => {});
      if (mirrored > 0 || failedCount > 0 || lastError) {
        console.log(
          `art mirror: ${mirrored} mirrored, ${failedCount} failed` +
            (skippedCount > 0 ? `, ${skippedCount} skipped (dead art, in cool-off)` : "") +
            (done ? " — pass complete" : "") +
            (lastError ? ` — ERROR: ${lastError}` : "") +
            (failureSamples.length > 0 ? ` · e.g. ${failureSamples.join(" | ")}` : "")
        );
      }
    } catch (err) {
      console.error("art mirror loop error", err);
    }
  };
  // First run shortly after boot, then steadily.
  setTimeout(tick, 150_000);
  setInterval(tick, TICK_MS);
}

export interface MirrorStatus {
  withImages: number;
  /** Cards whose images already live in our storage (mirrored art or a
   *  member photo — both count as "ours"). */
  ours: number;
  remaining: number;
}

export async function mirrorStatus(admin: SupabaseClient): Promise<MirrorStatus> {
  const oursPrefix = `${supabaseUrl()}%`;
  const [withImages, remainLarge, remainSmallOnly] = await Promise.all([
    admin
      .from("cards")
      .select("id", { count: "exact", head: true })
      .or("image_small.not.is.null,image_large.not.is.null"),
    admin
      .from("cards")
      .select("id", { count: "exact", head: true })
      .not("image_large", "is", null)
      .not("image_large", "ilike", oursPrefix),
    admin
      .from("cards")
      .select("id", { count: "exact", head: true })
      .is("image_large", null)
      .not("image_small", "is", null)
      .not("image_small", "ilike", oursPrefix),
  ]);
  const total = withImages.count ?? 0;
  const remaining = (remainLarge.count ?? 0) + (remainSmallOnly.count ?? 0);
  return { withImages: total, ours: Math.max(0, total - remaining), remaining };
}
