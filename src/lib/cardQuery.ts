/** Parsing for the manual card-lookup box. Lives here rather than in the
 *  route so it can be exercised directly — a route file may only export
 *  HTTP handlers. */

/** A collector number as stored, comparable: "073" and "73" and "73/86" all
 *  reduce to the same thing, while "112a" keeps its letter — that suffix
 *  marks an alternate printing and collapsing it would match the wrong card. */
function numKey(n: string | null | undefined): string {
  return (n ?? "")
    .split("/")[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^0-9])0+(?=\d)/g, "$1");
}

/** Does a card match a query written the way the number is PRINTED on it?
 *
 *  "73/86" is what a person reads off the card, and it matched nothing: the
 *  collection's search is a token match over name, set and number, and the
 *  number column holds "73" while the set size lives in another column
 *  entirely. So the one string on the card that uniquely identifies it was
 *  the one string that couldn't find it.
 *
 *  Deliberately narrow, and used as an OR alongside the ordinary token
 *  match: only the slash form gets here, so nothing that finds a card today
 *  stops finding it. A set size we don't hold (null) matches anything —
 *  the number is doing the work, and the size can only refute, never
 *  confirm. */
export function matchesPrintedNumber(
  query: string,
  card: { name?: string | null; number?: string | null; printedTotal?: number | null }
): boolean {
  const parsed = parseCardQuery(query);
  if (!parsed.number || !parsed.printedTotal) return false;

  const wanted = numKey(parsed.number);
  if (!wanted || numKey(card.number) !== wanted) return false;

  const total = Number(parsed.printedTotal);
  if (Number.isFinite(total) && card.printedTotal != null && card.printedTotal !== total) {
    return false;
  }

  // "Dragonair 73/86" — the name still has to be the card's.
  if (parsed.name) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm(card.name ?? "").includes(norm(parsed.name))) return false;
  }
  return true;
}

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
  let q = raw.trim();

  // "set:" — an explicit set filter, anywhere in the query.
  //
  // Set names are the one thing this parser could never be taught to guess.
  // "Trick or Trade BOOster Bundle 2024" is four words of ordinary English
  // and a year; nothing about it says "set" rather than "card called Trick
  // or Trade". So the query says so, and everything before and after the
  // marker is still parsed as normal — "Pikachu set:Trick or Trade" narrows
  // a name to a set, and "set:Trick or Trade" alone lists the set.
  //
  // The set name runs to the end of the query rather than to the next space,
  // because set names have spaces in them and quoting is a thing nobody
  // should have to do on a phone keyboard.
  const setMarker = q.match(/(^|\s)set\s*:\s*(.+)$/i);
  let setName: string | undefined;
  if (setMarker) {
    setName = setMarker[2].trim() || undefined;
    q = q.slice(0, setMarker.index).trim();
    // Nothing left but the set: list it.
    if (!q) return { setName };
  }
  const withSet = (parsed: ParsedCardQuery): ParsedCardQuery =>
    setName ? { ...parsed, setName } : parsed;

  // "number/total" — optionally preceded by a name, e.g. "Charizard 4/102".
  // The part after the slash is either a set size ("190") or a promo-set
  // code ("SVP", "SWSH", "SM").
  const slash = q.match(/^(.*?)[\s#]*([A-Za-z]{0,4}\d{1,4}[a-z]?)\s*\/\s*([A-Za-z0-9]{1,8})$/);
  if (slash) {
    const name = slash[1].trim();
    const after = slash[3];
    const digitsInAfter = after.replace(/\D/g, "");
    return withSet({
      name: name || undefined,
      number: slash[2],
      printedTotal: digitsInAfter ? digitsInAfter : undefined,
      // "SVP" → search promo sets by name. An explicit set: wins over it,
      // since the person typed that one out.
      ...(digitsInAfter ? {} : { setName: after }),
    });
  }

  // "#101" — explicit number, any set
  const hash = q.match(/^#\s*([A-Za-z]{0,4}\d{1,4}[a-z]?)$/);
  if (hash) return withSet({ number: hash[1] });

  // Bare number (or promo codes like "TG12", "SWSH095") — nothing else it could be
  const bare = q.match(/^#?\s*([A-Za-z]{0,4}\d{1,4}[a-z]?)$/);
  if (bare && /\d/.test(q) && !/^[A-Za-z]+\d$/.test(q)) {
    // exclude names ending in a digit like "Porygon2" (letters+single digit)
    return withSet({ number: bare[1] });
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
      return withSet({ name: trailing[1].trim(), number: numTok });
    }
  }

  return withSet({ name: q });
}
