// What TrainerAI knows about you, assembled for each message.
//
// The hard constraint is cost, not the context window. A credit is a cent, so
// stuffing 1,500 cards of full rules text into every chat turn — which is how
// the deck builder once overflowed at 185k tokens — would make a one-line
// question cost more than a deck build. So this sends an INDEX, not a
// library: what you own and how many, never what each card does. If the
// assistant needs a card's text it can ask, or the deck tools can fetch it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";

/** Roughly 4 characters a token for English prose and short lines. Only used
 *  to decide how much to include, so an estimate is fine. */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** How many cards to spell out before falling back to set-level totals.
 *
 *  Raised from 700 when the rendering changed: grouping by set stopped the
 *  set name being rewritten on every line, which was 2,987 tokens of pure
 *  duplication at 700 cards. The cheaper rows buy more of them — 1,200 cards
 *  now costs less than 700 did, so the assistant is both cheaper AND less
 *  likely to say "you don't own that" about something you do. */
const MAX_CARD_LINES = 1200;

interface Row {
  quantity: number;
  variant: string | null;
  price_override: number | null;
  card: {
    name: string;
    set_name: string | null;
    number: string | null;
    rarity: string | null;
    market_price: number | null;
    /** From pokemontcg.io, cached in battle_data. Null when we've never
     *  looked this card up — sparse, and treated as unknown, not as legal. */
    legal: { std?: boolean; exp?: boolean } | null;
  } | null;
}

export interface AssistantContext {
  text: string;
  cards: number;
  decks: number;
  truncated: number;
}

