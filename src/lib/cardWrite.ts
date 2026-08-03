// Writing a card record without losing what we already know.
//
// Four different jobs write to the cards table from four different sources —
// the pokemontcg.io catalogue import, the paid Pokémon Price Tracker sync, a
// TCGplayer price dump, and a member saving a scan. That is not the problem,
// and consolidating on one source would make coverage worse rather than
// better: each carries cards and fields the others don't.
//
// The problem was that each of those writers independently had to remember a
// rule, and one of them forgot. The rule is:
//
//     AN API THAT HAS NO VALUE FOR A FIELD IS NOT TELLING US THE FIELD IS
//     EMPTY. IT IS TELLING US IT DOESN'T KNOW.
//
// Miss that distinction and a full-record upsert becomes a delete. It did:
// pokemontcg.io carries no TCGplayer price for a large part of the catalogue,
// summaryToRow duly emitted market_price: null, and PostgREST's ON CONFLICT
// assigned it over prices three other sources had found. The import loop runs
// continuously, so it blanked prices across the whole table faster than the
// nightly refresh could put them back.
//
// The catalogue import had the right reasoning written into it for artwork,
// and never applied it to price. That is what a remembered rule does. This
// module is the same rule as a function, so the next writer gets it without
// having to know the history.

/** Columns the cards table declares NOT NULL. Never stripped: an insert
 *  missing one should fail loudly rather than half-succeed. */
export const CARD_REQUIRED_COLUMNS = new Set(["id", "name", "number", "set_id", "set_name"]);

/** Does this value carry information, or is it just the shape of a field the
 *  source had nothing for?
 *
 *  A price map of all-nulls is the case worth spelling out. `{"normal": null}`
 *  is not null, so a plain null check waves it through — and writing it over
 *  a real map loses exactly as much as writing null would, by a route that
 *  looks like it passed the guard. */
export function carriesData(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    return values.length > 0 && values.some((v) => v != null);
  }
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** The columns of `row` that would overwrite something with nothing.
 *
 *  Returned rather than applied, because a bulk upsert can't vary its columns
 *  per row: the caller groups rows by this list and issues one upsert per
 *  group, so every row in a group omits the same columns. */
export function emptyColumns(
  row: Record<string, unknown>,
  opts?: {
    /** Columns that ride along with another: omit `price_updated_at` when the
     *  price is omitted, or the row claims to have been priced just now and
     *  sinks to the back of a refresh queue sorted on that stamp. */
    companions?: Record<string, string[]>;
    /** Columns to omit regardless — artwork we're deliberately protecting. */
    force?: string[];
  }
): string[] {
  const out = new Set<string>(opts?.force ?? []);
  for (const [key, value] of Object.entries(row)) {
    if (CARD_REQUIRED_COLUMNS.has(key)) continue;
    if (carriesData(value)) continue;
    out.add(key);
    for (const companion of opts?.companions?.[key] ?? []) out.add(companion);
  }
  return [...out];
}

/** `row` with its empty columns removed, ready to upsert.
 *
 *  What is left can only ever ADD to the stored record. There is no argument
 *  for clearing a field here — a deliberate clear is its own explicit update,
 *  written where somebody decided to make it, not a side effect of a record
 *  arriving with a gap in it. */
export function gapFill(
  row: Record<string, unknown>,
  opts?: Parameters<typeof emptyColumns>[1]
): Record<string, unknown> {
  const drop = new Set(emptyColumns(row, opts));
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)));
}

/** The companion rule every card writer needs: a price stamp is only true if
 *  a price went with it. */
export const CARD_COMPANIONS: Record<string, string[]> = {
  market_price: ["price_updated_at"],
  prices: ["price_updated_at"],
};
