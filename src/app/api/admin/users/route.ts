import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";

/** GET: all users + pending invites (admin only). */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const [{ data: profiles }, { data: invites }] = await Promise.all([
      admin.from("profiles").select("*").order("created_at"),
      admin.from("invites").select("*").order("created_at", { ascending: false }),
    ]);
    const profileEmails = new Set((profiles ?? []).map((p) => p.email));
    return NextResponse.json({
      users: profiles ?? [],
      invites: (invites ?? []).filter((i) => !profileEmails.has(i.email)),
    });
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
