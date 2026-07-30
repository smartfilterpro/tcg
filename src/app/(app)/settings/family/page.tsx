"use client";

// Family settings, from App Screens artboard 07. Members table with
// per-profile usage bars and caps, plus the one parent control that's real
// today (the trade board toggle backed by profiles.trade_board_enabled).
// The mock's other toggles — spending approvals, outside-trade approvals,
// value hiding, digest — arrive with the features behind them; a switch
// that flips a column nothing reads would be theatre.

import { useCallback, useEffect, useState } from "react";
import { MONTHLY_GRANT } from "@/lib/credits";

interface Member {
  userId: string;
  role: "parent" | "kid";
  cap: number | null;
  isOwner: boolean;
  name: string;
  email: string;
  tradeBoardEnabled: boolean;
  spentThisCycle: number;
}

interface FamilyData {
  group: {
    id: string;
    ownerId: string;
    myRole: "parent" | "kid";
    amOwner: boolean;
    poolGrant: number;
    members: Member[];
  } | null;
  canCreate: boolean;
  plan: string;
}

const AVATAR_COLORS = ["#2C5CFF", "#16171B", "#7A6BD8", "#1F7A43", "#E0A21A"];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function barColor(pct: number): string {
  return pct >= 90 ? "#D8452F" : pct >= 60 ? "#E0A21A" : "#2C5CFF";
}

