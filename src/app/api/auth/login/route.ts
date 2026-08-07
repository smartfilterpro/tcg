import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  clearLoginFailures,
  clientIp,
  loginRetryAfter,
  noteLoginFailure,
} from "@/lib/loginThrottle";

/** What to say about a refused sign-in. Security audit finding L4.
 *
 *  Only the two states a person can act on get their own sentence. Every
 *  other message the auth provider produces — its own rate-limit prose, its
 *  internal states, whatever a future version starts returning — becomes the
 *  neutral one, because a sign-in failure is the last place to be
 *  improvising text at somebody who might not own the account. */
function signInMessage(providerMessage: string): string {
  const m = providerMessage.toLowerCase();
  if (m.includes("email not confirmed")) {
    return "Check your email and confirm your address before signing in.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts just now. Wait a minute and try again.";
  }
  return "Wrong email or password.";
}

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

  // Too many recent failures against this email or from this address?
  // Checked before the password is spent, so a locked key costs one cheap
  // read rather than a round trip to the auth provider.
  const admin = createAdminClient();
  const keys = { email: normalized, ip: clientIp(req) };
  const retryAfter = await loginRetryAfter(admin, keys);
  if (retryAfter > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return NextResponse.json(
      {
        error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // Sign in (for both modes) — sets the session cookies on the response.
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: normalized,
    password,
  });
  if (signInErr) {
    const locked = await noteLoginFailure(admin, keys);
    if (locked) {
      // The one moment worth a line in the log: either somebody is being
      // attacked or somebody is stuck, and neither is visible otherwise.
      console.warn(`login locked out: ${normalized} from ${keys.ip ?? "unknown address"}`);
    }
    return NextResponse.json({ error: signInMessage(signInErr.message) }, { status: 401 });
  }
  await clearLoginFailures(admin, keys);

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
