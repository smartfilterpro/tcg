import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { buildSide, pushLogRaw, type BattleState } from "@/lib/battle";
import {
  battleErrorResponse,
  displayName,
  expandDeck,
  isMissingBattlesTable,
  loadBattleDeck,
  makeBattleCode,
} from "./lib";

// First battle with a deck fetches card data + compiles trainer effects.
export const maxDuration = 120;

/** GET: my battles (host or guest), newest activity first. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("battles")
      .select("id, code, host_user, guest_user, status, winner_user, created_at, updated_at")
      .or(`host_user.eq.${user.id},guest_user.eq.${user.id}`)
      .order("updated_at", { ascending: false })
      .limit(25);
    if (error) {
      if (isMissingBattlesTable(error)) return NextResponse.json({ battles: [], migrated: false });
      throw error;
    }

    const otherIds = [
      ...new Set(
        (data ?? [])
          .flatMap((b) => [b.host_user as string, b.guest_user as string | null])
          .filter((id): id is string => !!id && id !== user.id)
      ),
    ];
    const nameById = new Map<string, string>();
    if (otherIds.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .in("id", otherIds);
      for (const p of profiles ?? []) {
        nameById.set(
          p.id as string,
          (p.display_name as string | null)?.trim() || (p.email as string).split("@")[0]
        );
      }
    }

    const battles = (data ?? []).map((b) => {
      const oppId = b.host_user === user.id ? (b.guest_user as string | null) : (b.host_user as string);
      return {
        id: b.id as string,
        code: b.code as string,
        status: b.status as string,
        youAreHost: b.host_user === user.id,
        opponentName: oppId ? nameById.get(oppId) ?? "Trainer" : null,
        youWon: b.status === "finished" ? b.winner_user === user.id : null,
        updatedAt: b.updated_at as string,
      };
    });
    return NextResponse.json({ battles, migrated: true });
  } catch (err) {
    return battleErrorResponse(err);
  }
}

/** POST: create a battle with one of my decks. Returns the join code to
 *  share with a friend. Body: { deckId } */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { deckId, allowShared } = (await req.json()) as {
      deckId?: string;
      allowShared?: boolean;
    };
    if (!deckId || typeof deckId !== "string") {
      return NextResponse.json({ error: "Pick a deck to battle with." }, { status: 400 });
    }

    const supabase = await createClient();
    // Hosting with a borrowed deck implies the battle allows shared decks.
    const loaded = await loadBattleDeck(supabase, user.id, deckId, true);
    if ("error" in loaded) {
      return NextResponse.json({ error: loaded.error }, { status: 404 });
    }
    const { deck, borrowed } = loaded;
    const allowSharedDecks = allowShared === true || borrowed;

    const admin = createAdminClient();
    const cards = await expandDeck(admin, deck, "h", { userId: user.id });
    const myName = displayName(profile, user.email);

    const state: BattleState = {
      sides: { [user.id]: buildSide(cards) },
      names: { [user.id]: myName },
      allowSharedDecks,
      turnUser: null,
      turnCount: 1,
      log: [],
    };
    pushLogRaw(
      state,
      `${myName} set up the table with ${borrowed ? "the shared deck " : ""}“${deck.name}” — waiting for an opponent.`
    );

    // Retry on the (unlikely) code collision.
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = makeBattleCode();
      const { data: created, error } = await admin
        .from("battles")
        .insert({ code, host_user: user.id, status: "waiting", state })
        .select("id, code")
        .single();
      if (!error) return NextResponse.json({ id: created.id, code: created.code });
      if (error.code !== "23505") throw error;
    }
    return NextResponse.json({ error: "Couldn't create a battle code — try again." }, { status: 500 });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
