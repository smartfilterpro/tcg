"use client";

import { useEffect, useRef, useState } from "react";
import type { Profile } from "@/lib/types";
import { uploadCardPhoto } from "@/lib/photos";

interface Invite {
  id: string;
  email: string;
  created_at: string;
}

interface ScanStats {
  scans: number;
  avgSeconds: number | null;
  avgSecondsPerCard: number | null;
  avgCardsPerScan: number | null;
  matchRate: number | null;
  accuracy: number | null;
}

interface Analytics {
  scanTracking: boolean;
  community: {
    members: number;
    totalCards: number;
    totalValue: number;
    decks: number;
    sharedDecks: number;
    openTradePosts: number;
    openTickets: number;
    aiCostMonth: number;
  };
  scansAllTime: ScanStats;
  scans30d: ScanStats;
  finish?: {
    tracking: boolean;
    samples: number;
    corrected: number;
    accuracy: number | null;
    byFinish: Array<{ finish: string; samples: number; accuracy: number }>;
    confusions: Array<{ from: string; to: string; count: number }>;
  };
  priceRefresh?: {
    ranAt: string;
    checked: number;
    updated: number;
    unpriced: number;
    suspicious: Array<{ id: string; name: string; old: number; next: number }>;
    pt?: {
      matched: number;
      unmatched: number;
      priced: number;
      requests: number;
      error?: string;
    } | null;
    textWarmed?: number;
    error?: string;
  } | null;
}

interface TicketMessage {
  id: string;
  user_id: string;
  authorName: string;
  isAdmin: boolean;
  body: string;
  created_at: string;
}

interface Ticket {
  id: string;
  user_id: string;
  authorName: string;
  subject: string;
  status: "open" | "in_progress" | "resolved";
  created_at: string;
  updated_at: string;
  messages: TicketMessage[];
}

interface ReviewCandidate {
  id: string;
  url: string;
  uploadedByEmail: string | null;
  createdAt: string;
}

interface ReviewRow {
  card: {
    id: string;
    name: string;
    set_name: string | null;
    number: string | null;
    image_small: string | null;
    image_locked: boolean;
  };
  candidates: ReviewCandidate[];
}

