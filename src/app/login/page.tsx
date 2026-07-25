"use client";

import { useState } from "react";

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="card-panel p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full border-4 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
          <h1 className="text-2xl font-bold">PokéDeck</h1>
          <p className="mt-1 text-sm text-slate-500">
            Scan your cards. Track your collection. Build decks with Trainer AI.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder={mode === "signup" ? "Choose a password (8+ characters)" : "Password"}
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn-primary w-full" disabled={busy}>
            {busy
              ? mode === "signup"
                ? "Creating account…"
                : "Signing in…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>

        <div className="mt-4 text-center text-sm">
          {mode === "signin" ? (
            <button className="text-poke-blue hover:underline" onClick={() => setMode("signup")}>
              First time here? Create your account
            </button>
          ) : (
            <button className="text-poke-blue hover:underline" onClick={() => setMode("signin")}>
              Already have an account? Sign in
            </button>
          )}
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">
          {mode === "signup"
            ? "Invite-only — your email must be on the invite list."
            : "Forgot your password? Ask the admin to reset it."}
        </p>
      </div>
    </div>
  );
}
