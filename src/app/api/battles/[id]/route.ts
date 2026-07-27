import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { redactState, type BattleState } from "@/lib/battle";
import { battleErrorResponse } from "../lib";

type Params = { params: Promise<{ id: string }> };

/** GET: this player's view of the battle (hidden info redacted). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const admin = createAdminClient();
    const { data: battle, error } = await admin
      .from("battles")
      .select("id, code, host_user, guest_user, status, winner_user, state, version")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!battle || (battle.host_user !== user.id && battle.guest_user !== user.id)) {
      return NextResponse.json({ error: "Battle not found." }, { status: 404 });
    }

    const state = battle.state as BattleState;
    if (battle.status === "waiting") {
      return NextResponse.json({
        status: "waiting",
        code: battle.code,
        version: battle.version,
      });
    }

    const oppId = battle.host_user === user.id ? (battle.guest_user as string) : (battle.host_user as string);
    return NextResponse.json({
      status: battle.status,
      code: battle.code,
      version: battle.version,
      opponentName: state.names?.[oppId] ?? "Trainer",
      myName: state.names?.[user.id] ?? "You",
      winnerName: battle.winner_user ? state.names?.[battle.winner_user as string] ?? null : null,
      youWon: battle.status === "finished" ? battle.winner_user === user.id : null,
      view: redactState(state, user.id, oppId),
    });
  } catch (err) {
    return battleErrorResponse(err);
  }
}

/** DELETE: remove a battle you're part of (cancel an open one, or clear a
 *  finished one off the list). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("battles")
      .delete()
      .eq("id", id)
      .or(`host_user.eq.${user.id},guest_user.eq.${user.id}`)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Battle not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
