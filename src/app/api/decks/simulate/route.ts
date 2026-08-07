import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { analyzeDeck, isDrawTrainer, type DeckMathEntry } from "@/lib/deckMath";
import type { CardBattleData } from "@/lib/pokemontcg";
import type { DeckCardEntry } from "@/lib/types";
import { errorJson } from "@/lib/apiError";

/** POST: deal thousands of simulated opening hands from a deck list and
 *  report how it actually starts. Pure code — free, instant, no AI.
 *  Body: { cards: DeckCardEntry[] } */
export async function POST(req: Request) {
  try {
    await requireUser();
    const { cards } = (await req.json()) as { cards?: DeckCardEntry[] };
    if (!Array.isArray(cards) || cards.length === 0 || cards.length > 80) {
      return NextResponse.json({ error: "Send the deck's card list." }, { status: 400 });
    }

    // Enrich from the card cache: stage (Basic vs evolution) + trainer text.
    const supabase = await createClient();
    const ids = [...new Set(cards.map((c) => c.card_id).filter(Boolean))] as string[];
    const rowById = new Map<string, Record<string, unknown>>();
    if (ids.length > 0) {
      const { data } = await supabase.from("cards").select("*").in("id", ids);
      for (const row of data ?? []) rowById.set(row.id as string, row);
    }

    const toEntry = (c: DeckCardEntry): DeckMathEntry & { isEnergy: boolean } => {
      const row = c.card_id ? rowById.get(c.card_id) : undefined;
      const bd = (row?.battle_data as CardBattleData | null) ?? null;
      const subtypes = ((row?.subtypes as string[] | null) ?? []).map((s) => s.toLowerCase());
      const stage =
        bd?.stage ?? (subtypes.includes("basic") ? "Basic" : subtypes.find((s) => /^stage/.test(s)) ?? null);
      const isPokemon = c.category === "pokemon";
      return {
        name: c.name,
        quantity: Math.max(0, Math.min(60, c.quantity)),
        category: c.category,
        basic: isPokemon ? (stage ? /basic/i.test(stage) : subtypes.length > 0 ? subtypes.includes("basic") : null) : null,
        stage,
        text: bd?.rules?.join(" ") ?? null,
        attackCosts: bd?.attacks?.map((a) => a.cost.length),
        isEnergy: c.category === "energy",
      };
    };
    const entries = cards.map(toEntry);
    const analysis = analyzeDeck(entries);

    // Tag every physical card, then deal.
    interface Tag {
      basic: boolean;
      draw: boolean;
      energy: boolean;
    }
    const pile: Tag[] = [];
    for (const e of entries) {
      const tag: Tag = {
        // Unknown-stage Pokémon count as Basics here, mirroring analyzeDeck's
        // mulligan math (safer than pretending they can't open).
        basic: e.category === "pokemon" && e.basic !== false,
        draw: e.category === "trainer" && isDrawTrainer(e.name, e.text),
        energy: e.isEnergy,
      };
      for (let i = 0; i < e.quantity; i++) pile.push(tag);
    }
    if (pile.length < 7) {
      return NextResponse.json({ error: "The deck needs at least 7 cards to simulate." }, { status: 400 });
    }

    const TRIALS = 2000;
    let mulligans = 0;
    let withDraw = 0;
    let withEnergy = 0;
    let dreamStart = 0;
    const idx = pile.map((_, i) => i);
    const hasBasic = pile.some((t) => t.basic);

    for (let t = 0; t < TRIALS; t++) {
      // Real mulligan procedure: reshuffle and redraw until a Basic appears.
      let hand: Tag[] = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        // Partial Fisher-Yates: only the first 7 positions matter.
        for (let i = 0; i < 7; i++) {
          const j = i + Math.floor(Math.random() * (idx.length - i));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        hand = idx.slice(0, 7).map((i) => pile[i]);
        if (hand.some((c) => c.basic) || !hasBasic) break;
        mulligans++;
      }
      if (hand.some((c) => c.draw)) withDraw++;
      if (hand.some((c) => c.energy)) withEnergy++;
      if (hand.some((c) => c.basic) && hand.some((c) => c.draw) && hand.some((c) => c.energy))
        dreamStart++;
    }

    return NextResponse.json({
      trials: TRIALS,
      mulliganPct: (mulligans / (TRIALS + mulligans)) * 100,
      withDrawPct: (withDraw / TRIALS) * 100,
      withEnergyPct: (withEnergy / TRIALS) * 100,
      dreamStartPct: (dreamStart / TRIALS) * 100,
      issues: analysis.issues,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("simulate error", err);
    return errorJson(err, "Simulation failed");
  }
}
