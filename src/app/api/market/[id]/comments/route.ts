import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { boardEnabled, BOARD_OFF_ERROR } from "@/lib/tradeBoard";

type Params = { params: Promise<{ id: string }> };

/** POST: reply to a trade post. Body: { body } */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user, profile } = await requireUser();
    if (!boardEnabled(profile)) {
      return NextResponse.json({ error: BOARD_OFF_ERROR }, { status: 403 });
    }
    if ((profile as { can_post_trades?: boolean | null } | null)?.can_post_trades === false) {
      return NextResponse.json(
        { error: "The admin has turned off trade posting for this account." },
        { status: 403 }
      );
    }
    const { id } = await params;
    const { body } = (await req.json()) as { body?: string };
    const text = body?.trim() ?? "";
    if (!text || text.length > 1000) {
      return NextResponse.json({ error: "Write a reply (max 1000 chars)." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("trade_post_comments")
      .insert({ post_id: id, user_id: user.id, body: text })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ comment: data });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}

/** DELETE: remove a reply — your own, or anyone's if you're the admin.
 *  That rule isn't re-implemented here: RLS on the table already says
 *  owner-or-admin, so the delete simply succeeds or touches nothing.
 *  Deliberately NOT behind the boardEnabled gate — moderation must work
 *  even on a profile whose board a parent switched off. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const { commentId } = (await req.json().catch(() => ({}))) as { commentId?: string };
    if (!commentId || typeof commentId !== "string") {
      return NextResponse.json({ error: "Missing commentId" }, { status: 400 });
    }
    const supabase = await createClient();
    // .select() so an RLS-blocked delete (0 rows) is distinguishable from
    // success — without it, "not allowed" would report ok.
    const { data, error } = await supabase
      .from("trade_post_comments")
      .delete()
      .eq("id", commentId)
      .eq("post_id", id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Not yours to remove." }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
