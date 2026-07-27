import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: close or reopen your own post. Body: { status: "open" | "closed" } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { status } = (await req.json()) as { status?: string };
    if (status !== "open" && status !== "closed") {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from("trade_posts")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: remove your own post (admins can remove any — enforced by RLS). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    const { error } = await supabase.from("trade_posts").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
