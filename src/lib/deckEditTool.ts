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
import {
  applyChanges,
  validateEdit,
  missingCopies,
  categoryFromSupertype,
  type DeckEditProposal,
} from "@/lib/deckEdit";
import type { DeckEntry } from "@/lib/deckLegality";
import { fetchAllRows } from "@/lib/fetchAll";

export const DECK_EDIT_TOOL = {
  name: "propose_deck_edit",
  description:
    "Propose a change to one of the player's saved decks. The player sees " +
    "the change and approves it before anything is saved — you are never " +
    "writing directly, so propose freely when they ask you to change, fix " +
    "or improve a deck. Give FINAL quantities, not differences: to go from " +
    "2 to 3 copies, send to=3. Send to=0 to remove a card. Keep the result " +
    "LEGAL: 60 cards, at most 4 of a name, at most 1 ACE SPEC — those are " +
    "the only grounds on which a proposal is refused. Prefer cards the " +
    "player owns, but a saved deck is a RECORD of a deck they like rather " +
    "than a claim to have it sleeved up, so proposing a card they don't own " +
    "yet is fine as long as you say so. A card is never unavailable because " +
    "another of their decks lists it; decks don't reserve anything.",
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

/** What kind of card each of these names is, from the catalogue.
 *
 *  A deck row's category is only ever written when the card is added, and
 *  the writer used to guess — returning "pokemon" for anything that wasn't
 *  basic energy. So every Trainer the assistant added showed up in the
 *  Pokémon column and the section counts went wrong. The catalogue already
 *  knows; one lookup settles it.
 *
 *  Names are matched case-insensitively but exactly otherwise, because a
 *  fuzzy match here would file a card under the wrong heading with more
 *  confidence than the guess it replaced. Anything unmatched is simply
 *  absent, and the caller keeps whatever it had. */
export async function categoryLookup(
  supabase: SupabaseClient,
  names: string[]
): Promise<(name: string) => DeckEntry["category"] | undefined> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return () => undefined;

  const byName = new Map<string, DeckEntry["category"]>();
  // Chunked: a deck is small, but `in` with a long list is a URL nobody
  // needs to find the limit of.
  for (let i = 0; i < wanted.length; i += 100) {
    const { data } = await supabase
      .from("cards")
      .select("name, supertype")
      .in("name", wanted.slice(i, i + 100));
    for (const row of data ?? []) {
      const category = categoryFromSupertype(row.supertype as string | null);
      if (category) byName.set((row.name as string).trim().toLowerCase(), category);
    }
  }
  return (name: string) => byName.get(name.trim().toLowerCase());
}

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
  // Every name in play: what the deck already holds plus what is being
  // added, so existing miscategorised rows are corrected at the same time.
  const category = await categoryLookup(supabase, [
    ...before.map((c) => c.name),
    ...changes.map((c) => c.name),
  ]);
  const { cards: after, applied } = applyChanges(before, changes, category);
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

  // CHURN GUARD. A real proposal swapped out "Bubbly Water Energy" and
  // added "Basic Water Energy" — the same fuel wearing two names — which
  // reads to a player as the coach removing a card and putting it back.
  // Exactly "<type> Energy" (with or without "Basic") IS the basic energy
  // card, so a swap between two such names of one type is provably a no-op
  // and is refused with instructions. A swap where one side is a SPECIAL
  // energy of that type ("Speed Lightning Energy") can be legitimate, so
  // anything unproven passes with a pointed caution instead.
  const PLAIN_ENERGY_RE =
    /^(?:basic\s+)?(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i;
  const TYPE_TAIL_RE =
    /(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i;
  let churnCaution = "";
  {
    const outs = applied.filter((a) => a.to < a.from);
    const ins = applied.filter((a) => a.to > a.from);
    const pairs = outs.flatMap((o) => {
      const t = o.name.trim().toLowerCase().match(TYPE_TAIL_RE)?.[1];
      if (!t) return [];
      return ins
        .filter(
          (i) =>
            i.name.trim().toLowerCase().match(TYPE_TAIL_RE)?.[1] === t &&
            i.name.trim().toLowerCase() !== o.name.trim().toLowerCase()
        )
        .map((i) => ({ out: o, add: i }));
    });
    if (pairs.length > 0) {
      // Prove plainness: by name shape, or by a catalogue row that is
      // Energy with no rules text (special energy always carries text).
      const provenPlain = async (name: string): Promise<boolean> => {
        if (PLAIN_ENERGY_RE.test(name.trim())) return true;
        const { data } = await supabase
          .from("cards")
          .select("supertype, battle_data")
          .ilike("name", name.replace(/[%_]/g, ""))
          .limit(5);
        const rows = data ?? [];
        return (
          rows.length > 0 &&
          rows.every(
            (r) =>
              /energy/i.test((r.supertype as string | null) ?? "") &&
              !((r.battle_data as { rules?: string[] } | null)?.rules?.length)
          )
        );
      };
      for (const p of pairs) {
        if ((await provenPlain(p.out.name)) && (await provenPlain(p.add.name))) {
          return {
            forModel:
              `That edit removes "${p.out.name}" and adds "${p.add.name}", and both are plain ` +
              `basic energy of the same type — the same card under two names, which reads to ` +
              `the player as taking a card out and putting it back. It was NOT offered. ` +
              `Restate it as ONE net change to the name already in the deck ` +
              `("${p.out.name}"), and only that name.`,
            proposal: null,
          };
        }
      }
      churnCaution =
        ` CAUTION: this swaps between energy names of the same type (${pairs
          .map((p) => `"${p.out.name}" → "${p.add.name}"`)
          .join(", ")}). If those are the same functional card, the player will read it as ` +
        `churn — say explicitly, from their printed text, why they differ.`;
    }
  }

  const check = validateEdit(after, ownedByName);
  if (!check.ok) {
    // Only the rules of the game get here now. Not owning the cards does
    // not, and the model is told so explicitly — because when it was told
    // only "you own 0" it reached for an explanation, invented one (that
    // copies in the player's other decks were being held back), and passed
    // it on as fact. Nothing in this app reserves cards.
    return {
      forModel:
        `That edit breaks a rule of the game, so it was NOT offered to the player. Fix ` +
        `it and propose again, or explain the problem instead: ${check.errors.join(" ")}`,
      proposal: null,
    };
  }

  const total = after.reduce((n, c) => n + c.quantity, 0);
  const short = missingCopies(after, ownedByName);
  return {
    forModel:
      `Proposed and shown to the player for approval — do NOT claim it is done. ` +
      `${applied.map((a) => `${a.name} ${a.from}→${a.to}`).join(", ")}. ` +
      `Deck would be ${total} cards.` +
      (check.warnings.length ? ` Note: ${check.warnings.join(" ")}` : "") +
      churnCaution +
      // Said every time, because this is the fact the model got wrong when
      // left to work it out: a saved deck is a record, not an inventory
      // claim, and nothing here consumes a collection.
      `\nON OWNERSHIP: saved decks are records of decks the player likes — they do not ` +
      `all exist physically at once, and a card is never unavailable because another ` +
      `deck lists it. You may freely propose cards the player doesn't own yet; just say ` +
      `so plainly.` +
      (short.length
        ? ` They currently own fewer than this deck lists of: ${short
            .map((s) => `${s.name} (${s.owned}/${s.need})`)
            .join(", ")}.`
        : ""),
    proposal: {
      deckId: deck.id as string,
      deckName: deck.name as string,
      changes: applied,
      missing: short,
    },
  };
}
