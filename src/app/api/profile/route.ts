import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { errorJson } from "@/lib/apiError";

/** GET/PUT the play-style profiles used to personalize deck building —
 *  one per game, because "fast Fire decks" is not Commander advice.
 *  select("*") on purpose: pre-078 rows simply lack the Magic column and
 *  read as empty instead of erroring. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data } = await supabase
      .from("play_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    const row = (data ?? null) as { style_notes?: string; mtg_style_notes?: string } | null;
    return NextResponse.json({
      styleNotes: row?.style_notes ?? "",
      mtgStyleNotes: row?.mtg_style_notes ?? "",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const { user } = await requireUser();
    const { styleNotes, mtgStyleNotes } = (await req.json()) as {
      styleNotes?: string;
      mtgStyleNotes?: string;
    };
    const bad = (v: unknown) => v !== undefined && (typeof v !== "string" || v.length > 5000);
    if (bad(styleNotes) || bad(mtgStyleNotes) || (styleNotes === undefined && mtgStyleNotes === undefined)) {
      return NextResponse.json({ error: "Invalid style notes" }, { status: 400 });
    }
    const supabase = await createClient();
    const patch: Record<string, string> = { updated_at: new Date().toISOString() };
    if (styleNotes !== undefined) patch.style_notes = styleNotes;
    if (mtgStyleNotes !== undefined) patch.mtg_style_notes = mtgStyleNotes;
    const { error } = await supabase
      .from("play_profiles")
      .upsert({ user_id: user.id, ...patch }, { onConflict: "user_id" });
    if (error) {
      if (/mtg_style_notes/.test(error.message)) {
        return NextResponse.json(
          { error: "The Magic profile needs a database update — run supabase/migrations/078_mtg_play_profile.sql." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return errorJson(err, "Request failed");
}
