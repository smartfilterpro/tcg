import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** POST: send a direct message to a pal. `id` is the friendship id.
 *  Body: { body } */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { body } = (await req.json()) as { body?: string };
    const text = body?.trim() ?? "";
    if (!text || text.length > 4000) {
      return NextResponse.json({ error: "Write a message (max 4000 characters)." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: friendship, error: fErr } = await supabase
      .from("friendships")
      .select("id, status, requester, addressee")
      .eq("id", id)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!friendship || (friendship.requester !== user.id && friendship.addressee !== user.id)) {
      return NextResponse.json({ error: "Pal not found." }, { status: 404 });
    }
    if (friendship.status !== "accepted") {
      return NextResponse.json({ error: "You can only message accepted pals." }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("friend_messages")
      .insert({ friendship_id: id, sender: user.id, body: text })
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: "Message didn't save — run supabase/migrations/020_pals.sql if this keeps happening." },
        { status: 400 }
      );
    }
    // Bump the thread for ordering (best-effort)
    await supabase
      .from("friendships")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id)
      .then(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("pal message error", err);
    const message =
      err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === "string"
          ? (err as { message: string }).message
          : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
