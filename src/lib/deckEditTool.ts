// The propose-an-edit tool, shared by every chat surface that can offer one.
//
// This lived inside the assistant route, which meant the assistant was the
// only place a player could say "ok, make that change" and have it work.
// The coach box under a saved deck — the most natural place in the whole app
// to ask for a change, because you are looking at the deck while you ask —
// could only talk about it. So the tool and its handler moved here, and both
// routes use the same one.
//
// The shape is unchanged and is the point of the whole thing: the model
// PROPOSES, the player APPROVES an itemised diff, the server VALIDATES and
// writes. Nothing here touches the database.

import type { SupabaseClient } from "@supabase/supabase-js";
import { applyChanges, validateEdit, type DeckEditProposal } from "@/lib/deckEdit";
import type { DeckEntry } from "@/lib/deckLegality";
import { fetchAllRows } from "@/lib/fetchAll";

export const DECK_EDIT_TOOL = {
  name: "propose_deck_edit",
  description:
    "Propose a change to one of the player's saved decks. The player sees " +
    "the change and approves it before anything is saved — you are never " +
    "writing directly, so propose freely when they ask you to change, fix " +
    "or improve a deck. Give FINAL quantities, not differences: to go from " +
    "2 to 3 copies, send to=3. Send to=0 to remove a card. Only name cards " +
    "the player owns (basic energy excepted) and keep the result legal: 60 " +
    "cards, at most 4 of a name, at most 1 ACE SPEC.",
  input_schema: {
    type: "object" as const,
    properties: {
      deck_id: {
        type: "string",
        description: "The id of the deck to change, from the deck list you were given.",
      },
      changes: {
        type: "array",
        description: "Every card whose count should change.",
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string", description: "Exact card name." },
            to: { type: "integer", description: "How many copies AFTER the change. 0 removes it." },
            reason: { type: "string", description: "One short line on why." },
          },
          required: ["name", "to"],
        },
      },
    },
    required: ["deck_id", "changes"],
  },
};

/** Turn a proposed edit into a preview, without writing anything.
 *
 *  Validated here rather than only at apply time so the model learns
 *  immediately when it has asked for something impossible — five copies, a
 *  card the player doesn't own — and can correct itself in the same turn
 *  instead of offering the player a button that will fail. */
export async function runDeckEditProposal(
  supabase: SupabaseClient,
  userId: string,
  args: { deck_id?: string; changes?: Array<{ name: string; to: number; reason?: string }> }
): Promise<{ forModel: string; proposal: DeckEditProposal | null }> {
  const deckId = (args.deck_id ?? "").trim();
  const changes = (args.changes ?? []).filter(
    (c) => c && typeof c.name === "string" && Number.isFinite(c.to)
  );
  if (!deckId || changes.length === 0) {
    return { forModel: "No deck id or no changes given — nothing to propose.", proposal: null };
  }

  const { data: deck } = await supabase
    .from("decks")
    .select("id, name, cards, user_id")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck || deck.user_id !== userId) {
    return { forModel: "That deck id doesn't belong to this player.", proposal: null };
  }

  const before = (deck.cards ?? []) as DeckEntry[];
  const { cards: after, applied } = applyChanges(before, changes);
  if (applied.length === 0) {
    return { forModel: "The deck already matches that — no change to propose.", proposal: null };
  }

  // PAGED. This single query was the whole "you own 0" bug.
  //
  // PostgREST caps a response at 1000 rows. A collection of 1,635 rows was
  // therefore answering with the first 1000 of them, and every card in the
  // tail came back as owned: 0 — so a proposal naming a card the player has
  // four of was refused as unaffordable. Every other ownership read in the
  // app already pages (the apply route, the deck builder, the assistant's
  // context); this one didn't, which is why the proposal and the apply step
  // disagreed about the same collection.
  //
  // Ordered by id so the pages tile a stable sequence rather than whatever
  // order the planner felt like returning.
  const { data: items } = await fetchAllRows(() =>
    supabase
      .from("collection_items")
      .select("quantity, card:cards(name)")
      .eq("user_id", userId)
      .order("id")
  );
  const ownedByName = new Map<string, number>();
  for (const i of items ?? []) {
    const name = (i.card as unknown as { name?: string } | null)?.name;
    if (!name) continue;
    const key = name.trim().toLowerCase();
    ownedByName.set(key, (ownedByName.get(key) ?? 0) + ((i.quantity as number) ?? 0));
  }

  const check = validateEdit(after, ownedByName);
  if (!check.ok) {
    // The reason is stated, and so is the reason it ISN'T.
    //
    // Told only "you own 0", the model reached for an explanation and
    // invented one — that copies in the player's other decks were being held
    // back — then told the player so with some confidence. Nothing in this
    // app reserves cards: a deck is a list of names, building one takes
    // nothing out of the collection, and the same card may appear in every
    // deck at once. Ruling that out here is cheaper than letting a plausible
    // story about the player's own data reach them as fact.
    return {
      forModel:
        `That edit is not valid, so it was NOT offered to the player. Fix it and propose ` +
        `again, or explain the problem instead: ${check.errors.join(" ")}\n` +
        `FOR YOUR EXPLANATION: these counts are the player's WHOLE collection. Decks do ` +
        `not reserve or consume cards — a card in five other decks is still fully ` +
        `available here — so never tell the player a card is unavailable because another ` +
        `deck uses it. If a count looks wrong to you, say the count looks wrong; do not ` +
        `invent a rule to explain it.`,
      proposal: null,
    };
  }

  const total = after.reduce((n, c) => n + c.quantity, 0);
  return {
    forModel:
      `Proposed and shown to the player for approval — do NOT claim it is done. ` +
      `${applied.map((a) => `${a.name} ${a.from}→${a.to}`).join(", ")}. ` +
      `Deck would be ${total} cards.` +
      (check.warnings.length ? ` Note: ${check.warnings.join(" ")}` : ""),
    proposal: {
      deckId: deck.id as string,
      deckName: deck.name as string,
      changes: applied,
    },
  };
}