export default function FamilyPage() {
  const [data, setData] = useState<FamilyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"kid" | "parent">("kid");
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/family");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't load family");
      setData(json);
      const drafts: Record<string, string> = {};
      for (const m of json.group?.members ?? []) drafts[m.userId] = m.cap == null ? "" : String(m.cap);
      setCapDrafts(drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load family");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function call(method: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/family", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "That didn't work");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    }
    setBusy(false);
  }

  if (error && !data) return <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-slate-500">Loading…</p>;

  if (!data.group) {
    return (
      <div className="max-w-2xl">
        <h2 className="m-0 mb-1 font-display text-2xl font-bold tracking-[-.025em]">Family</h2>
        {data.canCreate ? (
          <>
            <p className="mb-4 mt-0 text-[14.5px] text-brand-ink3">
              You&apos;re on the Family plan — set up your household. Up to 5 profiles share a
              {MONTHLY_GRANT.family.toLocaleString()}-credit pool, each with their own binder and decks.
            </p>
            {error && <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
            <button
              className="rounded-full bg-brand-ink px-5 py-[11px] text-sm font-medium text-brand-canvas disabled:opacity-50"
              disabled={busy}
              onClick={() => call("POST", { action: "create" })}
            >
              {busy ? "Creating…" : "Create my family"}
            </button>
          </>
        ) : (
          <>
            <p className="mb-4 mt-0 text-[14.5px] text-brand-ink3">
              Family is up to 5 trainers on one bill: a shared {MONTHLY_GRANT.family.toLocaleString()}-credit pool, per-profile
              caps, and parent controls — $19/month.
            </p>
            <a href="/pricing" className="inline-block rounded-full bg-brand-ink px-5 py-[11px] text-sm font-medium text-brand-canvas">
              See the Family plan
            </a>
          </>
        )}
      </div>
    );
  }

  const g = data.group;
  const amParent = g.myRole === "parent";

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="m-0 mb-1 font-display text-2xl font-bold tracking-[-.025em]">Family</h2>
          <p className="m-0 text-[14.5px] text-brand-ink3">
            {g.members.length} of 5 profiles used · {g.poolGrant.toLocaleString()} shared credits a month
          </p>
        </div>
      </div>
      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="mb-4 overflow-hidden rounded-[18px] border border-brand-line bg-brand-panel">
        <div className="hidden grid-cols-[1.6fr_0.8fr_1.1fr_1fr_1fr_40px] gap-3 border-b border-brand-line bg-brand-panel-alt px-5 py-3 font-mono text-[10.5px] uppercase tracking-[.08em] text-brand-ink4 sm:grid">
          <span>Trainer</span>
          <span>Role</span>
          <span>Credits used</span>
          <span>Monthly cap</span>
          <span>Trade board</span>
          <span />
        </div>
        {g.members.map((m, i) => {
          const pct = m.cap ? Math.min(100, (m.spentThisCycle / Math.max(m.cap, 1)) * 100) : null;
          return (
            <div
              key={m.userId}
              className="grid grid-cols-1 gap-3 border-b border-brand-panel-alt px-5 py-3.5 sm:grid-cols-[1.6fr_0.8fr_1.1fr_1fr_1fr_40px] sm:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
                >
                  {initials(m.name)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{m.name}</div>
                  <div className="truncate text-xs text-brand-ink4">{m.email}</div>
                </div>
              </div>
              <span className="text-[13px] text-brand-ink2">
                {m.isOwner ? "Owner · parent" : m.role === "parent" ? "Parent" : "Trainer"}
              </span>
              <div>
                {pct != null ? (
                  <>
                    <div className="h-1.5 max-w-[120px] overflow-hidden rounded-full bg-brand-sunken">
                      <span className="block h-full" style={{ width: `${Math.max(pct, 2)}%`, background: barColor(pct) }} />
                    </div>
                    <div className="mt-1 font-mono text-[11.5px] text-brand-ink3">
                      {m.spentThisCycle} of {m.cap}
                    </div>
                  </>
                ) : (
                  <div className="font-mono text-[11.5px] text-brand-ink3">
                    {m.spentThisCycle} of unlimited
                  </div>
                )}
              </div>
              <div>
                {amParent && !m.isOwner ? (
                  <input
                    className="w-24 rounded-lg border border-brand-line-strong bg-brand-panel px-2.5 py-1.5 font-mono text-xs"
                    placeholder="None"
                    inputMode="numeric"
                    value={capDrafts[m.userId] ?? ""}
                    disabled={busy}
                    onChange={(e) => setCapDrafts((d) => ({ ...d, [m.userId]: e.target.value }))}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const cap = raw === "" ? null : Math.round(Number(raw));
                      if (cap !== null && !Number.isFinite(cap)) return;
                      if ((m.cap ?? null) !== cap) call("PATCH", { userId: m.userId, cap });
                    }}
                  />
                ) : (
                  <span className="font-mono text-xs text-brand-ink4">{m.cap ?? "None"}</span>
                )}
              </div>
              <div>
                {amParent && !m.isOwner ? (
                  <button
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      m.tradeBoardEnabled ? "bg-brand-accent text-white" : "bg-brand-sunken text-brand-ink3"
                    }`}
                    disabled={busy}
                    onClick={() => call("PATCH", { userId: m.userId, tradeBoard: !m.tradeBoardEnabled })}
                    title="Whether this profile can see and post on the trade board"
                  >
                    {m.tradeBoardEnabled ? "On" : "Off"}
                  </button>
                ) : (
                  <span className="text-xs text-brand-ink4">{m.tradeBoardEnabled ? "On" : "Off"}</span>
                )}
              </div>
              <div className="text-right">
                {amParent && !m.isOwner && (
                  <button
                    className="text-brand-ink5 hover:text-brand-negative"
                    aria-label={`Remove ${m.name}`}
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Remove ${m.name} from the family? Their account and cards stay theirs.`)) {
                        call("DELETE", { userId: m.userId });
                      }
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {amParent && g.members.length < 5 && (
        <form
          className="mb-4 flex flex-wrap items-end gap-2 rounded-[18px] border border-brand-line bg-brand-panel p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (inviteEmail.trim()) call("POST", { action: "invite", email: inviteEmail, role: inviteRole });
            setInviteEmail("");
          }}
        >
          <div className="min-w-[220px] flex-1">
            <label className="mb-1.5 block text-[12.5px] font-medium text-brand-ink3">
              Add a trainer (they need a free account first)
            </label>
            <input
              type="email"
              required
              className="input"
              placeholder="their@email.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <select
            className="input w-auto"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as "kid" | "parent")}
          >
            <option value="kid">Kid — capped, no spending</option>
            <option value="parent">Parent — full control</option>
          </select>
          <button className="btn-primary" disabled={busy || !inviteEmail.trim()}>
            {busy ? "Adding…" : "+ Add"}
          </button>
        </form>
      )}

      <p className="text-[12.5px] leading-relaxed text-brand-ink5">
        Kids can&apos;t buy boosts — a purchase attempt tells them to ask a parent. More parent
        controls (spending approvals, outside-trade approvals, weekly digest) arrive with those
        features.
      </p>
    </div>
  );
}
