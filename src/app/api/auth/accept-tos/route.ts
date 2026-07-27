import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** POST: record that the signed-in user accepted the Terms of Service. */
export async function POST() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { error } = await supabase
      .from("profiles")
      .update({ tos_accepted_at: new Date().toISOString() })
      .eq("id", user.id);
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
