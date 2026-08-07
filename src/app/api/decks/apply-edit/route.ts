import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { applyChanges, validateEdit, type DeckEditChange } from "@/lib/deckEdit";
import { categoryLookup } from "@/lib/deckEditTool";
import type { DeckEntry } from "@/lib/deckLegality";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 60;

/** POST: apply a deck edit the player approved.
 *
 *  This is the ONLY path by which the assistant's proposal reaches the
 *  database, and it is a separate, explicit request the player triggers —
 *  never something the chat turn can do on its own. The model proposes into
 *  a message; a human presses Apply; this validates and writes.
 *
 *  Everything is re-checked here even though the proposal was approved.
 *  Approval means "I want this change", not "I have verified it is legal" —
 *  and the proposal arrived through a browser, so it is input like any
 *  other. Trusting it because a model authored it would be trusting the
 *  least accountable party in the exchange.
 *
 *  What is checked is the RULES OF THE GAME, and not whether the collection
 *  currently holds the cards. A saved deck is a record of a deck somebody
 *  built or wants to try, kept so they can come back to it — nobody has
 *  every saved deck sleeved up at once. Owning too few is reported and
 *  saved anyway.
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json()) as {
      deckId?: string;
      changes?: DeckEditChange[];
    };

    const deckId = (body.deckId ?? "").trim();
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!deckId || changes.length === 0) {
      return NextResponse.json({ error: "Nothing to apply." }, { status: 400 });
    }
    if (changes.length > 30) {
      return NextResponse.json(
        { error: "That's too many changes at once — ask for a rebuild instead." },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Ownership of the DECK. RLS also scopes the update, but reading first
    // lets us answer "that isn't your deck" instead of "0 rows changed".
    const { data: deck, error: deckErr } = await supabase
      .from("decks")
      .select("id, name, cards, user_id")
      .eq("id", deckId)
      .maybeSingle();
    if (deckErr) throw deckErr;
    if (!deck || deck.user_id !== user.id) {
      return NextResponse.json({ error: "That deck isn't yours to edit." }, { status: 403 });
    }

    const before = (deck.cards ?? []) as DeckEntry[];
    // Categories come from the catalogue, not from a guess. Resolved again
    // here rather than trusted from the proposal, for the same reason
    // everything else is: the proposal arrived through a browser.
    const category = await categoryLookup(supabase, [
      ...before.map((c) => c.name),
      ...changes.map((c) => c.name),
    ]);
    const { cards: after, applied } = applyChanges(before, changes, category);
    if (applied.length === 0) {
      return NextResponse.json({
        ok: true,
        applied: [],
        message: "The deck already matches that — nothing changed.",
      });
    }

    // What the player owns, by name, across printings.
    const { data: items } = await fetchAllRows(() =>
      supabase
        .from("collection_items")
        .select("quantity, card:cards(name)")
        .eq("user_id", user.id)
        .order("id")
    );
    const ownedByName = new Map<string, number>();
    for (const i of (items ?? []) as Array<Record<string, unknown>>) {
      const name = (i.card as unknown as { name?: string } | null)?.name;
      if (!name) continue;
      const key = name.trim().toLowerCase();
      ownedByName.set(key, (ownedByName.get(key) ?? 0) + ((i.quantity as number) ?? 0));
    }

    const check = validateEdit(after, ownedByName);
    if (!check.ok) {
      return NextResponse.json(
        {
          error: "That change would break a deck-building rule, so nothing was saved.",
          reasons: check.errors,
        },
        { status: 400 }
      );
    }

    const { error: upErr } = await supabase
      .from("decks")
      .update({ cards: after })
      .eq("id", deckId);
    if (upErr) throw upErr;

    const total = after.reduce((n, c) => n + c.quantity, 0);
    return NextResponse.json({
      ok: true,
      applied,
      total,
      warnings: check.warnings,
      message: `Updated "${deck.name}" — now ${total} cards.`,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't apply that edit");
  }
}
