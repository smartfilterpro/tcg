// Recognising a member photo by its URL.
//
// Photos live in the private card-photos bucket, but what gets STORED —
// in cards.image_small, in grade_reports.front_url, in
// card_image_candidates.url — is the bucket's public-form URL:
//
//   https://<project>.supabase.co/storage/v1/object/public/card-photos/<uid>/<uuid>.jpg
//
// That URL no longer resolves on its own, and deliberately so. It is an
// identifier, not a link: stable, self-describing, already written into
// thousands of rows, and the thing half the codebase already tests with
// .includes("/card-photos/") to tell a member's photograph apart from
// mirrored database artwork. Signing happens at read time instead, so a
// link that leaves the app is dead within the hour.
//
// Isomorphic on purpose — the client needs isCardPhotoUrl to decide what
// to point an <img> at, the server needs cardPhotoPath to sign it.

export const CARD_PHOTO_BUCKET = "card-photos";

const PUBLIC_MARK = `/storage/v1/object/public/${CARD_PHOTO_BUCKET}/`;
const SIGN_MARK = `/storage/v1/object/sign/${CARD_PHOTO_BUCKET}/`;

/** Is this stored URL a photograph one of our members took? */
export function isCardPhotoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes(PUBLIC_MARK) || url.includes(SIGN_MARK);
}

/** The object's path within the bucket ("<uid>/<uuid>.jpg"), or null if the
 *  URL isn't one of ours. Query strings are dropped — an already-signed URL
 *  carries its token there, and re-signing it should start from the object,
 *  not from somebody else's expiry. */
export function cardPhotoPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const mark = url.includes(PUBLIC_MARK) ? PUBLIC_MARK : url.includes(SIGN_MARK) ? SIGN_MARK : null;
  if (!mark) return null;
  const tail = url.slice(url.indexOf(mark) + mark.length).split("?")[0];
  if (!tail) return null;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** The folder a photo sits in, which is the id of whoever uploaded it. */
export function cardPhotoOwner(url: string | null | undefined): string | null {
  const path = cardPhotoPath(url);
  if (!path) return null;
  const owner = path.split("/")[0];
  return owner || null;
}
