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
import { isSpecificPrinting, ballPatternOf, rowToSummary, CARD_SUMMARY_COLUMNS } from "@/lib/types";
import type { CardSummary, CardSummaryRow } from "@/lib/types";

/** Is this row the plain printing — the one with no qualifier in its name? */
export function isPlainPrinting(name: string): boolean {
  return !isSpecificPrinting(name);
}

/** Which catalogue's id scheme to prefer when the same physical card exists
 *  under more than one. pokemontcg.io ids ("sv8-45") are the canonical
 *  spine of the catalogue; "tcgdex-…" rows arrive when a set is too new for
 *  it; "tcgp-…" rows come from the price sync. Lower is better. */
function schemeRank(id: string): number {
  if (id.startsWith("tcgp-")) return 2;
  if (id.startsWith("tcgdex-")) return 1;
  return 0;
}

/** If every row here is the SAME card — one physical printing held under
 *  several id schemes because it was imported from several catalogues —
 *  return the best row for it. Null when the rows are genuinely different
 *  cards (different sets), which stays an unanswered question.
 *
 *  This is the miss that made brand-new sets scan slowly forever: a set
 *  lands in TCGdex first, a scan saves "tcgdex-sv10-45 Litwick", the nightly
 *  import later adds "sv10-45 Litwick", and from then on two identical plain
 *  rows made the picker refuse — so every future scan of a card we hold
 *  twice went out to an external API. Two copies of the same answer is not
 *  ambiguity. */
function soleCard<T extends { id: string; name: string; set_name?: string | null }>(
  rows: T[]
): T | null {
  const first = rows[0];
  for (const r of rows.slice(1)) {
    if (!setsAgree(r.set_name, first.set_name)) return null;
  }
  return [...rows].sort(
    (a, b) => schemeRank(a.id) - schemeRank(b.id) || a.id.localeCompare(b.id)
  )[0];
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
export function pickPrinting<T extends { id: string; name: string; set_name?: string | null }>(
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
    // Several rows naming a ball: fine if they are one card under several
    // id schemes; an unanswered question, not a choice, if they aren't.
    if (named.length > 1) return soleCard(named);
    // It saw a ball and no row carries one — fall through to the plain row,
    // which the caller will label with the pattern as a finish.
  }

  const plain = rows.filter((r) => isPlainPrinting(r.name));
  if (plain.length === 1) return plain[0];
  if (plain.length > 1) return soleCard(plain);
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
    const baseName = normalizeForSearch(base.name);
    let rows: CardSummaryRow[];
    try {
      // Indexed prefix on the normalized key (migration 066).
      const { data, error } = await db
        .from("cards")
        .select(CARD_SUMMARY_COLUMNS)
        .like("name_key", `${baseName}%`)
        .order("name_key")
        .order("id")
        .limit(40);
      if (error) throw error;
      rows = (data ?? []) as unknown as CardSummaryRow[];
    } catch {
      // Pre-066 fallback: the old byte-wise prefix scan.
      const { data } = await db
        .from("cards")
        .select(CARD_SUMMARY_COLUMNS)
        .ilike("name", `${base.name.replace(/[%_]/g, " ")}%`)
        .limit(40);
      rows = (data ?? []) as unknown as CardSummaryRow[];
    }
    const wantedNumber = numberKey(base.number);
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
    // Same printing held under several id schemes is one answer, not an
    // arbitrary draw — prefer the canonical row, deterministically.
    hits.sort((a, b) => schemeRank(a.id) - schemeRank(b.id) || a.id.localeCompare(b.id));
    return rowToSummary(hits[0]);
  } catch {
    return null;
  }
}
