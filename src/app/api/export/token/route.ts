import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** GET: current export token (creates one if missing). POST: rotate. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    let { data } = await supabase
      .from("api_tokens")
      .select("token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) {
      const { data: created, error } = await supabase
        .from("api_tokens")
        .insert({ user_id: user.id })
        .select("token")
        .single();
      if (error) throw error;
      data = created;
    }
    return NextResponse.json({ token: data.token });
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
      .select("token")
      .single();
    if (error) throw error;
    return NextResponse.json({ token: data.token });
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
