import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { type BattleState } from "@/lib/battle";
import { battleErrorResponse } from "../../lib";

type Params = { params: Promise<{ id: string }> };

/** Filenames go into a Content-Disposition header, so anything a player
 *  typed has to come out as something a filesystem will accept. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "battle";
}

/** GET: the whole game log as a plain text file.
 *
 *  Deliberately the full stored log rather than the hundred entries the
 *  board shows — the point of exporting is to keep what scrolled away. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const admin = createAdminClient();
    const { data: battle, error } = await admin
      .from("battles")
      .select("id, code, host_user, guest_user, status, winner_user, state, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!battle || (battle.host_user !== user.id && battle.guest_user !== user.id)) {
      return NextResponse.json({ error: "Battle not found." }, { status: 404 });
    }

    const state = battle.state as BattleState;
    const names = state.names ?? {};
    const players = Object.values(names);
    const started = new Date(battle.created_at as string);

    const header = [
      `PokéDeck battle log`,
      players.length > 0 ? `Players: ${players.join(" vs ")}` : null,
      `Started: ${started.toLocaleString("en-GB", { timeZone: "UTC" })} UTC`,
      `Code: ${battle.code}`,
      battle.status === "finished"
        ? `Result: ${
            battle.winner_user
              ? `${names[battle.winner_user as string] ?? "Winner"} won`
              : // A practice win leaves the column null — the bot has no
                // profile row — so the log's own last line is the record.
                "finished"
          }`
        : `Status: ${battle.status}`,
      "",
    ].filter((l): l is string => l != null);

    const entries = state.log ?? [];
    // Times are relative to the first entry: "what happened when" in a game
    // is about pace, and a column of absolute timestamps buries that.
    const first = entries.length > 0 ? new Date(entries[0].at).getTime() : started.getTime();
    const body = entries.map((e) => {
      const secs = Math.max(0, Math.round((new Date(e.at).getTime() - first) / 1000));
      const stamp = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      return `[${stamp}] ${e.text}`;
    });

    const text = [...header, ...body, ""].join("\n");
    const name = `pokedeck-${slug(players.join("-vs-"))}-${started.toISOString().slice(0, 10)}.txt`;

    return new NextResponse(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
