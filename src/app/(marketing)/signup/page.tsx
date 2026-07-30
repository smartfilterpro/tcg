"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell, authButton, authInput, authLabel } from "@/components/marketing/AuthShell";
import { MONTHLY_GRANT, SIGNUP_GRANT } from "@/lib/credits";
import { AI_NAME } from "@/lib/branding";

type PlanChoice = "free" | "pro" | "family";

/** What each choice commits you to, stated before the button is pressed. The
 *  numbers come from the same constants the pricing page renders, so a
 *  repricing can't leave the signup form quoting the old figures. */
const CHOICES: Record<
  PlanChoice,
  { name: string; price: string; per: string; credits: string; blurb: string }
> = {
  free: {
    name: "Free",
    price: "$0",
    per: "forever",
    credits: `${SIGNUP_GRANT} credits, once`,
    blurb: "Collect, catalogue and build by hand. No card needed.",
  },
  pro: {
    name: "Pro",
    price: "$9",
    per: "/ month",
    credits: `${MONTHLY_GRANT.pro} credits a month`,
    blurb: "Bulk scanning, deck building, coaching and grading reports.",
  },
  family: {
    name: "Family",
    price: "$19",
    per: "/ month",
    credits: `${MONTHLY_GRANT.family.toLocaleString()} shared credits a month`,
    blurb: "Up to 5 profiles on one bill, with per-profile limits you set.",
  },
};

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState<PlanChoice>("free");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifySent, setVerifySent] = useState(false);

  // /signup?plan=pro from the pricing page. The param used to be dropped, so
  // every arrival — including someone who had just clicked "Go Pro" — got the
  // free plan and no way to pay.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("plan");
    if (wanted === "pro" || wanted === "family") setPlan(wanted);
  }, []);

  const paid = plan !== "free";
  /** Where the account lands once it exists. A paid choice goes to Checkout;
   *  the GET form of that route exists precisely so it can be a redirect
   *  target at the end of a confirmation email. */
  const destination = paid ? `/api/billing/checkout?plan=${plan}` : "/onboarding";

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
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
          data: {
            // Stamped into the profile by the auth callback once the email is
            // verified — the box they just ticked must not be asked twice.
            tos_accepted_at: new Date().toISOString(),
            // Recorded for the owner dashboard: which plan someone came in
            // for, whether or not they finish paying. Plan state itself only
            // ever comes from the Stripe webhook.
            signup_plan: plan,
          },
        },
      });
      if (err) throw new Error(err.message);
      if (data.session) {
        // Email confirmations are off in this Supabase project: the account
        // is live immediately, so go straight on to payment.
        window.location.href = destination;
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
        sub={
          paid
            ? `We sent a confirmation link to ${email.trim()}. Open it and you'll go straight to payment for ${CHOICES[plan].name} — nothing is charged until you do.`
            : `We sent a confirmation link to ${email.trim()}. Open it on this device and you'll land in your collection.`
        }
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
      title={paid ? `Start on ${CHOICES[plan].name}` : "Start free"}
      sub={
        paid
          ? `Create your account, then pay. ${AI_NAME} credits land the moment the payment clears, and you can cancel any time.`
          : `Add cards, build decks and track value for nothing. ${AI_NAME} comes with ${SIGNUP_GRANT} credits to try.`
      }
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

        {/* Pick a plan here rather than assuming free. Free stays the default
            and stays selectable — the paid tiers are an offer, not a wall. */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${authLabel} mb-1.5`}>Plan</legend>
          {(Object.keys(CHOICES) as PlanChoice[]).map((key) => {
            const c = CHOICES[key];
            const chosen = plan === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPlan(key)}
                aria-pressed={chosen}
                className={`flex items-center gap-3 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-colors ${
                  chosen ? "border-brand-accent bg-brand-accent-tint" : "border-brand-line bg-white"
                }`}
              >
                <span
                  className={`mt-0.5 h-[17px] w-[17px] shrink-0 rounded-full border-[1.5px] ${
                    chosen ? "border-brand-accent bg-brand-accent" : "border-brand-line-strong"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <b className="font-display text-[15px] font-bold">{c.name}</b>
                    <span className="font-mono text-[12px] text-brand-ink4">{c.credits}</span>
                  </span>
                  <span className="mt-px block text-[12.5px] leading-[1.45] text-brand-ink3">
                    {c.blurb}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-display text-[17px] font-bold">{c.price}</span>
                  <span className="block text-[11px] text-brand-ink5">{c.per}</span>
                </span>
              </button>
            );
          })}
        </fieldset>
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
          {busy
            ? "Creating your account…"
            : paid
              ? `Create account & pay ${CHOICES[plan].price}`
              : "Create my account"}
        </button>
        {error && <p className="text-sm text-brand-negative">{error}</p>}
        <p className="m-0 text-center text-[12.5px] leading-[1.5] text-brand-ink5">
          {paid
            ? "The card details go to Stripe, never to us. Nothing is charged until checkout completes, and you can cancel any time."
            : "Cancel anytime. We never sell your collection data."}
        </p>
        {paid && (
          <button
            type="button"
            className="m-0 text-center text-[12.5px] text-brand-ink4 hover:underline"
            onClick={() => setPlan("free")}
          >
            Or start free and upgrade later
          </button>
        )}
      </form>
    </AuthShell>
  );
}
