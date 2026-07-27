"use client";

import { useState } from "react";
import Link from "next/link";

/** Signed-in members who haven't accepted the Terms are funneled here by the
 *  middleware — nothing else in the app is reachable until they agree. */
export default function AcceptTermsPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/accept-tos", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="card-panel p-8">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full border-4 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
          <h1 className="text-xl font-bold">Terms of Service</h1>
        </div>
        <p className="text-sm leading-relaxed text-slate-600">
          Before using PokéDeck you need to agree to the{" "}
          <Link href="/terms" target="_blank" className="font-medium text-poke-blue hover:underline">
            Terms of Service
          </Link>{" "}
          — they cover data accuracy, trades between members, messages, and age
          requirements. The rest of the app stays locked until you agree.
        </p>
        <button className="btn-primary mt-4 w-full" disabled={busy} onClick={accept}>
          I agree to the Terms of Service
        </button>
        <button className="btn-secondary mt-2 w-full" disabled={busy} onClick={decline}>
          I don&apos;t agree — sign me out
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
