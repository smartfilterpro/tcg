"use client";

// The header credits pill: balance at a glance, Boost one tap away. Admins
// see nothing — they're unmetered, and a fake number would only mislead.

import { useEffect, useState } from "react";
import { BoostSheet, type CreditsInfo } from "@/components/CreditsMeter";

export default function HeaderCredits() {
  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [boost, setBoost] = useState(false);

  useEffect(() => {
    fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.credits && setCredits(j.credits))
      .catch(() => {});
  }, []);

  if (!credits) return null;
  const empty = credits.balance <= 0;

  return (
    <>
      <span
        className={`flex shrink-0 items-center gap-2 rounded-full border py-1.5 pl-3 pr-2 ${
          empty ? "border-brand-highlight bg-brand-highlight" : "border-dark-line3 bg-dark-tile"
        }`}
      >
        <span className={`font-mono text-xs ${empty ? "text-brand-ink" : "text-white"}`}>
          {credits.balance.toLocaleString()} credits
        </span>
        <button
          className="rounded-full bg-brand-highlight px-3 py-1 text-xs font-medium text-brand-ink"
          onClick={() => setBoost(true)}
        >
          Boost
        </button>
      </span>
      {boost && <BoostSheet balance={credits.balance} onClose={() => setBoost(false)} />}
    </>
  );
}
