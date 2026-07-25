import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { requireUser, AuthError } from "@/lib/auth";
import type { CardSummaryRow } from "@/lib/types";

export const maxDuration = 300; // deck building takes real thinking time

const DECK_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "A fun, evocative deck name." },
    strategy: {
      type: "string",
      description:
        "2-4 paragraph explanation of the deck's game plan, key combos, and how to pilot it.",
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact card name." },
          quantity: { type: "integer" },
          category: { type: "string", enum: ["pokemon", "trainer", "energy"] },
          card_id: {
            type: ["string", "null"],
            description:
              "The pokemontcg.io card id from the collection list if this card is from the owner's collection, else null (e.g. for basic energy).",
          },
          reason: {
            type: ["string", "null"],
            description: "One short sentence on why this card is in the deck.",
          },
        },
        required: ["name", "quantity", "category", "card_id", "reason"],
        additionalProperties: false,
      },
    },
    missing_suggestions: {
      type: "array",
      description:
        "Cards the player does NOT own that would meaningfully upgrade the deck (max 5).",
      items: { type: "string" },
    },
  },
  required: ["name", "strategy", "cards", "missing_suggestions"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are an expert Pokémon TCG deck builder. You build decks
using ONLY the cards the player actually owns (from the provided collection),
plus basic energy cards which players are assumed to have unlimited copies of.

Deck rules:
- Exactly 60 cards.
- Max 4 copies of any card by name (basic energy is exempt).
- You cannot include more copies of a card than the player owns (see qty).
- Include a sensible balance: typically 12-20 Pokémon, 25-35 Trainers, 8-15 Energy —
  adjust to the archetype and to what the collection actually supports.
- Respect evolution lines: don't include an evolution without its pre-evolution.
- If the collection can't support a competitive 60, build the best casual deck
  possible and say so in the strategy.

Tailor the deck to the player's play style profile when provided. Explain the
game plan clearly for the player's skill level.`;

export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { prompt } = (await req.json()) as { prompt?: string };
    const supabase = await createClient();

    const [{ data: items, error }, { data: playProfile }] = await Promise.all([
      supabase
        .from("collection_items")
        .select("quantity, card:cards(*)")
        .eq("user_id", user.id)
        .limit(3000),
      supabase.from("play_profiles").select("style_notes").eq("user_id", user.id).maybeSingle(),
    ]);
    if (error) throw error;

    const collection = (items ?? [])
      .map((i) => {
        const c = i.card as unknown as CardSummaryRow;
        if (!c) return null;
        return {
          id: c.id,
          name: c.name,
          qty: i.quantity as number,
          supertype: c.supertype,
          subtypes: c.subtypes,
          types: c.types,
          hp: c.hp,
          rarity: c.rarity,
          set: c.set_name,
        };
      })
      .filter(Boolean);

    if (collection.length === 0) {
      return NextResponse.json(
        { error: "Your collection is empty — scan some cards first!" },
        { status: 400 }
      );
    }

    const styleNotes = playProfile?.style_notes?.trim();
    const userContent = [
      styleNotes ? `PLAYER'S PLAY STYLE PROFILE:\n${styleNotes}` : null,
      `PLAYER'S COLLECTION (JSON):\n${JSON.stringify(collection)}`,
      `REQUEST: ${prompt?.trim() || "Build me the best deck you can from my collection."}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const client = anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: DECK_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: "user", content: userContent }],
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "Deck build was declined. Try again." }, { status: 422 });
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json({ error: "No deck produced." }, { status: 500 });
    }
    return NextResponse.json({ deck: JSON.parse(textBlock.text) });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("deck build error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Deck build failed" },
      { status: 500 }
    );
  }
}
