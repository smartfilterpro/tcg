"use client";

// The out-of-credits state, in one place so every AI action says the same
// thing. A lock beside the button, and pressing it goes somewhere that can
// actually fix the problem rather than failing in place.
//
// Two escapes, always both, on every plan:
//
//   Boost   — buy credits now. Often the right answer, and the only one that
//             helps someone already on Family, who has nothing to upgrade to.
//   Upgrade — a bigger monthly allowance. Only offered when there is a tier
//             above the one they're on; showing "upgrade" to a Family
//             subscriber is an insult dressed as help.
//
// Nothing here hard-blocks anything that isn't a model call. Collections,
// decks, grading and battles keep working with a balance of zero.

import { useState } from "react";
import { BoostSheet } from "@/components/CreditsMeter";
import { AI_NAME } from "@/lib/branding";

/** The padlock that replaces an AI button's normal affordance. Pressing it
 *  opens the boost sheet — the fastest fix — with the upgrade route beside
 *  it for anyone who'd rather raise the monthly allowance. */
export function CreditLock({
  plan = "free",
  label = "Out of credits",
  className = "",
}: {
  plan?: string;
  label?: string;
  className?: string;
}) {
  const [boost, setBoost] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setBoost(true)}
        title={`You're out of ${AI_NAME} credits — add a boost or move up a plan`}
        className={`inline-flex items-center gap-1.5 rounded-full border border-brand-line-strong bg-brand-sunken px-3.5 py-2 text-[13px] font-medium text-brand-ink2 ${className}`}
      >
        <span aria-hidden>🔒</span>
        {label}
      </button>
      {boost && <BoostSheet balance={0} onClose={() => setBoost(false)} />}
      {plan !== "family" && (
        <a
          href="/pricing"
          className="ml-2 text-[13px] text-brand-accent underline underline-offset-2"
        >
          or upgrade
        </a>
      )}
    </>
  );
}

/** The same message as prose, for panels rather than buttons. */
export function OutOfCreditsNote({ plan = "free" }: { plan?: string }) {
  return (
    <p className="m-0 text-[13px] leading-[1.55] text-brand-ink3">
      You&apos;re out of {AI_NAME} credits, so new AI requests pause until they refill.
      Everything else — your collection, decks, grading and battles — keeps working.{" "}
      <a href="/settings/billing" className="underline">
        Add a boost
      </a>
      {plan !== "family" && (
        <>
          {" "}
          or{" "}
          <a href="/pricing" className="underline">
            move up a plan
          </a>
        </>
      )}
      .
    </p>
  );
}
