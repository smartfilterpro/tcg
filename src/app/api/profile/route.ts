import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** GET/PUT the play-style profile used to personalize deck building. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data } = await supabase
      .from("play_profiles")
      .select("style_notes, updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    return NextResponse.json({ styleNotes: data?.style_notes ?? "" });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const { user } = await requireUser();
    const { styleNotes } = (await req.json()) as { styleNotes?: string };
    if (typeof styleNotes !== "string" || styleNotes.length > 5000) {
      return NextResponse.json({ error: "Invalid style notes" }, { status: 400 });
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from("play_profiles")
      .upsert(
        { user_id: user.id, style_notes: styleNotes, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
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
