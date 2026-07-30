// The landing page's numbers, from the scans that actually happened.
//
// They used to be hand-measured constants with an as-of date and a note
// saying they were updated by hand. That was honest, but it decays: the
// number stops moving while the scanner does, and nobody remembers to edit
// it. Both figures are already recorded per scan in scan_events, so there is
// no reason for the landing page to quote a memory of them.
//
//   97%  → cards_kept_match ÷ cards_saved. The user was shown a match and
//          saved it without correcting it, which is the only evidence we have
//          that it was right.
//   3.4s → total duration ÷ cards saved. Wall-clock from opening the scanner
//          to a saved card, divided by the cards that came out of it.
//
// "20+ cards from a single photo" stays a constant: it is a capability
// claim about what the scanner will attempt, not a measurement, and the
// average cards-per-scan would understate it badly — most people photograph
// two or three cards at a time.

import { createAdminClient } from "@/lib/supabase/admin";

export interface LiveStat {
  value: string;
  label: string;
}

/** Below this, the numbers are noise and we show the written claim instead.
 *  A "100% match rate" from four scans is not a better number than a modest
 *  one from four thousand — it is a worse one, stated confidently. */
const MIN_SCANS = 25;
const MIN_CARDS = 100;

export interface StatsResult {
  stats: LiveStat[];
  /** Null when there isn't enough data yet and the fallback is in use. */
  measuredFrom: { scans: number; cards: number } | null;
}

const FALLBACK: LiveStat[] = [
  { value: "1 photo", label: "adds a whole row of cards to your binder" },
  { value: "Every set", label: "from Base Set to this month's release" },
  { value: "20+", label: "cards read from a single photo" },
];

/** Live stats for the landing page. Never throws: the landing page is the
 *  first thing a stranger sees, and it must render if the database is having
 *  a bad day. */
export async function liveStats(): Promise<StatsResult> {
  try {
    const admin = createAdminClient();
    // Last 90 days. A lifetime average would be dominated by the scanner's
    // worst period forever, which misrepresents it in the other direction.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("scan_events")
      .select("duration_ms, cards_saved, cards_kept_match")
      .gte("created_at", since)
      .limit(20_000);
    if (error || !data || data.length < MIN_SCANS) return { stats: FALLBACK, measuredFrom: null };

    let saved = 0;
    let kept = 0;
    let ms = 0;
    for (const r of data as Array<Record<string, number>>) {
      saved += r.cards_saved ?? 0;
      kept += r.cards_kept_match ?? 0;
      ms += r.duration_ms ?? 0;
    }
    if (saved < MIN_CARDS) return { stats: FALLBACK, measuredFrom: null };

    const accuracy = (kept / saved) * 100;
    const perCard = ms / 1000 / saved;

    return {
      stats: [
        // Floored, not rounded: rounding 96.6 up to 97 overstates it, and
        // this is a claim made to someone deciding whether to pay.
        { value: `${Math.floor(accuracy)}%`, label: "of scanned cards matched correctly, first try" },
        { value: `${perCard.toFixed(1)}s`, label: "average time to add one card, start to saved" },
        { value: "20+", label: "cards read from a single photo" },
      ],
      measuredFrom: { scans: data.length, cards: saved },
    };
  } catch {
    return { stats: FALLBACK, measuredFrom: null };
  }
}

/** The line under the numbers. Says what they are actually drawn from, which
 *  is the part that makes them worth printing. */
export function statsNote(from: StatsResult["measuredFrom"]): string {
  if (!from) {
    return "Your photos, lighting and cards will vary — most people get a row of cards in per photo.";
  }
  return (
    `Measured from ${from.cards.toLocaleString()} cards across ${from.scans.toLocaleString()} ` +
    `real scans in the last 90 days, updated continuously. Your photos, lighting and cards will vary.`
  );
}
