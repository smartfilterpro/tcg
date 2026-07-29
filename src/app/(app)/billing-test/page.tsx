"use client";

// TEMPORARY dev tool. The checkout/boost/portal routes are POST APIs with no
// product UI until Phase 5, which makes them untestable from a phone — this
// page is the buttons, nothing more. Admin-only, and deleted when the real
// billing screens land.

import { useEffect, useState } from "react";

interface UsageMe {
  admin: boolean;
  credits: {
    balance: number;
    plan: string;
    pooled: boolean;
    cycleStart: string;
    monthlyGrant: number;
    spentByReason: Record<string, number>;
  } | null;
}

export default function BillingTestPage() {
  const [me, setMe] = useState<UsageMe | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setMe(j);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function go(label: string, path: string, body?: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${label} failed (${res.status})`);
      if (json.url) {
        window.location.href = json.url as string;
        return;
      }
      setError(`${label}: no redirect URL came back.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    }
    setBusy(null);
  }

  if (!loaded) return <p className="text-slate-500">Loading…</p>;
  if (!me?.admin) {
    return (
      <div className="card-panel p-4 text-sm text-slate-500">
        This is an admin-only billing test page.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Billing test</h1>
        <p className="text-sm text-slate-500">
          Temporary panel for exercising Stripe in test mode — it goes away when the real
          billing screens ship. Use card 4242&nbsp;4242&nbsp;4242&nbsp;4242, any future date,
          any CVC.
        </p>
      </div>

      <div className="rounded-lg bg-yellow-50 p-3 text-xs text-yellow-800">
        You&apos;re signed in as admin, and admins are never metered — so to watch credits
        move, run the same buttons on a <b>test member account</b> and check its meter (or
        the credit_ledger table) afterwards.
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="card-panel space-y-2 p-4">
        <h2 className="font-semibold">Subscriptions</h2>
        <p className="text-xs text-slate-500">
          Opens Stripe Checkout. On success the webhook flips profiles.plan and writes the
          first monthly grant to credit_ledger.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => go("Pro", "/api/billing/checkout", { plan: "pro" })}
          >
            {busy === "Pro" ? "Opening…" : "Upgrade to Pro ($9)"}
          </button>
          <button
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => go("Family", "/api/billing/checkout", { plan: "family" })}
          >
            {busy === "Family" ? "Opening…" : "Upgrade to Family ($19)"}
          </button>
        </div>
      </div>

      <div className="card-panel space-y-2 p-4">
        <h2 className="font-semibold">Boost packs</h2>
        <p className="text-xs text-slate-500">
          One-off payments. Credits appear in the ledger only after the webhook confirms —
          abandoning checkout must grant nothing.
        </p>
        <div className="flex flex-wrap gap-2">
          {(["250", "750", "2000"] as const).map((pack) => (
            <button
              key={pack}
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => go(`Boost ${pack}`, "/api/billing/boost", { pack })}
            >
              {busy === `Boost ${pack}` ? "Opening…" : `Buy ${pack}`}
            </button>
          ))}
        </div>
      </div>

      <div className="card-panel space-y-2 p-4">
        <h2 className="font-semibold">Customer portal</h2>
        <p className="text-xs text-slate-500">
          Cards, invoices, cancelling. Needs at least one purchase first (no Stripe customer
          exists before then). Cancelling keeps the plan until period end.
        </p>
        <button
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => go("Portal", "/api/billing/portal")}
        >
          {busy === "Portal" ? "Opening…" : "Open billing portal"}
        </button>
      </div>

      <div className="card-panel space-y-1 p-4 text-sm">
        <h2 className="font-semibold">What to check after a test purchase</h2>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-600">
          <li>Stripe dashboard → Payments: the charge exists (test mode).</li>
          <li>Stripe dashboard → Webhooks: the delivery shows 200, not 4xx/5xx.</li>
          <li>Supabase: profiles.plan changed, billing_anchor set.</li>
          <li>Supabase: credit_ledger has the monthly_grant (or boost) row — exactly one,
            even if Stripe retried the webhook.</li>
        </ol>
      </div>
    </div>
  );
}
