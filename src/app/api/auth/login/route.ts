import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Invite-only magic-link login.
 *  Allows the email if (a) no users exist yet (bootstrap the admin),
 *  (b) the email already has a profile, or (c) the email was invited. */
export async function POST(req: Request) {
  const { email } = (await req.json()) as { email?: string };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const normalized = email.trim().toLowerCase();

  const admin = createAdminClient();
  const [{ count: profileCount }, { data: existing }, { data: invite }] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }),
    admin.from("profiles").select("id").eq("email", normalized).maybeSingle(),
    admin.from("invites").select("id").eq("email", normalized).maybeSingle(),
  ]);

  const allowed = (profileCount ?? 0) === 0 || !!existing || !!invite;
  if (!allowed) {
    return NextResponse.json(
      { error: "This email hasn't been invited yet. Ask the admin for an invite." },
      { status: 403 }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
