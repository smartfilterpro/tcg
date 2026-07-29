"use client";

// Billing settings, from App Screens artboard 06. The dark plan card, the
// cycle's credit bar, and the charge table. The payment-method card from the
// mock is a portal link instead: cards live in Stripe, and rendering a
// half-synced copy of them here would drift.

import { useEffect, useState } from "react";
import { BoostSheet, type CreditsInfo } from "@/components/CreditsMeter";

interface BillingData {
  plan: string;
  planCents: number;
  renewsAt: string | null;
  expiresAt: string | null;
  stripeConfigured: boolean;
  hasStripeCustomer: boolean;
  credits: CreditsInfo;
  charges: Array<{ at: string; what: string; credits: number; amountCents: number }>;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [boost, setBoost] = useState(false);

  useEffect(() => {
    fetch("/api/billing")
      .then((r) => r.json().then((j) => (r.ok ? setData(j) : setError(j.error))))
      .catch(() => setError("Couldn't load billing"));
  }, []);

  async function post(label: string, path: string, body?: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${label} failed`);
      window.location.href = json.url as string;
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
      setBusy(null);
    }
  }

  if (error && !data) return <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-slate-500">Loading…</p>;

  const c = data.credits;
  const spent = Object.values(c.spentByReason).reduce((s, v) => s + v, 0);
  const grant = Math.max(c.monthlyGrant, 1);
  const usedPct = c.monthlyGrant > 0 ? Math.min(100, (spent / grant) * 100) : 0;
  const planName = data.plan === "family" ? "Family" : data.plan === "pro" ? "Pro" : "Free";

  return (
    <div className="max-w-3xl">
      <h2 className="m-0 mb-1 font-display text-2xl font-bold tracking-[-.025em]">Billing</h2>
      <p className="m-0 mb-6 text-[14.5px] text-brand-ink3">
        Your plan, your credits, and every charge we&apos;ve ever made.
      </p>
      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="mb-4 flex flex-wrap gap-4">
        {/* plan card */}
        <div className="min-w-[300px] flex-[1_1_420px] rounded-[18px] bg-brand-ink p-6 text-brand-canvas">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[.1em] text-dark-ink4">Current plan</div>
              <div className="mt-1.5 font-display text-3xl font-bold tracking-[-.03em]">{planName}</div>
              <div className="mt-0.5 text-sm text-dark-ink3">
                {data.plan === "free"
                  ? "No subscription — one-time trial credits"
                  : data.expiresAt
                    ? `$${(data.planCents / 100).toFixed(2)} / month · ends ${fmtDate(data.expiresAt)}`
                    : `$${(data.planCents / 100).toFixed(2)} / month${data.renewsAt ? ` · renews ${fmtDate(data.renewsAt)}` : ""}`}
              </div>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 font-mono text-[10.5px] ${
                data.expiresAt ? "bg-brand-warning text-brand-ink" : "bg-brand-highlight text-brand-ink"
              }`}
            >
              {data.plan === "free" ? "FREE" : data.expiresAt ? "ENDING" : "ACTIVE"}
            </span>
          </div>
          <div className="mt-[22px] border-t border-dark-line2 pt-[18px]">
            {c.monthlyGrant > 0 && (
              <>
                <div className="mb-2 flex justify-between text-[13px] text-dark-ink3">
                  <span>Credits this cycle{c.pooled ? " (family pool)" : ""}</span>
                  <span className="font-mono">
                    {spent.toLocaleString()} of {c.monthlyGrant.toLocaleString()} used
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-dark-line2">
                  <span className="block h-full bg-brand-highlight" style={{ width: `${Math.max(usedPct, 2)}%` }} />
                </div>
              </>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-full bg-brand-highlight px-[18px] py-2.5 text-[13.5px] font-medium text-brand-ink"
                onClick={() => setBoost(true)}
              >
                Boost credits
              </button>
              {data.plan === "free" && (
                <button
                  className="rounded-full border border-[#4A4C52] px-[18px] py-2.5 text-[13.5px] font-medium text-brand-canvas disabled:opacity-50"
                  disabled={busy !== null || !data.stripeConfigured}
                  onClick={() => post("Upgrade", "/api/billing/checkout", { plan: "pro" })}
                >
                  {busy === "Upgrade" ? "Opening…" : "Upgrade to Pro"}
                </button>
              )}
              {data.plan === "pro" && (
                <button
                  className="rounded-full border border-[#4A4C52] px-[18px] py-2.5 text-[13.5px] font-medium text-brand-canvas disabled:opacity-50"
                  disabled={busy !== null || !data.hasStripeCustomer}
                  onClick={() => post("Portal", "/api/billing/portal")}
                  title="Plan changes run through the Stripe portal"
                >
                  {busy === "Portal" ? "Opening…" : "Change plan"}
                </button>
              )}
              {data.plan !== "free" && data.hasStripeCustomer && (
                <button
                  className="px-2 py-2.5 text-[13.5px] text-dark-ink4 hover:text-brand-canvas disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => post("Cancel", "/api/billing/portal")}
                >
                  Cancel plan
                </button>
              )}
            </div>
          </div>
        </div>

        {/* payment methods → portal */}
        <div className="min-w-[280px] flex-[1_1_300px] rounded-[18px] border border-brand-line bg-brand-panel p-6">
          <div className="font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink5">Payment method</div>
          <p className="mb-4 mt-3 text-[13.5px] leading-[1.6] text-brand-ink2">
            Cards, receipts and PDF invoices live in the secure Stripe portal — we never see or
            store your card number.
          </p>
          <button
            className="rounded-full border border-brand-line-strong bg-brand-panel px-4 py-[9px] text-[13.5px] font-medium disabled:opacity-50"
            disabled={busy !== null || !data.hasStripeCustomer}
            onClick={() => post("Portal2", "/api/billing/portal")}
          >
            {busy === "Portal2" ? "Opening…" : "Open billing portal"}
          </button>
          {!data.hasStripeCustomer && (
            <p className="mb-0 mt-2 text-[12px] text-brand-ink5">
              Appears after your first purchase.
            </p>
          )}
        </div>
      </div>

      {/* charges */}
      <div className="overflow-hidden rounded-[18px] border border-brand-line bg-brand-panel">
        <div className="border-b border-brand-line-soft px-5 py-4 font-display text-base font-bold">
          Charges & credit grants
        </div>
        {data.charges.length === 0 ? (
          <p className="px-5 py-4 text-sm text-brand-ink5">No charges yet — you&apos;re on the free plan.</p>
        ) : (
          data.charges.map((ch, i) => (
            <div
              key={i}
              className="grid grid-cols-[96px_1fr_84px_72px] items-center gap-3 border-b border-brand-panel-alt px-5 py-3 text-[13.5px]"
            >
              <span className="font-mono text-[12.5px] text-brand-ink3">{fmtDate(ch.at)}</span>
              <span className="min-w-0 truncate">{ch.what}</span>
              <span className="font-mono text-[12.5px] text-brand-ink4">
                +{ch.credits.toLocaleString()} cr
              </span>
              <span className="text-right font-mono text-[12.5px] font-medium">
                ${(ch.amountCents / 100).toFixed(2)}
              </span>
            </div>
          ))
        )}
      </div>

      {boost && <BoostSheet balance={c.balance} onClose={() => setBoost(false)} />}
    </div>
  );
}
