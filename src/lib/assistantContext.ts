// What Trainer AI knows about you, assembled for each message.
//
// The hard constraint is cost, not the context window. A credit is a cent, so
// stuffing 1,500 cards of full rules text into every chat turn — which is how
// the deck builder once overflowed at 185k tokens — would make a one-line
// question cost more than a deck build. So this sends an INDEX, not a
// library: what you own and how many, never what each card does. If the
// assistant needs a card's text it can ask, or the deck tools can fetch it.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Roughly 4 characters a token for English prose and short lines. Only used
 *  to decide how much to include, so an estimate is fine. */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** How many collection lines to spell out before switching to set-level
 *  totals. 700 lines is around 6k tokens — enough to name almost anyone's
 *  binder, cheap enough to send every turn. */
const MAX_CARD_LINES = 700;

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
    supabase
      .from("collection_items")
      .select("quantity, variant, price_override, card:cards(name, set_name, number, rarity, market_price)")
      .eq("user_id", userId)
      .limit(5000),
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

  if (shown.length > 0) {
    parts.push(
      "CARDS OWNED (name xQty · set):\n" +
        shown.map(([name, v]) => `${name} x${v.qty} · ${v.set}`).join("\n")
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
