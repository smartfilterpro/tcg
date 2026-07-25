"use client";

import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("sending");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong");
      setStatus("sent");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="card-panel p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full border-4 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
          <h1 className="text-2xl font-bold">PokéDeck</h1>
          <p className="mt-1 text-sm text-slate-500">
            Scan your cards. Track your collection. Build decks with Claude.
          </p>
        </div>

        {status === "sent" ? (
          <div className="rounded-lg bg-green-50 p-4 text-center text-sm text-green-800">
            ✉️ Check your email for a magic sign-in link.
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input
              type="email"
              required
              placeholder="you@example.com"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn-primary w-full" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <p className="text-center text-xs text-slate-400">
              Invite-only — ask the admin if you need access.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
