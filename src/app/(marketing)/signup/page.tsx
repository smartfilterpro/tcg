"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell, authButton, authInput, authLabel } from "@/components/marketing/AuthShell";
import { SIGNUP_GRANT } from "@/lib/credits";
import { AI_NAME } from "@/lib/branding";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifySent, setVerifySent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) {
      setError("You need to agree to the Terms to create an account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding`,
          // Stamped into the profile by the auth callback once the email is
          // verified — the box they just ticked must not be asked twice.
          data: { tos_accepted_at: new Date().toISOString() },
        },
      });
      if (err) throw new Error(err.message);
      if (data.session) {
        // Email confirmations are off in this Supabase project: the account
        // is live immediately.
        window.location.href = "/onboarding";
        return;
      }
      setVerifySent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
    setBusy(false);
  }

  if (verifySent) {
    return (
      <AuthShell
        mode="signup"
        title="Check your email"
        sub={`We sent a confirmation link to ${email.trim()}. Open it on this device and you'll land in your collection.`}
      >
        <p className="text-[13.5px] leading-[1.6] text-brand-ink3">
          Nothing arriving? Check spam, or{" "}
          <button className="font-medium text-brand-accent hover:underline" onClick={() => setVerifySent(false)}>
            try a different address
          </button>
          .
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      mode="signup"
      title="Start free"
      sub={`Add cards, build decks and track value for nothing. ${AI_NAME} comes with ${SIGNUP_GRANT} credits to try.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={authLabel}>
          Email
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className={authInput}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={authLabel}>
          Password
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="8+ characters"
            className={authInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <div className="flex items-start gap-2.5 rounded-xl bg-brand-sunken px-3.5 py-3">
          <span className="whitespace-nowrap rounded-[5px] bg-brand-highlight px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-ink">
            FREE
          </span>
          <span className="text-[13px] leading-[1.5] text-brand-ink2">
            Starts on the free plan with <b>{SIGNUP_GRANT} {AI_NAME} credits</b> (about $1 of AI) so
            you can try bulk scanning and a deck build. No card needed.
          </span>
        </div>
        <label className="flex items-start gap-[9px] text-[12px] leading-[1.5] text-brand-ink3">
          <input
            type="checkbox"
            required
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-[15px] w-[15px] accent-brand-accent"
          />
          <span>
            I&apos;m 13 or older and agree to the{" "}
            <Link href="/terms" target="_blank" className="font-medium text-brand-accent hover:underline">
              Terms
            </Link>
            , including that prices and AI output are estimates and trades happen between members at
            their own risk.
          </span>
        </label>

        <button className={authButton} disabled={busy}>
          {busy ? "Creating your account…" : "Create my account"}
        </button>
        {error && <p className="text-sm text-brand-negative">{error}</p>}
        <p className="m-0 text-center text-[12.5px] text-brand-ink5">
          Cancel anytime. We never sell your collection data.
        </p>
      </form>
    </AuthShell>
  );
}
