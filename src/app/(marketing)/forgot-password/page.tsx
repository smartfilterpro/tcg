"use client";

// Undesigned in the handoff (flagged there as such) — built minimal in the
// auth-card style rather than invented beyond it.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthShell, authButton, authInput, authLabel } from "@/components/marketing/AuthShell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Arrived here from a reset link that didn't work. */
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    setExpired(new URLSearchParams(window.location.search).get("expired") === "1");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (err) throw new Error(err.message);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
    setBusy(false);
  }

  return (
    <AuthShell
      mode="login"
      title={sent ? "Check your email" : "Reset your password"}
      sub={
        sent
          ? `If an account exists for ${email.trim()}, a reset link is on its way. Open it on this device.`
          : "Enter your account email and we'll send you a link to set a new password."
      }
    >
      {!sent && expired && (
        <p className="mb-3 rounded-xl bg-brand-sunken px-3.5 py-3 text-[13.5px] leading-[1.6] text-brand-ink2">
          That reset link didn&apos;t work — they can only be used once, and they expire.
          Some email apps also open links to scan them, which uses the link up before you
          get to it. Ask for a fresh one below and open it straight away.
        </p>
      )}
      {!sent && (
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
          <button className={authButton} disabled={busy}>
            {busy ? "Sending…" : "Email me a reset link"}
          </button>
          {error && <p className="text-sm text-brand-negative">{error}</p>}
        </form>
      )}
    </AuthShell>
  );
}
