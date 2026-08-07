import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { errorJson } from "@/lib/apiError";

/** GET: current export token (creates one if missing). POST: rotate.
 *
 *  last_used_at rides along on both, because the point of showing this in
 *  Settings is that a member can look at when their link was last used and
 *  rotate it if the answer surprises them. Pre-migration-056 databases have
 *  no such column and simply report nothing. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    let { data } = await supabase
      .from("api_tokens")
      .select("token, created_at, last_used_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) {
      const { data: created, error } = await supabase
        .from("api_tokens")
        .insert({ user_id: user.id })
        .select("token, created_at, last_used_at")
        .single();
      if (error) throw error;
      data = created;
    }
    return NextResponse.json(tokenBody(data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    await supabase.from("api_tokens").delete().eq("user_id", user.id);
    const { data, error } = await supabase
      .from("api_tokens")
      .insert({ user_id: user.id })
      .select("token, created_at, last_used_at")
      .single();
    if (error) throw error;
    return NextResponse.json(tokenBody(data));
  } catch (err) {
    return errorResponse(err);
  }
}

function tokenBody(row: Record<string, unknown>) {
  return {
    token: row.token as string,
    createdAt: (row.created_at as string | null) ?? null,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return errorJson(err, "Request failed");
}
