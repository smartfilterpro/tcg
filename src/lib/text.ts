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

/** Does any of the given fields contain the query, punctuation/accent-blind? */
export function matchesSearch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  return fields.some((f) => f != null && normalizeForSearch(f).includes(q));
}
