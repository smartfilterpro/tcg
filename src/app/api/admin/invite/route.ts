import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";

/** POST: invite a friend by email (admin only). */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin();
    const { email } = (await req.json()) as { email?: string };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    const normalized = email.trim().toLowerCase();
    const admin = createAdminClient();

    const { error: insertErr } = await admin
      .from("invites")
      .upsert({ email: normalized, invited_by: user.id }, { onConflict: "email" });
    if (insertErr) throw insertErr;

    // No email is sent — the admin shares the app link, and the invitee
    // creates their account with a password on the login page.
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: revoke a pending invite. Body: { email } */
export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const { email } = (await req.json()) as { email?: string };
    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });
    const admin = createAdminClient();
    const { error } = await admin.from("invites").delete().eq("email", email.trim().toLowerCase());
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
