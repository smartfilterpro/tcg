import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import type { BattleState } from "@/lib/battle";
import { battleErrorResponse } from "../../lib";

type Params = { params: Promise<{ id: string }> };

/** GET: the caller's OWN deck contents for a deck search, sorted A→Z so the
 *  deck's actual order is never revealed (searching always ends in a
 *  shuffle anyway). Opponents can't see this — it's your own cards only. */
export async function GET(_req: Request, { params }: Params) {
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
    if (battle.status !== "active") {
      return NextResponse.json({ error: "This battle isn't in progress." }, { status: 409 });
    }
    const state = battle.state as BattleState;
    const deck = state.sides?.[user.id]?.deck ?? [];
    const cards = [...deck]
      .map((c) => ({ uid: c.uid, name: c.name, image: c.image, big: c.big ?? null, cat: c.cat ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ cards });
  } catch (err) {
    return battleErrorResponse(err);
  }
}
