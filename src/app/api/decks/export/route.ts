import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deckToLiveText, deckToArenaText } from "@/lib/deckExport";
import { errorJson } from "@/lib/apiError";
import type { DeckCardEntry } from "@/lib/types";

/** POST { cards } → { text, warnings }: the deck as Pokémon TCG Live
 *  import text, ready for the clipboard. Takes the card list rather than a
 *  deck id so it serves a just-built deck (not saved yet) and a saved one
 *  with the same call. */
export async function POST(req: Request) {
  try {
    await requireUser();
    const body = (await req.json()) as {
      cards?: DeckCardEntry[];
      game?: string;
      format?: string;
    };
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
    if (cards.length === 0 || cards.length > 110) {
      return NextResponse.json({ error: "No deck to export." }, { status: 400 });
    }
    // Magic decks export in Arena's format — plain "quantity name" lines,
    // no set-code lookups needed. Pokémon keeps the Live pipeline.
    if (body.game === "mtg" || cards.some((c) => c.card_id?.startsWith("scry-"))) {
      const { text, warnings } = deckToArenaText(cards, body.format ?? null);
      return NextResponse.json({ text, warnings });
    }
    const admin = createAdminClient();
    const { text, warnings } = await deckToLiveText(admin, cards);
    return NextResponse.json({ text, warnings });
  } catch (err) {
    return errorJson(err, "Couldn't export the deck.");
  }
}
