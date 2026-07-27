import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Email + password auth, invite-only signups.
 *  Body: { email, password, mode: "signin" | "signup" }
 *  Signup is allowed if (a) no users exist yet (bootstrap the admin) or
 *  (b) the email is on the invite list. No emails are ever sent. */
export async function POST(req: Request) {
  const { email, password, mode, tosAgreed } = (await req.json()) as {
    email?: string;
    password?: string;
    mode?: "signin" | "signup";
    tosAgreed?: boolean;
  };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }
  const normalized = email.trim().toLowerCase();
  const supabase = await createClient();

  if (mode === "signup" && tosAgreed !== true) {
    return NextResponse.json(
      { error: "You must agree to the Terms of Service to create an account." },
      { status: 400 }
    );
  }

  if (mode === "signup") {
    const admin = createAdminClient();
    const [{ count: profileCount }, { data: existing }, { data: invite }] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin.from("profiles").select("id").eq("email", normalized).maybeSingle(),
      admin.from("invites").select("id").eq("email", normalized).maybeSingle(),
    ]);

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists — sign in instead." },
        { status: 400 }
      );
    }
    const allowed = (profileCount ?? 0) === 0 || !!invite;
    if (!allowed) {
      return NextResponse.json(
        { error: "This email hasn't been invited yet. Ask the admin for an invite." },
        { status: 403 }
      );
    }

    // Create the user pre-confirmed (no confirmation email needed).
    const { error: createErr } = await admin.auth.admin.createUser({
      email: normalized,
      password,
      email_confirm: true,
    });
    if (createErr) {
      return NextResponse.json({ error: createErr.message }, { status: 500 });
    }
  }

  // Sign in (for both modes) — sets the session cookies on the response.
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: normalized,
    password,
  });
  if (signInErr) {
    const msg =
      signInErr.message === "Invalid login credentials"
        ? "Wrong email or password."
        : signInErr.message;
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  // Suspended members can't sign in (column exists after migration 011).
  const { data: prof } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", normalized)
    .maybeSingle();
  if (prof?.suspended === true) {
    await supabase.auth.signOut();
    return NextResponse.json(
      { error: "Your account is suspended — contact the admin." },
      { status: 403 }
    );
  }

  // Terms of Service acceptance (column exists after migration 016).
  // Skip enforcement gracefully on pre-migration databases.
  const tosTracked = prof != null && "tos_accepted_at" in prof;
  if (tosTracked && prof.tos_accepted_at == null) {
    if (tosAgreed === true) {
      await supabase
        .from("profiles")
        .update({ tos_accepted_at: new Date().toISOString() })
        .eq("id", prof.id);
    } else {
      // Session stays open so the accept endpoint can be called; the client
      // must show the Terms and either accept or sign out.
      return NextResponse.json({ ok: true, needsTos: true });
    }
  }

  return NextResponse.json({ ok: true });
}
