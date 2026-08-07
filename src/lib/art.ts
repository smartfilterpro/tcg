import { isCardPhotoUrl } from "@/lib/photoUrl";

/** Which src should an <img> use for a photograph a member took?
 *
 *  Never the stored URL: the card-photos bucket is private (054), so that
 *  address resolves to nothing. /api/photo checks who is asking before
 *  handing out a link that expires. Anything that isn't a member photo —
 *  mirrored art, a card database's own CDN, a blob: preview — passes
 *  straight through, so this is safe to wrap around any image URL.
 */
export function photoSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!isCardPhotoUrl(url)) return url;
  return `/api/photo?u=${encodeURIComponent(url)}`;
}

/** Which src should an <img> use for a card?
 *
 *  A card whose picture is a member's photograph goes through /api/photo.
 *  A card whose picture is already mirrored into our public card-art bucket
 *  renders it directly. A card still pointing at a third-party host renders
 *  /api/cards/[id]/art instead, which mirrors the picture into our storage
 *  in passing and redirects — so the first person to look at a card is the
 *  reason we stop depending on the third party for it. The background sweep
 *  (artMirror) catches everything nobody happened to view.
 *
 *  Client-safe: NEXT_PUBLIC_SUPABASE_URL is inlined at build time.
 */
export function artSrc(
  cardId: string | null | undefined,
  url: string | null | undefined,
  size: "small" | "large" = "small"
): string | null {
  if (!url) return null;
  // Relative and data: URLs aren't hotlinks; leave them be.
  if (!/^https?:\/\//i.test(url)) return url;
  if (isCardPhotoUrl(url)) return photoSrc(url);
  const ours = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (ours && url.startsWith(ours)) return url;
  if (!cardId) return url;
  return `/api/cards/${encodeURIComponent(cardId)}/art?size=${size}`;
}