interface UserUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costUsd30d: number;
  costUsdMonth: number;
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2.5">
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function AdminPage() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [usage, setUsage] = useState<Record<string, UserUsage>>({});
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null); // card id being acted on
  const [reviewQuery, setReviewQuery] = useState(""); // active search, "" = needs-review list
  const [reviewSearchDraft, setReviewSearchDraft] = useState("");
  const [reviewNotice, setReviewNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadCardIdRef = useRef<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketExpanded, setTicketExpanded] = useState<string | null>(null);
  const [ticketReply, setTicketReply] = useState("");
  const [ticketBusy, setTicketBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  async function load() {
    const res = await fetch("/api/admin/users");
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed to load (are you an admin?)");
    } else {
      setUsers(json.users);
      setInvites(json.invites);
      setUsage(json.usage ?? {});
    }
    setLoading(false);
  }

  async function loadReview(q?: string) {
    const query = q ?? reviewQuery;
    const url = query
      ? `/api/admin/card-images?q=${encodeURIComponent(query)}`
      : "/api/admin/card-images";
    const res = await fetch(url);
    const json = await res.json();
    if (res.ok) setReviewRows(json.rows ?? []);
  }

  async function loadTickets() {
    const res = await fetch("/api/support");
    const json = await res.json();
    if (res.ok) setTickets(json.tickets ?? []);
  }

  /** Create a card record for a name the search couldn't find, so a picture
   *  has somewhere to live (deck entries are just names). */
  async function createCardEntry() {
    const name = reviewQuery.trim();
    if (!name) return;
    setReviewBusy("create");
    setReviewNotice(null);
    try {
      const res = await fetch("/api/admin/card-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't create the card entry");
      setReviewNotice({
        ok: true,
        text: `Created “${name}” — now give it a picture with 📷 Upload or 🔎 Find online below.`,
      });
      await loadReview();
    } catch (e) {
      setReviewNotice({
        ok: false,
        text: e instanceof Error ? e.message : "Couldn't create the card entry",
      });
    }
    setReviewBusy(null);
  }

  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // Sub-pages within the Admin tab — everything was getting too long for
  // one scroll. The chosen tab lives in the URL hash so refreshes and
  // shared links keep it.
  type AdminTab = "analytics" | "members" | "cards" | "support";
  const [tab, setTab] = useState<AdminTab>("analytics");
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (["analytics", "members", "cards", "support"].includes(h)) setTab(h as AdminTab);
  }, []);
  function switchTab(t: AdminTab) {
    setTab(t);
    try {
      window.history.replaceState(null, "", `#${t}`);
    } catch {}
  }

  useEffect(() => {
    load();
    loadReview();
    loadTickets();
    fetch("/api/admin/analytics")
      .then((r) => r.json())
      .then((j) => j?.community && setAnalytics(j))
      .catch(() => {});
  }, []);

  async function setTicketStatus(t: Ticket, status: Ticket["status"]) {
    await fetch(`/api/support/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadTickets();
  }

  async function replyToTicket(t: Ticket) {
    if (!ticketReply.trim() || ticketBusy) return;
    setTicketBusy(true);
    const res = await fetch(`/api/support/${t.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: ticketReply }),
    });
    if (res.ok) {
      setTicketReply("");
      await loadTickets();
    }
    setTicketBusy(false);
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error);
    } else {
      setMessage(
        `${email} is invited! Send them the app link — they can create their account on the login page.`
      );
      setEmail("");
      load();
    }
  }

  async function resetPassword(id: string, userEmail: string) {
    const password = prompt(
      `Set a new password for ${userEmail} (8+ characters).\nShare it with them privately — they can keep using it or you can change it again later.`
    );
    if (!password) return;
    const res = await fetch(`/api/admin/users/${id}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(`Password updated for ${userEmail}.`);
  }

  async function revoke(inviteEmail: string) {
    await fetch("/api/admin/invite", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    load();
  }

  async function removeUser(id: string, userEmail: string) {
    if (!confirm(`Remove ${userEmail}? Their collection and decks will be deleted.`)) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    load();
  }

  async function toggleSuspend(u: Profile) {
    const next = !(u.suspended === true);
    if (
      next &&
      !confirm(
        `Suspend ${u.display_name || u.email}? They won't be able to sign in or use the app until you unsuspend them. Their collection is kept.`
      )
    )
      return;
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suspended: next }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(`${u.display_name || u.email} ${next ? "suspended" : "unsuspended"}.`);
    load();
  }

  async function setAiBudget(u: Profile) {
    const current = u.ai_budget_usd != null ? Number(u.ai_budget_usd) : 10;
    const answer = prompt(
      `Monthly AI limit for ${u.display_name || u.email} in USD.\nThey've spent ~$${(usage[u.id]?.costUsdMonth ?? 0).toFixed(2)} this month. Set 0 to block AI features entirely.`,
      String(current)
    );
    if (answer == null) return;
    const value = Number(answer);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a number, e.g. 10");
      return;
    }
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiBudgetUsd: value }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(`AI limit for ${u.display_name || u.email} set to $${value}/month.`);
    load();
  }

  async function setCardImage(cardId: string, url: string, cardName?: string) {
    setReviewNotice(null);
    setReviewBusy(cardId);
    const res = await fetch("/api/admin/card-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", cardId, url }),
    });
    const json = await res.json();
    if (!res.ok) {
      setReviewNotice({ ok: false, text: json.error || "Couldn't update the image." });
    } else if (json.warning) {
      setReviewNotice({ ok: true, text: json.warning });
    } else {
      setReviewNotice({
        ok: true,
        text: `Image updated${cardName ? ` for ${cardName}` : ""} and locked. If your collection still shows the old art, that copy may be linked to a duplicate record of the same card — search its name here and fix that entry too.`,
      });
    }
    setReviewBusy(null);
    loadReview();
  }

  async function unlockCard(cardId: string) {
    setReviewNotice(null);
    setReviewBusy(cardId);
    const res = await fetch("/api/admin/card-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unlock", cardId }),
    });
    const json = await res.json();
    if (!res.ok) setReviewNotice({ ok: false, text: json.error || "Couldn't unlock." });
    setReviewBusy(null);
    loadReview();
  }

  async function findImageOnline(cardId: string, cardName: string) {
    setReviewNotice(null);
    setReviewBusy(cardId);
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/find-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asAdmin: true }),
      });
      const json = await res.json();
      if (!res.ok) setReviewNotice({ ok: false, text: json.error || "Image search failed" });
      else setReviewNotice({ ok: true, text: `Found and set an image for ${cardName}.` });
    } catch {
      setReviewNotice({ ok: false, text: "Image search failed — try again." });
    }
    setReviewBusy(null);
    loadReview();
  }

  async function removeCandidate(candidateId: string) {
    await fetch("/api/admin/card-images", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    loadReview();
  }

  function pickUpload(cardId: string) {
    uploadCardIdRef.current = cardId;
    uploadInputRef.current?.click();
  }

  async function onUploadChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const cardId = uploadCardIdRef.current;
    if (!file || !cardId) return;
    setReviewNotice(null);
    setReviewBusy(cardId);
    const url = await uploadCardPhoto(file);
    if (!url) {
      setReviewNotice({ ok: false, text: "Photo upload failed — try again." });
      setReviewBusy(null);
      return;
    }
    await setCardImage(cardId, url);
  }

  /** Where a card record came from — duplicates of the same physical card can
   *  exist from different sources, and the collection shows whichever record
   *  the item is linked to. */
  function cardSource(id: string): string {
    if (id.startsWith("custom-")) return "manual entry";
    if (id.startsWith("tcgdex-")) return "TCGdex";
    return "card API";
  }

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-sm text-slate-500">Analytics, members, card images, and support.</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</div>}

      <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
        {(
          [
            ["analytics", "📊 Analytics"],
            ["members", `👥 Members (${users.length})`],
            ["cards", `🖼 Cards (${reviewRows.length})`],
            ["support", `🎫 Support (${tickets.filter((t) => t.status !== "resolved").length})`],
          ] as Array<[AdminTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "bg-white shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "members" && (
      <>
      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Invite a friend</h2>
        <p className="mb-2 text-xs text-slate-500">
          Adds their email to the allow-list. Then just send them the app link — they&apos;ll
          create their own password on the login page.
        </p>
        <form onSubmit={invite} className="flex gap-2">
          <input
            type="email"
            required
            className="input"
            placeholder="friend@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn-primary shrink-0">Send invite</button>
        </form>
      </div>

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Members ({users.length})</h2>
        <p className="mb-1 text-xs text-slate-400">
          AI usage = scans, deck builds, and coach questions. Costs are estimates at standard
          API rates.
        </p>
        <ul className="divide-y divide-slate-100">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-sm font-medium">{u.display_name || u.email}</div>
                <div className="text-xs text-slate-400">
                  {u.email} · joined {new Date(u.created_at).toLocaleDateString()}
                </div>
                <div className="text-xs text-slate-500">
                  {usage[u.id] ? (
                    <>
                      🤖 {usage[u.id].calls} AI call{usage[u.id].calls === 1 ? "" : "s"} ·{" "}
                      {formatTokens(usage[u.id].inputTokens + usage[u.id].outputTokens)} tokens ·{" "}
                      <span className="font-semibold">
                        ~${usage[u.id].costUsd.toFixed(2)} all-time
                      </span>
                    </>
                  ) : (
                    "🤖 No AI usage yet"
                  )}{" "}
                  ·{" "}
                  {u.role === "admin" ? (
                    <span className="text-slate-400">no monthly cap</span>
                  ) : (
                    <span
                      className={
                        (usage[u.id]?.costUsdMonth ?? 0) >=
                        (u.ai_budget_usd != null ? Number(u.ai_budget_usd) : 10)
                          ? "font-semibold text-red-600"
                          : ""
                      }
                    >
                      ~${(usage[u.id]?.costUsdMonth ?? 0).toFixed(2)} of $
                      {(u.ai_budget_usd != null ? Number(u.ai_budget_usd) : 10).toFixed(0)} this
                      month
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {u.suspended === true && (
                  <span className="chip bg-red-100 text-red-700">suspended</span>
                )}
                <span
                  className={`chip ${
                    u.role === "admin" ? "bg-poke-gold/30 text-yellow-900" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {u.role}
                </span>
                {u.role !== "admin" && (
                  <button
                    className="btn text-xs text-slate-500 hover:bg-slate-100"
                    onClick={() => setAiBudget(u)}
                  >
                    AI limit
                  </button>
                )}
                <button
                  className="btn text-xs text-slate-500 hover:bg-slate-100"
                  onClick={() => resetPassword(u.id, u.email)}
                >
                  Reset password
                </button>
                {u.role !== "admin" && (
                  <>
                    <button
                      className={`btn text-xs ${
                        u.suspended === true
                          ? "text-green-700 hover:bg-green-50"
                          : "text-yellow-700 hover:bg-yellow-50"
                      }`}
                      onClick={() => toggleSuspend(u)}
                    >
                      {u.suspended === true ? "Unsuspend" : "Suspend"}
                    </button>
                    <button
                      className="btn text-xs text-red-600 hover:bg-red-50"
                      onClick={() => removeUser(u.id, u.email)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      </>
      )}

      {tab === "analytics" && analytics && (
        <div className="card-panel p-4">
          <h2 className="mb-2 font-semibold">📊 Analytics</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Members" value={String(analytics.community.members)} />
            <StatTile label="Cards tracked" value={analytics.community.totalCards.toLocaleString()} />
            <StatTile label="Est. total value" value={`$${Math.round(analytics.community.totalValue).toLocaleString()}`} />
            <StatTile label="AI spend this month" value={`~$${analytics.community.aiCostMonth.toFixed(2)}`} />
            <StatTile
              label="Decks"
              value={`${analytics.community.decks}`}
              sub={`${analytics.community.sharedDecks} shared`}
            />
            <StatTile label="Open trade posts" value={String(analytics.community.openTradePosts)} />
            <StatTile label="Open tickets" value={String(analytics.community.openTickets)} />
            <StatTile
              label="Scans (30d)"
              value={String(analytics.scans30d.scans)}
              sub={`${analytics.scansAllTime.scans} all-time`}
            />
          </div>
          <h3 className="mb-1 mt-4 text-sm font-semibold">🔎 Scanning quality</h3>
          {!analytics.scanTracking ? (
            <p className="text-xs text-yellow-800">
              Scan tracking needs a one-time database update — run{" "}
              <code>supabase/migrations/012_analytics.sql</code>. Stats start collecting from
              then on.
            </p>
          ) : analytics.scansAllTime.scans === 0 ? (
            <p className="text-xs text-slate-400">
              No scans recorded yet — stats collect from each saved scan.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label="Avg. time per scan"
                value={
                  analytics.scans30d.avgSeconds != null
                    ? `${analytics.scans30d.avgSeconds.toFixed(0)}s`
                    : "—"
                }
                sub="last 30 days"
              />
              <StatTile
                label="Avg. time per card"
                value={
                  analytics.scans30d.avgSecondsPerCard != null
                    ? `${analytics.scans30d.avgSecondsPerCard.toFixed(1)}s`
                    : "—"
                }
                sub="scan time ÷ cards found"
              />
              <StatTile
                label="Avg. cards per scan"
                value={
                  analytics.scans30d.avgCardsPerScan != null
                    ? analytics.scans30d.avgCardsPerScan.toFixed(1)
                    : "—"
                }
              />
              <StatTile
                label="Auto-match rate"
                value={
                  analytics.scans30d.matchRate != null
                    ? `${analytics.scans30d.matchRate.toFixed(0)}%`
                    : "—"
                }
                sub="cards found in the database"
              />
              <StatTile
                label="Scan accuracy"
                value={
                  analytics.scans30d.accuracy != null
                    ? `${analytics.scans30d.accuracy.toFixed(0)}%`
                    : "—"
                }
                sub="saved without correction"
              />
              <StatTile
                label="Finish accuracy"
                value={
                  analytics.finish?.accuracy != null
                    ? `${analytics.finish.accuracy.toFixed(0)}%`
                    : "—"
                }
                sub={
                  analytics.finish?.tracking === false
                    ? "run migration 018"
                    : `learned from ${analytics.finish?.samples ?? 0} scans`
                }
              />
            </div>
          )}

          <h3 className="mb-1 mt-4 text-sm font-semibold">💰 Price freshness</h3>
          <PriceRefreshPanel info={analytics.priceRefresh ?? null} />

          <h3 className="mb-1 mt-4 text-sm font-semibold">🎨 Finish detection</h3>
          {analytics.finish?.tracking === false ? (
            <p className="text-xs text-yellow-800">
              Finish learning needs a one-time database update — run{" "}
              <code>supabase/migrations/018_finish_feedback.sql</code>. From then on, every
              scan tracks whether the holo / reverse holo / normal call was right.
            </p>
          ) : (analytics.finish?.samples ?? 0) === 0 ? (
            <p className="text-xs text-slate-400">
              No data yet — stats appear as members save (or correct) scanned cards.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {analytics.finish!.byFinish.map((f) => (
                  <StatTile
                    key={f.finish}
                    label={`Called “${f.finish}”`}
                    value={`${f.accuracy.toFixed(0)}%`}
                    sub={`right in ${f.samples} scan${f.samples === 1 ? "" : "s"}`}
                  />
                ))}
              </div>
              {analytics.finish!.confusions.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  Most common mix-ups:{" "}
                  {analytics.finish!.confusions
                    .map((c) => `called ${c.from}, was actually ${c.to} (×${c.count})`)
                    .join(" · ")}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "support" && (
      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">
          🎫 Support tickets ({tickets.filter((t) => t.status !== "resolved").length} active)
        </h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-slate-400">No tickets — smooth sailing. 🎉</p>
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {tickets
                .filter((t) => showResolved || t.status !== "resolved")
                .map((t) => (
                  <li key={t.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setTicketExpanded(ticketExpanded === t.id ? null : t.id);
                          setTicketReply("");
                        }}
                      >
                        <div className="truncate text-sm font-medium">{t.subject}</div>
                        <div className="text-xs text-slate-400">
                          {t.authorName} · updated {new Date(t.updated_at).toLocaleDateString()} ·{" "}
                          {t.messages.length} message{t.messages.length === 1 ? "" : "s"}
                        </div>
                      </button>
                      <select
                        className="input w-auto shrink-0 py-1 text-xs"
                        value={t.status}
                        onChange={(e) => setTicketStatus(t, e.target.value as Ticket["status"])}
                      >
                        <option value="open">Open</option>
                        <option value="in_progress">In progress</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </div>
                    {ticketExpanded === t.id && (
                      <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
                        {t.messages.map((m) => (
                          <div
                            key={m.id}
                            className={`rounded-lg p-2 text-sm ${
                              m.isAdmin ? "ml-6 bg-poke-blue/10" : "mr-6 bg-slate-50"
                            }`}
                          >
                            <div className="text-xs font-semibold text-slate-500">
                              {m.authorName}
                              {m.isAdmin && " (admin)"} · {new Date(m.created_at).toLocaleString()}
                            </div>
                            <p className="whitespace-pre-wrap text-slate-800">{m.body}</p>
                          </div>
                        ))}
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            replyToTicket(t);
                          }}
                        >
                          <input
                            className="input text-sm"
                            placeholder="Reply to the member…"
                            value={ticketReply}
                            maxLength={4000}
                            onChange={(e) => setTicketReply(e.target.value)}
                          />
                          <button className="btn-secondary shrink-0 text-sm" disabled={ticketBusy}>
                            Reply
                          </button>
                        </form>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
            {tickets.some((t) => t.status === "resolved") && (
              <button
                className="mt-1 text-xs text-slate-400 hover:underline"
                onClick={() => setShowResolved(!showResolved)}
              >
                {showResolved ? "Hide" : "Show"}{" "}
                {tickets.filter((t) => t.status === "resolved").length} resolved
              </button>
            )}
          </>
        )}
      </div>
      )}

      {tab === "cards" && (
      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">🖼 Card image review ({reviewRows.length})</h2>
        <p className="mb-2 text-xs text-slate-500">
          Cards with no picture, or with photos submitted by members. Picking an image locks
          it — only an admin can change it afterwards. Wrong picture on some other card?
          Search for it below to fix it directly.
        </p>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = reviewSearchDraft.trim();
            setReviewQuery(q);
            loadReview(q);
          }}
        >
          <input
            className="input text-sm"
            placeholder="Search any card to fix its image (name or number)…"
            value={reviewSearchDraft}
            onChange={(e) => setReviewSearchDraft(e.target.value)}
          />
          <button className="btn-secondary shrink-0 text-sm">Search</button>
          {reviewQuery && (
            <button
              type="button"
              className="btn shrink-0 text-sm text-slate-500 hover:bg-slate-100"
              onClick={() => {
                setReviewQuery("");
                setReviewSearchDraft("");
                loadReview("");
              }}
            >
              Clear
            </button>
          )}
        </form>
        {reviewQuery && (
          <p className="mb-2 text-xs text-slate-500">
            Showing search results for &ldquo;{reviewQuery}&rdquo; — every matching card in
            the database, whatever its current image.
          </p>
        )}
        {reviewNotice && (
          <div
            className={`mb-2 rounded-lg p-2.5 text-sm ${
              reviewNotice.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"
            }`}
          >
            {reviewNotice.text}
          </div>
        )}
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onUploadChosen}
        />
        {reviewRows.length === 0 ? (
          reviewQuery ? (
            <div className="space-y-2 text-sm text-slate-500">
              <p>No card records match that search.</p>
              <p className="text-xs">
                Deck entries are just names — a picture needs a card record to live on. If a
                deck shows &ldquo;{reviewQuery}&rdquo; with a blank tile, create the record,
                then add its picture:
              </p>
              <button
                className="btn-secondary text-sm"
                disabled={reviewBusy === "create"}
                onClick={createCardEntry}
              >
                {reviewBusy === "create" ? "Creating…" : `➕ Create card entry “${reviewQuery}”`}
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Nothing to review — every card has art. 🎉</p>
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {reviewRows.map(({ card, candidates }) => (
              <li key={card.id} className="py-3">
                <div className="flex items-start gap-3">
                  <div className="w-14 shrink-0 overflow-hidden rounded aspect-[63/88] bg-slate-100">
                    {card.image_small ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={card.image_small}
                        alt={card.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-lg text-slate-300">
                        ?
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{card.name}</span>
                      {card.image_locked && (
                        <span className="chip bg-poke-gold/30 text-yellow-900">🔒 locked</span>
                      )}
                      {!card.image_small && (
                        <span className="chip bg-red-50 text-red-700">no image</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {card.set_name || "Unknown set"}
                      {card.number ? ` · #${card.number}` : ""} ·{" "}
                      <span title={card.id}>{cardSource(card.id)}</span>
                    </div>
                    {candidates.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-3">
                        {candidates.map((cand) => (
                          <div key={cand.id} className="w-20">
                            <div className="overflow-hidden rounded aspect-[63/88] bg-slate-100">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={cand.url}
                                alt="candidate"
                                className="h-full w-full object-cover"
                              />
                            </div>
                            {cand.uploadedByEmail && (
                              <div className="mt-0.5 truncate text-[10px] text-slate-400">
                                {cand.uploadedByEmail}
                              </div>
                            )}
                            <div className="mt-1 flex gap-1">
                              <button
                                className="btn flex-1 bg-green-600 px-1 py-0.5 text-[11px] text-white hover:bg-green-700"
                                disabled={reviewBusy === card.id}
                                onClick={() => setCardImage(card.id, cand.url, card.name)}
                              >
                                Use
                              </button>
                              <button
                                className="btn px-1 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                                title="Remove this candidate"
                                onClick={() => removeCandidate(cand.id)}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={reviewBusy === card.id}
                        onClick={() => pickUpload(card.id)}
                      >
                        📷 Upload image
                      </button>
                      <button
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={reviewBusy === card.id}
                        onClick={() => findImageOnline(card.id, card.name)}
                      >
                        {reviewBusy === card.id ? "Searching…" : "🔍 Find online"}
                      </button>
                      {card.image_locked && (
                        <button
                          className="btn px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                          disabled={reviewBusy === card.id}
                          onClick={() => unlockCard(card.id)}
                        >
                          🔓 Unlock
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}

      {tab === "members" && (
      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Pending invites ({invites.length})</h2>
        {invites.length === 0 ? (
          <p className="text-sm text-slate-400">No pending invites.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-2">
                <div className="text-sm">{inv.email}</div>
                <button
                  className="btn text-xs text-red-600 hover:bg-red-50"
                  onClick={() => revoke(inv.email)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}

/** Last background price-refresh summary + a run-it-now button. */
function PriceRefreshPanel({
  info,
}: {
  info: {
    ranAt: string;
    checked: number;
    updated: number;
    unpriced: number;
    suspicious: Array<{ id: string; name: string; old: number; next: number }>;
    pt?: {
      matched: number;
      unmatched: number;
      priced: number;
      requests: number;
      error?: string;
    } | null;
    textWarmed?: number;
    error?: string;
  } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<typeof info>(info);
  const [error, setError] = useState<string | null>(null);
  const current = result ?? info;

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      // Start the run in the background, then poll for the recorded result —
      // a full run can take minutes (rate-limited price sources), far longer
      // than a phone browser keeps one request open.
      const res = await fetch("/api/admin/refresh-prices", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `Couldn't start (${res.status})`);
      const startedAt = Date.now();
      // Follow the server's own "running" signal — first-time PokeTrace
      // matching is rate-limited to a request every 2s, so a run can
      // legitimately take 8+ minutes. Hard stop at 15.
      let sawNotRunning = 0;
      while (Date.now() - startedAt < 15 * 60_000) {
        await new Promise((r) => setTimeout(r, 8000));
        setElapsed(Math.round((Date.now() - startedAt) / 60_000));
        const poll = await fetch("/api/admin/refresh-prices").catch(() => null);
        if (!poll?.ok) continue;
        const pj = (await poll.json().catch(() => null)) as {
          summary?: NonNullable<typeof info>;
          running?: boolean;
        } | null;
        if (pj?.running === true) continue;
        const s = pj?.summary;
        if (s?.ranAt && new Date(s.ranAt).getTime() >= startedAt - 60_000) {
          setResult(s);
          setBusy(false);
          return;
        }
        // Not running and no fresh summary — allow a couple of grace polls
        // (the summary write may lag the flag), then give up loudly.
        if (++sawNotRunning >= 3) {
          throw new Error("The run ended without recording a result — check the server logs.");
        }
      }
      throw new Error("Still running after 15 minutes — reload the page later; results appear here.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
        {current?.ranAt ? (
          <span>
            Last run {new Date(current.ranAt).toLocaleString()}: checked {current.checked ?? 0},
            updated {current.updated ?? 0}
            {(current.unpriced ?? 0) > 0 && `, ${current.unpriced} had no price data`}
            {(current.textWarmed ?? 0) > 0 && `, ${current.textWarmed} cards' text cached`}. Runs
            by itself about once a day, stalest cards first.
          </span>
        ) : (
          <span>
            No refresh recorded yet — it runs by itself about once a day (needs migration
            022 to remember runs).
          </span>
        )}
        <button className="btn-secondary text-xs" disabled={busy} onClick={runNow}>
          {busy
            ? `Refreshing… ${elapsed > 0 ? `${elapsed}m — ` : ""}rate-limited sources make first runs slow`
            : "Refresh prices now"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {current?.error && (
        <p className="text-xs text-red-600">⚠️ Last run failed: {current.error}</p>
      )}
      {current?.pt && (
        <p className="text-xs text-slate-500">
          PokeTrace: {current.pt.priced} priced, {current.pt.matched} newly matched
          {current.pt.unmatched > 0 && `, ${current.pt.unmatched} no match`} (
          {current.pt.requests} of the daily 250 requests used
          {current.pt.error ? ` — stopped early: ${current.pt.error}` : ""}).
        </p>
      )}
      {(current?.suspicious?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-yellow-50 p-2 text-xs text-yellow-800">
          <b>Held for review (price jumped &gt;5×, not applied):</b>{" "}
          {current!.suspicious
            .map((s) => `${s.name}: $${(s.old ?? 0).toFixed(2)} → $${(s.next ?? 0).toFixed(2)}`)
            .join(" · ")}
          <span className="block text-yellow-700">
            If a jump is real, fix that card&apos;s price from its detail view (price
            override) or wait — it&apos;ll be rechecked on later runs.
          </span>
        </div>
      )}
    </div>
  );
}
