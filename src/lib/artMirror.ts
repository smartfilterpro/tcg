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
// wherever it left off. Cards it can't fetch stay pointed at the source —
// nothing is ever blanked — and remain eligible for the next run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";

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
}

export interface MirrorBatchResult {
  scanned: number;
  mirrored: number;
  failed: Array<{ id: string; reason: string }>;
  /** Cursor for the next batch: the last card id this batch examined. */
  lastId: string | null;
  /** True when the scan reached the end of the cards table. */
  done: boolean;
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

  if (Object.keys(patch).length === 0) {
    return { ok: false, reason: firstFailure ?? "nothing to mirror" };
  }
  const { error } = await admin.from("cards").update(patch).eq("id", row.id);
  if (error) return { ok: false, reason: `db: ${error.message}` };
  // A partial success still moved the row forward; report the failed side.
  return firstFailure ? { ok: true, reason: firstFailure } : { ok: true };
}

export async function mirrorBatch(
  admin: SupabaseClient,
  after: string | null
): Promise<MirrorBatchResult> {
  const ours = supabaseUrl();
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
      const { data } = await admin
        .from("cards")
        .select("id, image_small, image_large")
        .in("id", ids.slice(i, i + 200))
        .order("id");
      chunks.push(...((data ?? []) as MirrorRow[]));
    }
    rows = chunks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    let q = admin
      .from("cards")
      .select("id, image_small, image_large")
      .order("id")
      .limit(SCAN_WINDOW);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows = (data ?? []) as MirrorRow[];
  }

  let mirrored = 0;
  let attempts = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  let lastId: string | null = after;
  let examinedAll = true;

  for (const row of rows) {
    const needs =
      isThirdParty(row.image_small, ours) || isThirdParty(row.image_large, ours);
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
      let done = false;
      let lastError: string | null = null;
      try {
        for (let i = 0; i < BATCHES_PER_RUN; i++) {
          const result = await mirrorBatch(admin, cursor);
          mirrored += result.mirrored;
          failedCount += result.failed.length;
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
            (done ? " — pass complete" : "") +
            (lastError ? ` — ERROR: ${lastError}` : "")
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
