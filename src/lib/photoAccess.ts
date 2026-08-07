// Deciding who may look at a member's photograph, and minting the link.
//
// The card-photos bucket is private (migration 054), so every view goes
// through here. Two questions, kept apart because they have different
// answers:
//
//   May this person see this object?  — depends on what the object IS.
//   What link do we hand them?        — a signed URL that expires.
//
// The access rule follows the app's own idea of what a photo is for:
//
//   * Your own folder is yours. Covers the front and back of a card you
//     submitted for grading, a photo you attached and later replaced, and
//     the picture the scanner took thirty seconds ago and hasn't saved yet.
//
//   * A photo that became a card's picture in the shared catalogue is
//     shared. That is the whole point of it: somebody photographed a promo
//     no database has, and now everyone who owns that promo can see it.
//     Restricting those to the uploader would blank out exactly the cards
//     this feature exists to cover.
//
//   * Admins see everything, because the image-review queue is a list of
//     other people's uploads and reviewing it is the job.
//
// Anything else is a 403 — most importantly, another member's grading
// photos, which are in their folder and are not any card's picture.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CARD_PHOTO_BUCKET, cardPhotoPath, isCardPhotoUrl } from "@/lib/photoUrl";

type Admin = SupabaseClient;

/** How long a link lives. Long enough that a slow page finishes loading
 *  its grid, short enough that a URL copied out of the network tab is
 *  rubbish by the time anyone uses it. */
export const PHOTO_TTL_SECONDS = 3600;

/** Signed URLs, remembered until they are nearly stale.
 *
 *  A collection grid asks for fifty photos at once and re-asks on every
 *  navigation; without this, that is fifty storage round-trips each time.
 *  Keyed by object path, so two members looking at the same shared card art
 *  ride the same signature — which is fine, because the decision about
 *  whether they may have it happened before we got here. */
const signed = new Map<string, { url: string; expires: number }>();
const MAX_MEMO = 2000;
/** Re-sign this long before expiry, so a link handed out at the last
 *  moment still has time on it when the browser follows the redirect. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Sign a stored card-photo URL. Anything that isn't one of ours — mirrored
 *  card art, a third-party database's image, a data: URL — comes back
 *  untouched, so callers can pass whatever they hold. Returns the original
 *  URL if signing fails: a photo that won't load is better than a caller
 *  that throws. */
export async function signCardPhoto(
  admin: Admin,
  url: string | null | undefined,
  ttlSeconds = PHOTO_TTL_SECONDS
): Promise<string | null> {
  if (!url) return url ?? null;
  const path = cardPhotoPath(url);
  if (!path) return url;

  const now = Date.now();
  // Only the standard TTL is memoised. An export asking for a week-long
  // link must not be served an hour-long one out of the cache, nor leave a
  // week-long one behind for the next page view.
  const memo = ttlSeconds === PHOTO_TTL_SECONDS ? signed.get(path) : undefined;
  if (memo && memo.expires - REFRESH_MARGIN_MS > now) return memo.url;

  const { data, error } = await admin.storage
    .from(CARD_PHOTO_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) return url;

  if (ttlSeconds === PHOTO_TTL_SECONDS) {
    if (signed.size >= MAX_MEMO) signed.clear();
    signed.set(path, { url: data.signedUrl, expires: now + ttlSeconds * 1000 });
  }
  return data.signedUrl;
}

/** How many objects to sign per storage round-trip. */
const SIGN_CHUNK = 100;

/** Sign several at once, preserving order and nulls.
 *
 *  One request per hundred objects rather than one per object: the grading
 *  export signs both sides of every report it emits, which at ten thousand
 *  rows is twenty thousand signatures and would be twenty thousand HTTP
 *  calls done the obvious way. */
export async function signCardPhotos(
  admin: Admin,
  urls: Array<string | null | undefined>,
  ttlSeconds = PHOTO_TTL_SECONDS
): Promise<Array<string | null>> {
  const out: Array<string | null> = urls.map((u) => u ?? null);
  const memoise = ttlSeconds === PHOTO_TTL_SECONDS;
  const now = Date.now();

  // Which of them actually need signing, and at which output positions.
  const wanted = new Map<string, number[]>();
  urls.forEach((url, i) => {
    const path = cardPhotoPath(url);
    if (!path) return;
    const memo = memoise ? signed.get(path) : undefined;
    if (memo && memo.expires - REFRESH_MARGIN_MS > now) {
      out[i] = memo.url;
      return;
    }
    const at = wanted.get(path);
    if (at) at.push(i);
    else wanted.set(path, [i]);
  });
  if (wanted.size === 0) return out;

  const paths = [...wanted.keys()];
  for (let i = 0; i < paths.length; i += SIGN_CHUNK) {
    const chunk = paths.slice(i, i + SIGN_CHUNK);
    const { data } = await admin.storage
      .from(CARD_PHOTO_BUCKET)
      .createSignedUrls(chunk, ttlSeconds);
    for (const row of data ?? []) {
      // Matched by path rather than by position: a chunk where one object
      // is missing must not shift every link after it onto the wrong photo.
      const at = row.path ? wanted.get(row.path) : undefined;
      if (!at || !row.signedUrl) continue;
      for (const idx of at) out[idx] = row.signedUrl;
      if (memoise) {
        if (signed.size >= MAX_MEMO) signed.clear();
        signed.set(row.path!, { url: row.signedUrl, expires: now + ttlSeconds * 1000 });
      }
    }
  }
  return out;
}

/** May this person see this photograph? See the rule at the top of the file. */
export async function mayViewCardPhoto(
  admin: Admin,
  url: string,
  userId: string,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true;
  if (!isCardPhotoUrl(url)) return false;

  const path = cardPhotoPath(url);
  if (!path) return false;
  if (path.split("/")[0] === userId) return true;

  // Is it a card's picture? Two equality checks rather than one .or(): the
  // URL is interpolated into a PostgREST filter either way, and eq() quotes
  // it for us where or() would not.
  for (const column of ["image_small", "image_large"] as const) {
    const { data } = await admin.from("cards").select("id").eq(column, url).limit(1);
    if (data && data.length > 0) return true;
  }
  return false;
}