/** A compact picture of one player's account. */
export async function buildContext(
  supabase: SupabaseClient,
  userId: string
): Promise<AssistantContext> {
  const [itemsRes, decksRes, profileRes, gradesRes] = await Promise.all([
    // Paged, not .limit(5000).
    //
    // PostgREST caps every response at 1,000 rows whatever .limit() asks for,
    // and this query had no .order() either — so past a thousand rows it
    // returned an ARBITRARY thousand, silently. The symptom was subtle and
    // bad: someone owning four different printings of Professor's Research
    // (3+3+2+2 = 10) had two of those rows survive the cap, so the assistant
    // was told they owned 4 and said so with confidence. Not a hallucination
    // — it read the data faithfully, and the data was a random subset.
    //
    // The order has to be total, or paging repeats rows on one page and
    // drops them from another, which would be the same bug wearing a hat.
    fetchAllRows(() =>
      supabase
        .from("collection_items")
        .select(
          // legal:battle_data->legal pulls just the legality object out of
          // the jsonb rather than the whole card's rules text, which would
          // be megabytes across a big collection.
          "quantity, variant, price_override, card:cards(name, set_name, number, rarity, market_price, legal:battle_data->legal)"
        )
        .eq("user_id", userId)
        .order("created_at")
        .order("id")
    ),
    supabase
      .from("decks")
      .select("name, strategy, cards")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(12),
    supabase.from("play_profiles").select("style_notes").eq("user_id", userId).maybeSingle(),
    supabase
      .from("grade_reports")
      .select("card_name, estimated_grade, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const rows = (itemsRes.data ?? []) as unknown as Row[];

  // Fold finishes together — "do I own a Charizard" doesn't care whether it's
  // the reverse holo, and splitting them doubles the line count for nothing.
  const byName = new Map<string, { qty: number; set: string; value: number }>();
  const bySet = new Map<string, number>();
  // Standard legality, per set, from the cards we actually hold data for.
  // A set is judged by its cards: any card marked Standard-legal makes the
  // set current, and a set whose known cards are all marked not-legal has
  // rotated. Sets with no data at all stay unknown and are named as such —
  // the assistant must not guess, and "I don't know" is a correct answer
  // that a confident wrong one is not.
  const setLegal = new Map<string, { legal: number; rotated: number }>();
  let totalCards = 0;
  let totalValue = 0;
  for (const r of rows) {
    if (!r.card) continue;
    const qty = r.quantity ?? 0;
    const unit = r.price_override ?? r.card.market_price ?? 0;
    totalCards += qty;
    totalValue += qty * unit;
    const set = r.card.set_name ?? "Unknown set";
    bySet.set(set, (bySet.get(set) ?? 0) + qty);
    if (r.card.legal && typeof r.card.legal.std === "boolean") {
      const tally = setLegal.get(set) ?? { legal: 0, rotated: 0 };
      if (r.card.legal.std) tally.legal += 1;
      else tally.rotated += 1;
      setLegal.set(set, tally);
    }
    const prev = byName.get(r.card.name);
    if (prev) {
      prev.qty += qty;
      prev.value = Math.max(prev.value, unit);
    } else {
      byName.set(r.card.name, { qty, set, value: unit });
    }
  }

  // Most valuable first, so what survives truncation is what someone is most
  // likely to ask about.
  const ranked = [...byName.entries()].sort((a, b) => b[1].value - a[1].value);
  const shown = ranked.slice(0, MAX_CARD_LINES);
  const truncated = ranked.length - shown.length;

  const parts: string[] = [];
  parts.push(
    `COLLECTION SUMMARY: ${totalCards} cards, ${byName.size} different cards, ` +
      `estimated total value $${totalValue.toFixed(2)}.`
  );

  const sets = [...bySet.entries()].sort((a, b) => b[1] - a[1]);
  if (sets.length > 0) {
    parts.push(
      "BY SET: " + sets.slice(0, 40).map(([s, n]) => `${s} (${n})`).join(", ") +
        (sets.length > 40 ? `, and ${sets.length - 40} more sets` : "")
    );
  }

  // What is actually legal in Standard right now, from the card database
  // rather than from the model's memory of when it was trained. Rotation
  // moves every year, so a model asked "is this Standard legal?" is being
  // asked a question its training data cannot answer.
  const standard: string[] = [];
  const rotated: string[] = [];
  const unknownLegality: string[] = [];
  for (const [set] of sets) {
    const tally = setLegal.get(set);
    if (!tally) unknownLegality.push(set);
    else if (tally.legal > 0) standard.push(set);
    else rotated.push(set);
  }
  if (standard.length || rotated.length || unknownLegality.length) {
    parts.push(
      "FORMAT LEGALITY — this is current data from the card database, and it " +
        "OVERRIDES anything you remember about rotation. Never state that a card " +
        "is or isn't Standard legal from memory.\n" +
        (standard.length ? `Standard legal: ${standard.join(", ")}.\n` : "") +
        (rotated.length ? `Rotated out of Standard: ${rotated.join(", ")}.\n` : "") +
        (unknownLegality.length
          ? `No legality data on file for: ${unknownLegality.slice(0, 25).join(", ")}` +
            (unknownLegality.length > 25 ? `, and ${unknownLegality.length - 25} more` : "") +
            ". For these, say you don't have current legality data and point them at the official list — do not guess."
          : "")
    );
  }

  if (shown.length > 0) {
    // Grouped by set, so the set name is written once per group instead of
    // once per card. Ranking is still by value — that decides WHICH cards
    // survive truncation — and grouping only changes how the survivors are
    // laid out, so the most valuable cards are still the ones that make it.
    const bySetGroup = new Map<string, string[]>();
    for (const [name, v] of shown) {
      const line = `${name}\t${v.qty}`;
      const list = bySetGroup.get(v.set);
      if (list) list.push(line);
      else bySetGroup.set(v.set, [line]);
    }
    parts.push(
      "CARDS OWNED, grouped by set. Each row is: card name<TAB>how many you own.\n" +
        [...bySetGroup.entries()]
          .map(([set, lines]) => `[${set}]\n${lines.join("\n")}`)
          .join("\n\n")
    );
  }
  if (truncated > 0) {
    // Say what's missing rather than letting it answer "no" about a card that
    // simply fell off the end of the list.
    parts.push(
      `NOTE: ${truncated} more distinct lower-value cards are owned but not ` +
        `listed above. If asked about a card you cannot see here, say you can't ` +
        `see all of their cheaper cards rather than saying they don't own it.`
    );
  }

  const decks = decksRes.data ?? [];
  if (decks.length > 0) {
    parts.push(
      "THEIR DECKS:\n" +
        decks
          .map((d) => {
            const cards = (d.cards ?? []) as Array<{ name: string; quantity: number }>;
            const list = cards.map((c) => `${c.quantity}x ${c.name}`).join(", ");
            const notes = (d.strategy ?? "").trim();
            return `- "${d.name}" (${cards.reduce((s, c) => s + c.quantity, 0)} cards): ${list}` +
              (notes ? `\n  Their notes: ${notes.slice(0, 600)}` : "");
          })
          .join("\n")
    );
  } else {
    parts.push("THEIR DECKS: none saved yet.");
  }

  const grades = gradesRes.data ?? [];
  if (grades.length > 0) {
    parts.push(
      "RECENTLY GRADED: " +
        grades.map((g) => `${g.card_name ?? "a card"} (est. ${g.estimated_grade})`).join(", ")
    );
  }

  const style = (profileRes.data?.style_notes ?? "").trim();
  if (style) parts.push(`HOW THEY LIKE TO PLAY (their own words): ${style.slice(0, 800)}`);

  return {
    text: parts.join("\n\n"),
    cards: totalCards,
    decks: decks.length,
    truncated,
  };
}
