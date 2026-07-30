// Member avatars: two initials on a coloured circle, the pattern the
// artboards use everywhere a person appears (trade posts, comments, the app
// bar, family settings).

/** The artboard's avatar palette. Deliberately small so a board full of
 *  members still reads as one design rather than a colour wheel. */
export const AVATAR_COLORS = [
  "#2C5CFF",
  "#E0A21A",
  "#1F7A43",
  "#7A6BD8",
  "#D8452F",
  "#16171B",
];

/** Up to two initials, from a display name if there is one and the local
 *  part of the email if there isn't. Splits on spaces, dots, underscores and
 *  hyphens so "ada.lovelace@…" reads AL rather than AD. */
export function initialsFor(
  name: string | null | undefined,
  email?: string | null | undefined
): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (
    parts
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "T"
  );
}

/** A stable colour for a person, hashed from their id.
 *
 *  Hashed rather than assigned by position so the same member wears the same
 *  colour on every screen — a trade post, its replies and the friends list
 *  all agree, which is what makes the circles readable as identity at all. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
