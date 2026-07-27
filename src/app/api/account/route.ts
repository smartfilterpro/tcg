import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** PATCH: set your username (display_name). Body: { displayName } */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const { displayName } = (await req.json()) as { displayName?: string };
    const name = displayName?.trim() ?? "";
    if (name.length < 2 || name.length > 30 || !/^[\p{L}\p{N} ._'-]+$/u.test(name)) {
      return NextResponse.json(
        { error: "Username must be 2-30 characters (letters, numbers, spaces, . _ ' -)." },
        { status: 400 }
      );
    }
    const supabase = await createClient();

    // Soft uniqueness: avoid two members with the same visible name
    const { data: clash } = await supabase
      .from("profiles")
      .select("id")
      .ilike("display_name", name)
      .neq("id", user.id)
      .limit(1)
      .maybeSingle();
    if (clash) {
      return NextResponse.json(
        { error: "That username is already taken — try another." },
        { status: 409 }
      );
    }

    const { error } = await supabase
      .from("profiles")
      .update({ display_name: name })
      .eq("id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true, displayName: name });
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
