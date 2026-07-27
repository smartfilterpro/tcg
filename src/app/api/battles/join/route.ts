import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { buildSide, pushLogRaw, type BattleState } from "@/lib/battle";
import { battleErrorResponse, displayName, expandDeck } from "../lib";
import type { Deck } from "@/lib/types";

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
    const { data: deck, error: deckErr } = await supabase
      .from("decks")
      .select("*")
      .eq("id", body.deckId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (deckErr) throw deckErr;
    if (!deck) return NextResponse.json({ error: "Deck not found." }, { status: 404 });

    const cards = await expandDeck(admin, deck as Deck, "g");
    const myName = displayName(profile, user.email);
    const state = battle.state as BattleState;
    state.sides[user.id] = buildSide(cards);
    state.names[user.id] = myName;

    const hostName = state.names[battle.host_user as string] ?? "Trainer";
    const hostFirst = Math.random() < 0.5;
    state.turnUser = hostFirst ? (battle.host_user as string) : user.id;
    pushLogRaw(state, `${myName} joined the battle with “${(deck as Deck).name}”!`);
    pushLogRaw(state, `Opening coin flip: ${hostFirst ? hostName : myName} goes first.`);

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
