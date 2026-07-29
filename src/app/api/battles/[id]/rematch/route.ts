import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { buildSide, pushLogRaw, type BattleState } from "@/lib/battle";
import { BOT_ID } from "@/lib/battleBot";
import type { Deck } from "@/lib/types";
import { battleErrorResponse, expandDeck, makeBattleCode } from "../../lib";

// Re-expanding two decks can mean fetching card data for anything new.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** POST: deal the same two decks again.
 *
 *  Both decks were authorised when this battle was created and joined —
 *  ownership, sharing scope and all — and a rematch replays exactly that
 *  pairing, so the deck ids recorded in the finished battle are re-read
 *  directly rather than re-authorised against whoever tapped the button.
 *  A deck that has since been deleted simply blocks the rematch. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const admin = createAdminClient();

    const { data: battle, error } = await admin
      .from("battles")
      .select("id, host_user, guest_user, status, state")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!battle || (battle.host_user !== user.id && battle.guest_user !== user.id)) {
      return NextResponse.json({ error: "Battle not found." }, { status: 404 });
    }

    const old = battle.state as BattleState;
    const deckIds = old.decks ?? {};
    const hostId = battle.host_user as string;
    const guestId = (battle.guest_user as string | null) ?? BOT_ID;
    const vsBot = battle.guest_user == null;

    if (!deckIds[hostId] || !deckIds[guestId]) {
      return NextResponse.json(
        {
          error:
            "This battle predates rematches, so the decks it used weren't recorded — start a new one from the Battles page.",
        },
        { status: 409 }
      );
    }

    const { data: decks, error: deckErr } = await admin
      .from("decks")
      .select("*")
      .in("id", [...new Set([deckIds[hostId], deckIds[guestId]])]);
    if (deckErr) throw deckErr;
    const byId = new Map((decks ?? []).map((d) => [d.id as string, d as Deck]));
    const hostDeck = byId.get(deckIds[hostId]);
    const guestDeck = byId.get(deckIds[guestId]);
    if (!hostDeck || !guestDeck) {
      return NextResponse.json(
        { error: "One of the decks from that battle no longer exists." },
        { status: 409 }
      );
    }

    const hostCards = await expandDeck(admin, hostDeck, "h", { userId: hostId });
    const guestCards = await expandDeck(admin, guestDeck, "g", {
      userId: vsBot ? hostId : guestId,
    });

    const hostName = old.names?.[hostId] ?? "Trainer";
    const guestName = old.names?.[guestId] ?? "Trainer";

    // Practice keeps the human first, same as a fresh practice battle, so
    // repeated runs stay comparable. A real rematch flips a fresh coin.
    const hostFirst = vsBot ? true : Math.random() < 0.5;
    const firstUser = hostFirst ? hostId : guestId;

    const state: BattleState = {
      sides: { [hostId]: buildSide(hostCards), [guestId]: buildSide(guestCards) },
      names: { [hostId]: hostName, [guestId]: guestName },
      decks: { [hostId]: hostDeck.id, [guestId]: guestDeck.id },
      allowSharedDecks: old.allowSharedDecks,
      firstUser,
      turnUser: firstUser,
      turnCount: 1,
      log: [],
    };
    pushLogRaw(
      state,
      `Rematch — ${hostName} (“${hostDeck.name}”) against ${guestName} (“${guestDeck.name}”). ${
        vsBot ? "You go first." : `${hostFirst ? hostName : guestName} goes first.`
      }`
    );
    pushLogRaw(
      state,
      "Prize cards are set. Play a Basic Pokémon as your Active, bench any others, then End turn."
    );

    for (let attempt = 0; attempt < 4; attempt++) {
      const code = makeBattleCode();
      const { data: created, error: insertErr } = await admin
        .from("battles")
        .insert({
          code,
          host_user: hostId,
          guest_user: vsBot ? null : guestId,
          status: "active",
          state,
        })
        .select("id, code")
        .single();
      if (!insertErr) return NextResponse.json({ id: created.id, code: created.code });
      if (insertErr.code !== "23505") throw insertErr;
    }
    return NextResponse.json({ error: "Couldn't create the rematch — try again." }, { status: 500 });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
