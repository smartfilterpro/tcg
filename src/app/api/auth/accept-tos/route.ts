import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserAndProfile, AuthError } from "@/lib/auth";

/** POST: record that the signed-in user accepted the Terms of Service.
 *  Uses getUserAndProfile directly — requireUser rejects users who haven't
 *  accepted yet, which is exactly who calls this endpoint. */
export async function POST() {
  try {
    const result = await getUserAndProfile();
    if (!result) throw new AuthError("Not authenticated");
    if (result.profile?.suspended === true) {
      throw new AuthError("Your account is suspended — contact the admin.", 403);
    }
    const { user } = result;
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
