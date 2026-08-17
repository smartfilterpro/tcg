import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { metaDecksFor } from "@/lib/meta";
import { errorJson } from "@/lib/apiError";

/** GET: the trending archetypes with this member's coverage folded in.
 *  Reads only our own meta_decks table — members never touch the external
 *  feed, however many of them open the page. */
export async function GET() {
  try {
    const { user } = await requireUser();
    try {
      const { decks, hasLimitless } = await metaDecksFor(user.id);
      return NextResponse.json({ migrated: true, decks, hasLimitless });
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
