import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Email + password sign-in. Account creation lives at /signup. */
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
    // Account creation moved to /signup (public, email-verified). This
    // endpoint predates it and created users invite-only with no email —
    // keeping both paths alive would mean two signup flows to secure.
    return NextResponse.json(
      { error: "Signup has moved — create your account at /signup." },
      { status: 410 }
    );
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
