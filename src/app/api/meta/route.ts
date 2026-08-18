import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { metaDecksFor } from "@/lib/meta";
import { affiliateActive } from "@/lib/buyLink";
import { errorJson } from "@/lib/apiError";

/** GET: the trending archetypes with this member's coverage folded in.
 *  Reads only our own meta_decks table — members never touch the external
 *  feed, however many of them open the page. */
export async function GET() {
  try {
    const { user } = await requireUser();
    try {
      const { decks, hasLimitless } = await metaDecksFor(user.id);
      // The client shows the required "we earn a commission" line only when
      // the links actually carry the affiliate wrapper.
      return NextResponse.json({
        migrated: true,
        decks,
        hasLimitless,
        affiliate: affiliateActive(),
      });
    } catch (err) {
      // Pre-migration-068: the page shows its own setup note.
      if (/meta_decks/i.test(err instanceof Error ? err.message : "")) {
        return NextResponse.json({ migrated: false, decks: [], hasLimitless: false });
      }
      throw err;
    }
  } catch (err) {
    return errorJson(err, "Couldn't load the meta.");
  }
}
