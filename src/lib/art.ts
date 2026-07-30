/** Which src should an <img> use for a card?
 *
 *  A card whose image already lives in our storage (mirrored art, member
 *  photo) renders it directly. A card still pointing at a third-party host
 *  renders /api/cards/[id]/art instead, which mirrors the picture into our
 *  storage in passing and redirects — so the first person to look at a
 *  card is the reason we stop depending on the third party for it. The
 *  background sweep (artMirror) catches everything nobody happened to view.
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
  const ours = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (ours && url.startsWith(ours)) return url;
  if (!cardId) return url;
  return `/api/cards/${encodeURIComponent(cardId)}/art?size=${size}`;
}
