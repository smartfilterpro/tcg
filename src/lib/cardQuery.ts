/** Parsing for the manual card-lookup box. Lives here rather than in the
 *  route so it can be exercised directly — a route file may only export
 *  HTTP handlers. */

export interface ParsedCardQuery {
  name?: string;
  number?: string;
  printedTotal?: string;
  setName?: string;
}

/** Parse a free-form query into name / collector-number / set-size parts.
 *  Supported shapes:
 *    "101/190", "095/086"  → number in a set of that size (zeros OK)
 *    "095/SVP"             → promo-set code after the slash
 *    "#101" or "101"       → number in any set
 *    "TG12/TG30", "SWSH095"→ alphanumeric promo/gallery numbers
 *    "Charizard 4/102"     → name + number + set size
 *    "Charizard"           → name only
 */
export function parseCardQuery(raw: string): ParsedCardQuery {
  const q = raw.trim();

  // "number/total" — optionally preceded by a name, e.g. "Charizard 4/102".
  // The part after the slash is either a set size ("190") or a promo-set
  // code ("SVP", "SWSH", "SM").
  const slash = q.match(/^(.*?)[\s#]*([A-Za-z]{0,4}\d{1,4}[a-z]?)\s*\/\s*([A-Za-z0-9]{1,8})$/);
  if (slash) {
    const name = slash[1].trim();
    const after = slash[3];
    const digitsInAfter = after.replace(/\D/g, "");
    return {
      name: name || undefined,
      number: slash[2],
      printedTotal: digitsInAfter ? digitsInAfter : undefined,
      setName: digitsInAfter ? undefined : after, // "SVP" → search promo sets by name
    };
  }

  // "#101" — explicit number, any set
  const hash = q.match(/^#\s*([A-Za-z]{0,4}\d{1,4}[a-z]?)$/);
  if (hash) return { number: hash[1] };

  // Bare number (or promo codes like "TG12", "SWSH095") — nothing else it could be
  const bare = q.match(/^#?\s*([A-Za-z]{0,4}\d{1,4}[a-z]?)$/);
  if (bare && /\d/.test(q) && !/^[A-Za-z]+\d$/.test(q)) {
    // exclude names ending in a digit like "Porygon2" (letters+single digit)
    return { number: bare[1] };
  }

  // "name number" WITHOUT a slash — e.g. "Gengar 073", "Pikachu SWSH061",
  // "Mew #25". The number token needs 2+ digits, a letter prefix, or a "#"
  // so names like "Porygon2" or "Blastoise 2" aren't misparsed.
  const trailing = q.match(/^(.+?)\s+#?([A-Za-z]{0,4}\d{1,4}[a-z]?)$/);
  if (trailing) {
    const numTok = trailing[2];
    const looksLikeNumber =
      /\d{2,}/.test(numTok) || /^[A-Za-z]+\d+/.test(numTok) || q.includes("#");
    if (looksLikeNumber && /\d/.test(numTok)) {
      return { name: trailing[1].trim(), number: numTok };
    }
  }

  return { name: q };
}
