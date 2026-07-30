/** Normalize a string for forgiving search comparisons: lowercase, strip
 *  accents (e.g. \u00e9 -> e), and drop everything that isn't a letter or
 *  digit. So "Pikach\u00fa", "Pika chu", and "PIKACHU!" all normalize to
 *  "pikachu". */
export function normalizeForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Compact relative time for timestamps that sit beside a name — "2h",
 *  "yesterday", "3 days", the shapes the artboards use. Falls back to a date
 *  once something is old enough that "47 days" stops being informative. */
export function shortAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const mins = Math.round((now.getTime() - then.getTime()) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Token-based, punctuation/accent-blind matching: every word of the query
 *  must appear somewhere in the combined fields — in any order, and words
 *  can hit different fields ("pikachu 151" matches name + set name). */
export function matchesSearch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const tokens = query.split(/\s+/).map(normalizeForSearch).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = fields
    .filter((f): f is string => f != null)
    .map(normalizeForSearch)
    .join(" ");
  return tokens.every((t) => haystack.includes(t));
}
