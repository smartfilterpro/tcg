import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deckToLiveText } from "@/lib/deckExport";
import { errorJson } from "@/lib/apiError";
import type { DeckCardEntry } from "@/lib/types";

/** POST { cards } → { text, warnings }: the deck as Pokémon TCG Live
 *  import text, ready for the clipboard. Takes the card list rather than a
 *  deck id so it serves a just-built deck (not saved yet) and a saved one
 *  with the same call. */
export async function POST(req: Request) {
  try {
    await requireUser();
    const body = (await req.json()) as { cards?: DeckCardEntry[] };
    const cards = (body.cards ?? []).filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        c.name.length > 0 &&
        c.name.length <= 200 &&
        Number.isInteger(c.quantity) &&
        c.quantity > 0 &&
        c.quantity <= 60
    );
    if (cards.length === 0 || cards.length > 100) {
      return NextResponse.json({ error: "No deck to export." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { text, warnings } = await deckToLiveText(admin, cards);
    return NextResponse.json({ text, warnings });
  } catch (err) {
    return errorJson(err, "Couldn't export the deck.");
  }
}
