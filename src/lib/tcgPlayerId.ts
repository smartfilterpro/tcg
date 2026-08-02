// Recording a card's TCGplayer id without letting it break anything else.
//
// The id is a nice-to-have: it is the join key for the bulk datasets the
// paid source publishes, and it arrives free on lookups we make anyway. The
// price and the picture are the point.
//
// It also carries a unique index (migration 033), which is correct — two
// cards cannot be the same TCGplayer product — but it means writing it can
// FAIL, and it fails precisely when the catalogue holds a duplicate: some
// other row already claims that id. Bundled into the same UPDATE as the
// price, one rejected bonus field discards the whole statement, so a card
// silently keeps no price because of a constraint that has nothing to do
// with prices. That is what "Found a price of $4.18 but it didn't save"
// was.
//
// So it is written on its own, after the write that matters, and a
// collision is swallowed. A collision is not an error here — it is the
// database telling us this card has a twin, which is a job for the dedupe
// tool, not a reason to lose data now.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

export interface AttachResult {
  saved: boolean;
  /** The id already belongs to another card — a duplicate, worth surfacing
   *  rather than swallowing silently. */
  conflict: boolean;
}

export async function attachTcgPlayerId(
  admin: SupabaseClient,
  cardId: string,
  tcgPlayerId: string | null | undefined
): Promise<AttachResult> {
  if (!tcgPlayerId) return { saved: false, conflict: false };
  const { error } = await admin
    .from("cards")
    .update({ tcgplayer_id: tcgPlayerId })
    .eq("id", cardId);
  if (!error) return { saved: true, conflict: false };
  if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
    console.warn(
      `tcgplayer id ${tcgPlayerId} already belongs to another card — ${cardId} has a duplicate.`
    );
    return { saved: false, conflict: true };
  }
  // Anything else is unexpected, but still not worth failing the caller's
  // real work over.
  console.warn(`couldn't record tcgplayer id for ${cardId}: ${error.message}`);
  return { saved: false, conflict: false };
}
