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
      {/* One tappable pill, and on a phone a much smaller one.
       *
       *  The header is a nav bar first and a shop second, but this pill and
       *  the icons beside it were both shrink-0 while the nav was the only
       *  thing that could give — so on a 390px screen it gave everything.
       *  "Collection" became "Co" and Scan and Decks were pushed off the
       *  edge into a scroller with no visible handle. A free account, which
       *  is the one that gets shown a Boost button, was also the one that
       *  could not reach the rest of the app.
       *
       *  So: the word "credits" and the Boost button are desktop luxuries.
       *  On a phone the balance stands alone and the whole pill opens the
       *  sheet, which is one tap either way — the button was never doing
       *  anything the pill couldn't. */}
      <button
        className={`flex min-w-0 shrink items-center gap-2 rounded-full border py-1.5 pl-2.5 pr-2.5 sm:pl-3 sm:pr-2 ${
          empty ? "border-brand-highlight bg-brand-highlight" : "border-dark-line3 bg-dark-tile"
        }`}
        onClick={() => setBoost(true)}
        aria-label={`${credits.balance.toLocaleString()} credits — buy more`}
      >
        <span
          className={`whitespace-nowrap font-mono text-xs ${empty ? "text-brand-ink" : "text-white"}`}
        >
          {credits.balance.toLocaleString()}
          <span className="hidden sm:inline"> credits</span>
        </span>
        <span className="hidden rounded-full bg-brand-highlight px-3 py-1 text-xs font-medium text-brand-ink sm:inline">
          Boost
        </span>
      </button>
      {boost && <BoostSheet balance={credits.balance} onClose={() => setBoost(false)} />}
    </>
  );
}
