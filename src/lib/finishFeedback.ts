import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";

/** The scanner's finish memory: corrections members made to past finish
 *  guesses, keyed per card. Not gradient-descent machine learning — but it
 *  IS learning from data: once the same wrong guess on the same card has
 *  been corrected enough times, future scans stop making it. */

export interface FinishFeedbackEntry {
  cardId: string;
  predicted: string;
  corrected: string;
}

/** Best-effort: record what the scanner guessed vs. what the member saved.
 *  Rows where predicted === corrected are confirmations and count in favor
 *  of the guess. Never throws — a missing table (migration 018 not run yet)
 *  just means no learning until it is. */
export async function recordFinishFeedback(
  supabase: SupabaseClient,
  userId: string,
  entries: FinishFeedbackEntry[]
): Promise<void> {
  const clean = entries
    .filter(
      (e) =>
        typeof e.cardId === "string" &&
        typeof e.predicted === "string" &&
        typeof e.corrected === "string" &&
        e.cardId.length > 0 &&
        e.predicted.length <= 40 &&
        e.corrected.length <= 40
    )
    .slice(0, 40);
  if (clean.length === 0) return;
  try {
    const { error } = await supabase.from("finish_feedback").insert(
      clean.map((e) => ({
        card_id: e.cardId,
        user_id: userId,
        predicted: e.predicted,
        corrected: e.corrected,
      }))
    );
    if (error) console.error("finish_feedback insert failed", error.message);
  } catch (err) {
    console.error("finish_feedback insert failed", err);
  }
}

/** Look up learned overrides for a set of cards. Returns a function:
 *  (cardId, predicted) → the finish to use instead, or null to keep the
 *  prediction. An override needs at least MIN_VOTES corrections to the same
 *  value, and more corrections than confirmations of the original guess —
 *  one stray mis-edit never flips a card. */
export async function loadFinishOverrides(
  supabase: SupabaseClient,
  cardIds: string[]
): Promise<(cardId: string, predicted: string) => string | null> {
  const MIN_VOTES = 2;
  const none = () => null;
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (ids.length === 0) return none;
  try {
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("finish_feedback")
        .select("card_id, predicted, corrected")
        .in("card_id", ids)
        .order("created_at")
    );
    if (error || !data) return none;

    // counts[cardId|predicted][corrected] = votes
    const counts = new Map<string, Map<string, number>>();
    for (const row of data) {
      const key = `${row.card_id}|${row.predicted}`;
      const byCorrected = counts.get(key) ?? new Map<string, number>();
      byCorrected.set(row.corrected, (byCorrected.get(row.corrected) ?? 0) + 1);
      counts.set(key, byCorrected);
    }

    return (cardId, predicted) => {
      const byCorrected = counts.get(`${cardId}|${predicted}`);
      if (!byCorrected) return null;
      let best: string | null = null;
      let bestVotes = 0;
      for (const [corrected, votes] of byCorrected) {
        if (votes > bestVotes) {
          best = corrected;
          bestVotes = votes;
        }
      }
      const confirmations = byCorrected.get(predicted) ?? 0;
      if (best && best !== predicted && bestVotes >= MIN_VOTES && bestVotes > confirmations) {
        return best;
      }
      return null;
    };
  } catch {
    return none;
  }
}
