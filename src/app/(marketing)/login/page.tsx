"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthShell, authButton, authInput, authLabel } from "@/components/marketing/AuthShell";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // /auth/callback sends a failed email link here with ?error=link, and this
  // page used to ignore it completely — so a confirmation or invitation link
  // that didn't verify looked exactly like being logged out for no reason.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("error") === "link") {
        setError(
          "That link didn't work — email links can only be used once and they expire. Ask for a new one and open it straight away."
        );
      }
    } catch {}
  }, []);

  /** An internal ?next= path when present (battle invites etc.), else home.
   *  A legacy account that hasn't accepted the Terms yet gets routed to
   *  /accept-terms by the middleware — no special handling needed here. */
  function afterLoginDest(): string {
    try {
      const n = new URLSearchParams(window.location.search).get("next");
      if (n && /^\/(?!\/)/.test(n)) return n;
    } catch {}
    return "/";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, mode: "signin" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong");
      window.location.href = afterLoginDest();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <AuthShell
      mode="login"
      title="Welcome back"
      sub="Pick up where you left off — your binder, decks and trades are waiting."
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
            autoComplete="current-password"
            placeholder="Password"
            className={authInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className={authButton} disabled={busy}>
          {busy ? "Signing in…" : "Log in"}
        </button>
        {error && <p className="text-sm text-brand-negative">{error}</p>}
        <p className="m-0 text-center text-[12.5px] text-brand-ink5">
          <Link href="/forgot-password" className="font-medium text-brand-accent hover:underline">
            Forgot your password?
          </Link>{" "}
          We&apos;ll email you a reset link.
        </p>
      </form>
    </AuthShell>
  );
}
