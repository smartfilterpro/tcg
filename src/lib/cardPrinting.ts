// Which PRINTING of a card is in the photo.
//
// A collector number identifies a card; it does not identify the object in
// somebody's hand. TCGplayer sells each printing as its own product —
// "Dragonair (Poké Ball Pattern)", "Pikachu (Master Ball Pattern)" — and the
// paid sync now creates those rows, so the catalogue holds several cards with
// one name and one number. That is a better catalogue and it broke two things
// that assumed a name and a number were enough.
//
// This module is the one place that decides between them, so the phone
// scanner and the machine scanner cannot drift apart on it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { numberKey } from "@/lib/pokemontcg";
import { normalizeForSearch } from "@/lib/text";
import { setsAgree } from "@/lib/setName";
import { isSpecificPrinting, ballPatternOf, rowToSummary } from "@/lib/types";
import type { CardSummary, CardSummaryRow } from "@/lib/types";

/** Is this row the plain printing — the one with no qualifier in its name? */
export function isPlainPrinting(name: string): boolean {
  return !isSpecificPrinting(name);
}

/** Choose between rows that share a name and a collector number.
 *
 *  The rule is the obvious one once the rows are laid out: a scan that saw a
 *  ball wants the row naming that ball; a scan that saw no ball wants the
 *  plain row. What was happening instead was neither — the fast path
 *  demanded exactly one candidate and got three, so it gave up and went out
 *  to the external APIs for a card sitting in our own database. That is
 *  most of why some scans are quick and others crawl, and it got worse
 *  every time the sync added printings.
 *
 *  Returns null when the choice is genuinely unclear, which sends the caller
 *  down its existing slower path rather than guessing. */
export function pickPrinting<T extends { id: string; name: string }>(
  rows: T[],
  hint: string | null | undefined
): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const ball = ballPatternOf(hint);
  if (ball) {
    const named = rows.filter((r) => {
      const n = normalizeForSearch(r.name);
      return ball.words.some((w) => n.includes(w));
    });
    if (named.length === 1) return named[0];
    // Several balls and a scan that couldn't name which: an unanswered
    // question, not a choice.
    if (named.length > 1) return null;
    // It saw a ball and no row carries one — fall through to the plain row,
    // which the caller will label with the pattern as a finish.
  }

  const plain = rows.filter((r) => isPlainPrinting(r.name));
  if (plain.length === 1) return plain[0];
  return null;
}

/** The card's own row for the ball printing a scan saw, if we hold one.
 *
 *  Narrow on purpose: same collector number, same set, and a name that is the
 *  base card's plus the pattern. A scan can only ever swap to a row that IS
 *  the card in the photo.
 *
 *  Null when nothing matches — the caller keeps the plain card and records
 *  the pattern as a finish, which is what it did before this existed. */
export async function patternPrintingFor(
  db: SupabaseClient,
  base: { id: string; name: string; number: string; setName: string | null },
  hint: string | null | undefined
): Promise<CardSummary | null> {
  const ball = ballPatternOf(hint);
  if (!ball) return null;
  // A row that is already a named printing is never swapped again.
  if (isSpecificPrinting(base.name)) return null;

  try {
    const { data } = await db
      .from("cards")
      .select("*")
      .ilike("name", `${base.name.replace(/[%_]/g, " ")}%`)
      .limit(40);
    const rows = (data ?? []) as CardSummaryRow[];
    const wantedNumber = numberKey(base.number);
    const baseName = normalizeForSearch(base.name);
    const hits = rows.filter((r) => {
      if (r.id === base.id) return false;
      if (numberKey(r.number) !== wantedNumber) return false;
      if (!setsAgree(r.set_name, base.setName)) return false;
      const n = normalizeForSearch(r.name);
      return n.startsWith(baseName) && ball.words.some((w) => n.includes(w));
    });
    if (hits.length === 0) return null;
    // A scan that saw "a ball" without naming it may not pick between two.
    if (hits.length > 1 && ball.variant == null) return null;
    return rowToSummary(hits[0]);
  } catch {
    return null;
  }
}
