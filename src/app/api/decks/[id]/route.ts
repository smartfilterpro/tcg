import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: toggle sharing this deck with the group. Body: { shared: boolean } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { shared } = (await req.json()) as { shared?: boolean };
    if (typeof shared !== "boolean") {
      return NextResponse.json({ error: "Missing shared flag" }, { status: 400 });
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from("decks")
      .update({ shared })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      if (/shared/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Deck sharing isn't set up yet — run supabase/migrations/008_sharing.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true, shared });
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

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    const { error } = await supabase.from("decks").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
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
