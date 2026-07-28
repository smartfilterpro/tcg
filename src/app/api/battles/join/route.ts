import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { buildSide, pushLogRaw, type BattleState } from "@/lib/battle";
import { battleErrorResponse, displayName, expandDeck, loadBattleDeck } from "../lib";

// First battle with a deck fetches card data + compiles trainer effects.
export const maxDuration = 120;

/** POST: join a friend's waiting battle. Body: { code, deckId } */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const body = (await req.json()) as { code?: string; deckId?: string };
    const code = body.code?.trim().toUpperCase() ?? "";
    if (!code) return NextResponse.json({ error: "Enter the battle code." }, { status: 400 });
    if (!body.deckId || typeof body.deckId !== "string") {
      return NextResponse.json({ error: "Pick a deck to battle with." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: battle, error } = await admin
      .from("battles")
      .select("id, code, host_user, status, state, version")
      .eq("code", code)
      .eq("status", "waiting")
      .maybeSingle();
    if (error) throw error;
    if (!battle) {
      return NextResponse.json(
        { error: "No open battle with that code — check it with your friend." },
        { status: 404 }
      );
    }
    if (battle.host_user === user.id) {
      return NextResponse.json(
        { error: "That's your own battle — share the code with a friend so they can join." },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const state = battle.state as BattleState;
    const loaded = await loadBattleDeck(
      supabase,
      user.id,
      body.deckId,
      state.allowSharedDecks === true
    );
    if ("error" in loaded) {
      return NextResponse.json({ error: loaded.error }, { status: 400 });
    }
    const { deck, borrowed } = loaded;

    const cards = await expandDeck(admin, deck, "g", { userId: user.id });
    const myName = displayName(profile, user.email);
    state.sides[user.id] = buildSide(cards);
    state.names[user.id] = myName;

    const hostName = state.names[battle.host_user as string] ?? "Trainer";
    const hostFirst = Math.random() < 0.5;
    const firstUser = hostFirst ? (battle.host_user as string) : user.id;
    state.turnUser = firstUser;
    state.firstUser = firstUser;
    state.flags = {};
    pushLogRaw(
      state,
      `${myName} joined the battle with ${borrowed ? "the shared deck " : ""}“${deck.name}”!`
    );
    pushLogRaw(state, `Opening coin flip: ${hostFirst ? hostName : myName} goes first.`);
    pushLogRaw(
      state,
      "Setup: play a Basic Pokémon as your Active and bench any other Basics. No Basic in hand? Redraw 7. Prize cards are already set — the app takes them on a knockout, draws you a card each turn, and calls the winner."
    );

    // Version guard: if someone else grabbed the seat between our read and
    // this write, zero rows match and we bail out instead of clobbering.
    const { data: updated, error: updateErr } = await admin
      .from("battles")
      .update({
        guest_user: user.id,
        status: "active",
        state,
        version: (battle.version as number) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", battle.id)
      .eq("status", "waiting")
      .eq("version", battle.version)
      .select("id");
    if (updateErr) throw updateErr;
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: "Someone else just joined that battle — ask your friend for a new code." },
        { status: 409 }
      );
    }
    return NextResponse.json({ id: battle.id });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
