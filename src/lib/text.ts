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
