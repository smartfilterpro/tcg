import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { buildSide, pushLogRaw, type BattleState } from "@/lib/battle";
import { BOT_ID } from "@/lib/battleBot";

/** Shown as the practice opponent's name in the log and on the board. */
const BOT_NAME = "Trainer AI";
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
    const { user, profile } = await requireUser();
    const isAdmin = profile?.role === "admin";
    // Practice-vs-bot is admin-only, and back to being so deliberately: the
    // bot plays badly enough that it was never worth charging for, and it
    // briefly shipped as a Pro perk. Two-player battles are free for
    // everyone and always were — there is no model call in a battle.
    const practiceAllowed = isAdmin;
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("battles")
      .select("id, code, host_user, guest_user, status, winner_user, created_at, updated_at")
      .or(`host_user.eq.${user.id},guest_user.eq.${user.id}`)
      .order("updated_at", { ascending: false })
      .limit(25);
    if (error) {
      if (isMissingBattlesTable(error)) {
        return NextResponse.json({ battles: [], migrated: false, isAdmin, practiceAllowed });
      }
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
      // A practice battle is live with nobody in the second seat — that seat
      // belongs to the bot, which has no profile row to name.
      const vsBot = !b.guest_user && b.status !== "waiting";
      return {
        id: b.id as string,
        code: b.code as string,
        status: b.status as string,
        youAreHost: b.host_user === user.id,
        vsBot,
        opponentName: vsBot ? BOT_NAME : oppId ? nameById.get(oppId) ?? "Trainer" : null,
        youWon: b.status === "finished" ? b.winner_user === user.id : null,
        updatedAt: b.updated_at as string,
      };
    });
    return NextResponse.json({ battles, migrated: true, isAdmin, practiceAllowed });
  } catch (err) {
    return battleErrorResponse(err);
  }
}

/** POST: create a battle with one of my decks. Returns the join code to
 *  share with a friend. Body: { deckId } */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { deckId, allowShared, vsBot, botDeckId } = (await req.json()) as {
      deckId?: string;
      allowShared?: boolean;
      vsBot?: boolean;
      botDeckId?: string;
    };
    // Practice battles are admin-only. Refused rather than quietly downgraded
    // to a two-player battle: asking for the bot and silently getting an
    // empty seat is worse than being told no.
    const practice = vsBot === true;
    if (practice && profile?.role !== "admin") {
      return NextResponse.json(
        { error: "Practice battles against the bot aren't available yet." },
        { status: 403 }
      );
    }
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

    if (practice) {
      const botDeck = await loadBattleDeck(supabase, user.id, botDeckId || deckId, true);
      if ("error" in botDeck) {
        return NextResponse.json({ error: botDeck.error }, { status: 404 });
      }
      const botCards = await expandDeck(admin, botDeck.deck, "b", { userId: user.id });
      // The human always goes first: no coin flip to explain, and it keeps
      // the opening turn's rules the same every time you test.
      const state: BattleState = {
        sides: { [user.id]: buildSide(cards), [BOT_ID]: buildSide(botCards) },
        names: { [user.id]: myName, [BOT_ID]: BOT_NAME },
        decks: { [user.id]: deck.id, [BOT_ID]: botDeck.deck.id },
        allowSharedDecks,
        firstUser: user.id,
        turnUser: user.id,
        turnCount: 1,
        log: [],
      };
      pushLogRaw(
        state,
        `${myName} started a practice battle: “${deck.name}” against ${BOT_NAME} playing “${botDeck.deck.name}”. You go first.`
      );
      pushLogRaw(
        state,
        "Prize cards are set. Play a Basic Pokémon as your Active, bench any others, then End turn."
      );
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = makeBattleCode();
        const { data: created, error } = await admin
          .from("battles")
          .insert({ code, host_user: user.id, status: "active", state })
          .select("id, code")
          .single();
        if (!error) return NextResponse.json({ id: created.id, code: created.code });
        if (error.code !== "23505") throw error;
      }
      return NextResponse.json({ error: "Couldn't create the battle — try again." }, { status: 500 });
    }

    const state: BattleState = {
      sides: { [user.id]: buildSide(cards) },
      names: { [user.id]: myName },
      decks: { [user.id]: deck.id },
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
