import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** POST: reply to a trade post. Body: { body } */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
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
