import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import {
  applyAction,
  pushLog,
  pushLogRaw,
  redactState,
  BattleError,
  type BattleAction,
  type BattleState,
} from "@/lib/battle";
import { battleErrorResponse } from "../../lib";

type Params = { params: Promise<{ id: string }> };

/** POST: apply one move to the battle. Body: { action: BattleAction }.
 *  Uses optimistic concurrency (version column) so two simultaneous moves
 *  never overwrite each other — the loser of the race re-reads and retries. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { action } = (await req.json()) as { action?: BattleAction };
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      return NextResponse.json({ error: "Missing action." }, { status: 400 });
    }

    const admin = createAdminClient();

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: battle, error } = await admin
        .from("battles")
        .select("id, host_user, guest_user, status, winner_user, state, version")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!battle || (battle.host_user !== user.id && battle.guest_user !== user.id)) {
        return NextResponse.json({ error: "Battle not found." }, { status: 404 });
      }
      if (battle.status !== "active") {
        return NextResponse.json(
          { error: battle.status === "waiting" ? "Your opponent hasn't joined yet." : "This battle is over." },
          { status: 409 }
        );
      }

      const oppId =
        battle.host_user === user.id ? (battle.guest_user as string) : (battle.host_user as string);
      const state = battle.state as BattleState;
      const myName = state.names?.[user.id] ?? "Trainer";

      let status = battle.status as string;
      let winner: string | null = null;
      if (action.type === "concede") {
        status = "finished";
        winner = oppId;
        pushLogRaw(state, `${myName} conceded — ${state.names?.[oppId] ?? "their opponent"} wins! 🏆`);
      } else {
        const result = applyAction(state, user.id, oppId, action);
        pushLog(state, myName, result.text);
        if (result.winnerId) {
          status = "finished";
          winner = result.winnerId;
          pushLogRaw(state, `🏆 ${state.names?.[result.winnerId] ?? "The winner"} wins the battle!`);
        }
      }

      const { data: updated, error: updateErr } = await admin
        .from("battles")
        .update({
          state,
          status,
          winner_user: winner ?? battle.winner_user,
          version: (battle.version as number) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("version", battle.version)
        .select("id");
      if (updateErr) throw updateErr;
      if (updated && updated.length > 0) {
        return NextResponse.json({
          status,
          version: (battle.version as number) + 1,
          winnerName: winner ? state.names?.[winner] ?? null : null,
          youWon: status === "finished" ? winner === user.id : null,
          opponentName: state.names?.[oppId] ?? "Trainer",
          myName,
          view: redactState(state, user.id, oppId),
        });
      }
      // Version conflict — someone moved at the same instant. Re-read and retry.
    }
    return NextResponse.json(
      { error: "The table is moving fast — try that again." },
      { status: 409 }
    );
  } catch (err) {
    if (err instanceof BattleError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return battleErrorResponse(err);
  }
}
