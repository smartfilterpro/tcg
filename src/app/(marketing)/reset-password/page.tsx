"use client";

// The other half of the reset flow: the emailed link lands here with a
// recovery session already in the cookies (via /auth/callback), so setting
// the new password is one updateUser call.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthShell, authButton, authInput, authLabel } from "@/components/marketing/AuthShell";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        throw new Error(
          /session/i.test(err.message)
            ? "This reset link has expired — request a fresh one from the login page."
            : err.message
        );
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
    setBusy(false);
  }

  return (
    <AuthShell
      mode="login"
      title={done ? "Password updated" : "Set a new password"}
      sub={
        done
          ? "You're signed in with the new password on this device."
          : "You followed a reset link, so you're temporarily signed in — choose the new password now."
      }
    >
      {done ? (
        <a href="/" className={`${authButton} block text-center`}>
          Go to my collection
        </a>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className={authLabel}>
            New password
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
          <label className={authLabel}>
            Repeat it
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Same again"
              className={authInput}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <button className={authButton} disabled={busy}>
            {busy ? "Saving…" : "Set new password"}
          </button>
          {error && <p className="text-sm text-brand-negative">{error}</p>}
        </form>
      )}
    </AuthShell>
  );
}
