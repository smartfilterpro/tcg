"use client";

// The credits meter (replaces the old percentage AiMeter) and the boost
// sheet. A credit still maps to a cent of real cost internally — that is what
// keeps the ledger auditable — but the meter deliberately does NOT say so.
// Quoting the balance in dollars makes the whole allowance sound like pocket
// change; what the user needs to read is the count, what it has been spent
// on, and how much runway is left. No opaque percentages either.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BOOST_LIST, BOOSTS_NOTE } from "@/lib/boosts";
import { AI_NAME } from "@/lib/branding";

export interface CreditsInfo {
  balance: number;
  plan: string;
  pooled: boolean;
  cycleStart: string;
  monthlyGrant: number;
  spentByReason: Record<string, number>;
}

interface UsageMe {
  admin: boolean;
  calls: number;
  credits: CreditsInfo | null;
}

const REASON_LABELS: Record<string, string> = {
  scan: "Bulk scans",
  deck_build: "Deck builds",
  deck_review: "Deck reviews",
  coach: "Coach replies",
  chat: "TrainerAI chat",
  trade_chat: "Trade advisor",
  find_image: "Image searches",
  grade: "Grading reports",
  boost_refund: "Refunds",
  admin_grant: "Added by support",
  plan_expired: "Plan ended",
  admin_adjustment: "Support adjustment",
};

function refillDate(cycleStart: string): string {
  const d = new Date(cycleStart);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function spentTotal(c: CreditsInfo): number {
  return Object.values(c.spentByReason).reduce((s, v) => s + v, 0);
}

function spendSummary(c: CreditsInfo): string {
  const parts = Object.entries(c.spentByReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, credits]) => `${REASON_LABELS[reason] ?? reason} ${credits} cr`);
  return parts.length > 0 ? `Spent on: ${parts.join(" · ")}` : "Nothing spent yet this cycle.";
}

/** Bottom sheet with the three boost packs, 750 preselected. Auto-boost from
 *  the mock is deliberately absent until the server can actually do it —
 *  a toggle that silently does nothing is worse than none. */
export function BoostSheet({ balance, onClose }: { balance: number | null; onClose: () => void }) {
  // One source for the packs — this list used to be hand-copied from
  // BOOST_PACKS, and drifted the moment the packs were repriced.
  const packs = BOOST_LIST;
  const [pack, setPack] = useState(packs.find((p) => p.best)?.id ?? packs[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = packs.find((p) => p.id === pack)!;

  const [asked, setAsked] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/boost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack }),
      });
      const json = await res.json();
      // A kid profile can't reach Stripe. Rather than dead-end them on that
      // refusal, turn it into the ask — the parent decides on the family
      // page, pays with their own card, and the credits land in the pool
      // this child already spends from.
      if (res.status === 403) {
        const ask = await fetch("/api/family/boost-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pack }),
        });
        const aj = await ask.json();
        if (!ask.ok) throw new Error(aj.error || json.error || "Couldn't ask");
        setAsked(true);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(json.error || "Couldn't start the purchase");
      window.location.href = json.url as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the purchase");
      setBusy(false);
    }
  }

  // Rendered into the body, not where it was called from.
  //
  // The header opens this sheet, and the header is `z-40 bg-brand-ink
  // text-white`. Being a DOM descendant of it, the sheet inherited both:
  // every line without an explicit colour — the heading, each pack's credit
  // count, each price — came out white on cream and simply wasn't there.
  // And z-50 inside a z-40 stacking context cannot rise above a sibling at
  // z-40, so the chat button painted over the sheet's footer.
  //
  // Neither is a colour bug or a z-index bug; both are the same bug, which
  // is that an overlay was living inside a bar. A portal takes it out of the
  // header entirely, and the explicit text colour below means it no longer
  // depends on wherever it happens to be mounted.
  const sheet = (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-brand-ink/55 sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-[22px] bg-brand-canvas px-[18px] pb-[26px] pt-2.5 text-brand-ink sm:max-w-md sm:rounded-[22px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-[18px] h-1 w-[38px] rounded-full bg-brand-line-strong sm:hidden" />
        <h3 className="m-0 mb-1.5 font-display text-[23px] font-bold tracking-[-.025em]">Boost your credits</h3>
        <p className="m-0 mb-[18px] text-[14px] leading-[1.55] text-brand-ink3">
          {balance != null && balance > 0 ? (
            <>
              You have <b>{balance} credits</b> left.
            </>
          ) : (
            <>You&apos;re out of credits.</>
          )}{" "}
          Boost credits stack on top and stay with your account even if your plan ends.
        </p>
        <div className="flex flex-col gap-[9px]">
          {packs.map((p) => {
            const sel = p.id === pack;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPack(p.id)}
                className={`flex items-center justify-between gap-3 rounded-[14px] border-[1.5px] px-4 py-3.5 text-left ${
                  sel ? "border-brand-accent bg-[#F2F5FF]" : "border-brand-line bg-brand-panel"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[17px] font-bold">{p.credits}</span>
                    {p.best && (
                      <span className="rounded-[5px] bg-brand-highlight px-1.5 py-0.5 font-mono text-[10px] font-medium">
                        BEST VALUE
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-brand-ink3">{p.note}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="font-display text-[18px] font-bold">{p.price}</span>
                  <span
                    className={`h-5 w-5 rounded-full border-[1.5px] ${
                      sel ? "border-brand-accent bg-brand-accent" : "border-brand-line-strong bg-transparent"
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </div>
        {asked ? (
          <div className="mt-3.5 rounded-[14px] bg-brand-accent-tint px-4 py-3.5 text-center text-[13.5px] leading-[1.55] text-brand-ink2">
            Asked! A parent will see it on the family page and can say yes. Nothing is
            charged to you.
          </div>
        ) : (
          <button
            className="mt-3.5 w-full rounded-full bg-brand-ink px-4 py-[15px] text-[15.5px] font-medium text-brand-canvas transition-colors hover:bg-brand-accent disabled:opacity-50"
            disabled={busy}
            onClick={buy}
          >
            {busy ? "Opening checkout…" : `Buy ${chosen.credits} — ${chosen.price}`}
          </button>
        )}
        {error && <p className="mt-2 text-sm text-brand-negative">{error}</p>}
        <p className="mb-0 mt-2.5 text-center text-[11.5px] leading-[1.5] text-brand-ink5">
          {BOOSTS_NOTE} One-off charge, no subscription change. Credits are added straight away
          and the payment is final; they stay yours if you later cancel your plan.
        </p>
      </div>
    </div>
  );

  // Only after mount: document.body doesn't exist while rendering on the
  // server, and this component is reachable from a server-rendered header.
  return mounted ? createPortal(sheet, document.body) : null;
}

/** The collection-page meter. Three states: admin (unmetered), has credits,
 *  and out of credits — the last one leads with "everything else keeps
 *  working", because running dry must never read as broken. */
export default function CreditsMeter() {
  const [data, setData] = useState<UsageMe | null>(null);
  const [boost, setBoost] = useState(false);

  useEffect(() => {
    fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setData(j))
      .catch(() => {});
  }, []);

  if (!data) return null;

  if (data.admin) {
    return (
      <div className="mb-3.5 rounded-2xl border border-brand-line bg-white px-5 py-3 text-xs text-brand-ink3">
        🤖 {AI_NAME}: admin — unmetered · {data.calls} call{data.calls === 1 ? "" : "s"} this month
      </div>
    );
  }
  const c = data.credits;
  if (!c) return null;

  const spent = spentTotal(c);
  const grantish = Math.max(c.monthlyGrant, spent + Math.max(c.balance, 0), 1);
  const pct = Math.min(100, Math.max(2, (Math.max(c.balance, 0) / grantish) * 100));
  const planLabel = c.pooled ? "family pool" : c.plan === "pro" ? "Pro" : "trial";

  if (c.balance <= 0) {
    return (
      <>
        <div className="mb-3.5 rounded-2xl border border-brand-line bg-white p-5">
          <div className="mb-1.5 font-display text-[17px] font-bold">You&apos;re out of credits</div>
          <p className="m-0 mb-3.5 text-sm leading-relaxed text-brand-ink3">
            {c.monthlyGrant > 0 ? (
              <>
                Your {c.monthlyGrant.toLocaleString()} monthly credits refill on{" "}
                <b>{refillDate(c.cycleStart)}</b>.
              </>
            ) : (
              <>Your free credits are used up — they were a one-time grant.</>
            )}{" "}
            Everything except {AI_NAME} keeps working — you can still add cards by search, edit
            decks and battles.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-full bg-brand-ink px-[18px] py-[11px] text-sm font-medium text-brand-canvas" onClick={() => setBoost(true)}>
              Boost now
            </button>
            {c.plan === "free" && (
              <a href="/pricing" className="rounded-full border border-brand-line-strong bg-brand-panel px-[18px] py-[11px] text-sm font-medium">
                See Pro — 500 credits/mo
              </a>
            )}
          </div>
          {spent > 0 && (
            <div className="mt-3.5 rounded-[14px] bg-brand-sunken px-4 py-3.5 text-[13px] leading-relaxed text-brand-ink2">
              <b className="font-display">Where they went this cycle</b>
              <div className="mt-2.5 flex flex-col gap-[7px]">
                {Object.entries(c.spentByReason)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, credits]) => (
                    <div key={reason} className="flex items-center gap-2.5">
                      <span className="flex-1 text-[13px]">{REASON_LABELS[reason] ?? reason}</span>
                      <span
                        className="h-1.5 rounded-full bg-brand-accent"
                        style={{ width: `${Math.max(8, (credits / Math.max(spent, 1)) * 90)}px` }}
                      />
                      <span className="w-[52px] text-right font-mono text-[11.5px] text-brand-ink3">
                        {credits} cr
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
        {boost && <BoostSheet balance={c.balance} onClose={() => setBoost(false)} />}
      </>
    );
  }

  return (
    <>
      <div className="mb-3.5 rounded-2xl border border-brand-line bg-white px-5 py-[18px]">
        <div className="flex flex-wrap items-center gap-7">
          <div className="min-w-[280px] flex-[1_1_380px]">
            <div className="mb-2.5 flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-2xl font-bold tracking-[-.02em]">{c.balance.toLocaleString()}</span>
                <span className="text-sm text-brand-ink3">
                  {c.monthlyGrant > 0
                    ? `of ${c.monthlyGrant.toLocaleString()} ${planLabel} credits left`
                    : `${planLabel} credits left`}
                </span>
              </div>
              {/* The dollar equivalent used to sit here. It made the whole
                  allowance read as pocket change — "100 credits" sounds like
                  something, "≈ $1.00 of AI" sounds like nothing. What's
                  useful is what the credits BUY, so that's what it says. */}
              <span className="font-mono text-[11.5px] text-brand-ink4">
                {c.balance > 0
                  ? `about ${Math.max(1, Math.floor(c.balance / 3))} more scans`
                  : "refills next cycle"}
              </span>
            </div>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-brand-sunken">
              <span className="rounded-full bg-brand-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-4 text-[12.5px] text-brand-ink3">
              <span>{spendSummary(c)}</span>
              <a href="/settings/billing" className="text-brand-accent hover:underline">
                See history
              </a>
            </div>
          </div>
          <div className="flex min-w-[220px] flex-none flex-col gap-2">
            {c.plan === "free" && !c.pooled && (
              <div className="text-[13px] leading-[1.5] text-brand-ink2">
                Free trial credits don&apos;t refill. Pro adds <b>500 a month</b> for $9.
              </div>
            )}
            <div className="flex gap-2">
              {c.plan === "free" && !c.pooled && (
                <a href="/pricing" className="rounded-full bg-brand-highlight px-4 py-[9px] text-[13.5px] font-medium text-brand-ink">
                  Upgrade to Pro
                </a>
              )}
              <button
                className="rounded-full border border-brand-line-strong bg-brand-panel px-4 py-[9px] text-[13.5px] font-medium"
                onClick={() => setBoost(true)}
              >
                Buy credits
              </button>
            </div>
            <a href="/credits" className="text-[11px] text-brand-ink5 underline">
              What things cost
            </a>
          </div>
        </div>
      </div>
      {boost && <BoostSheet balance={c.balance} onClose={() => setBoost(false)} />}
    </>
  );
}

/** Artboard 02's inline upgrade prompt: free plan only, once there's a
 *  collection worth the pitch. Dark panel, highlight badge, one CTA. */
export function BulkScanNudge({ cards }: { cards: number }) {
  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && !j.admin && setPlan(j.credits?.plan ?? null))
      .catch(() => {});
  }, []);
  if (plan !== "free" || cards < 20) return null;
  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-[18px] rounded-2xl bg-brand-ink px-5 py-[18px] text-brand-canvas">
      <span className="rounded-full bg-brand-highlight px-2.5 py-1 font-mono text-[10.5px] font-medium tracking-[.06em] text-brand-ink">
        FREE PLAN
      </span>
      <span className="min-w-[280px] flex-1 text-[14.5px] leading-[1.5]">
        You&apos;ve added {cards.toLocaleString()} cards. <b>Bulk scan reads 20 at a time</b> — a
        whole pile in one photo.
      </span>
      <a
        href="/scan"
        className="rounded-full bg-brand-canvas px-5 py-2.5 text-sm font-medium text-brand-ink"
      >
        Try a bulk scan
      </a>
    </div>
  );
}
