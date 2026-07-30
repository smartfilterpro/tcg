"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  grading?: {
    tracking: boolean;
    total: number;
    last30d: number;
    avgGrade: number | null;
    distribution: Array<{ label: string; count: number }>;
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
    <div className="rounded-xl bg-brand-panel-alt p-[14px]">
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[11px] text-brand-ink4">{label}</div>
      {sub && <div className="text-[10px] text-brand-ink5">{sub}</div>}
    </div>
  );
}

/** Relative for anything recent, a date once it stops being interesting. */
function formatLastLogin(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
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
  const [lastSignIn, setLastSignIn] = useState<Record<string, string | null>>({});
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
      setLastSignIn(json.lastSignIn ?? {});
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
      else
        setReviewNotice({
          ok: true,
          text: `Found an image for ${cardName}${json.source ? ` from ${json.source}` : ""}.`,
        });
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

  if (loading) return <p className="text-brand-ink3">Loading…</p>;

  return (
    // Full content column. This page used to cap itself at max-w-2xl, which
    // left it a 672px strip under a 1060px header — and squeezed the business
    // dashboard, whose table alone needs 560px before padding.
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-[26px] font-bold tracking-[-.025em]">Admin</h1>
        <p className="mt-[3px] max-w-[70ch] text-sm leading-[1.6] text-brand-ink3">
          The business view, members and their AI spend, card images awaiting review, and support
          tickets.
        </p>
      </div>

      {error && (
        <div className="rounded-[14px] border border-brand-line bg-white px-[17px] py-[15px] text-[13px] leading-[1.6] text-brand-negative">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-[14px] border border-brand-line bg-white px-[17px] py-[15px] text-[13px] leading-[1.6] text-brand-positive">
          {message}
        </div>
      )}

      <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-full bg-brand-sunken p-1">
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
            className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-medium transition-colors ${
              tab === key
                ? "bg-white text-brand-ink shadow-sm"
                : "text-brand-ink4 hover:text-brand-ink"
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
        <h2 className="mb-2 font-display text-[17px] font-bold">Invite a friend</h2>
        <p className="mb-2 text-xs text-brand-ink4">
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
        <h2 className="mb-2 font-display text-[17px] font-bold">Members ({users.length})</h2>
        <p className="mb-1 text-xs text-brand-ink5">
          AI usage = scans, deck builds, and coach questions. Costs are estimates at standard
          API rates.
        </p>
        <ul className="divide-y divide-brand-line-soft">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-sm font-medium">{u.display_name || u.email}</div>
                <div className="text-xs text-brand-ink5">
                  {u.email} · joined {new Date(u.created_at).toLocaleDateString()} · last login{" "}
                  {formatLastLogin(lastSignIn[u.id])}
                </div>
                <div className="text-xs text-brand-ink4">
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
                    <span className="text-brand-ink5">no monthly cap</span>
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
                    className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                    onClick={() => setAiBudget(u)}
                  >
                    AI limit
                  </button>
                )}
                <button
                  className="btn text-xs text-brand-ink4 hover:bg-slate-100"
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

      {tab === "analytics" && <BusinessDashboard />}

      {tab === "analytics" && analytics && (
        <div className="card-panel p-4">
          <h2 className="mb-2 font-display text-[17px] font-bold">📊 Analytics</h2>
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
            <p className="text-xs text-brand-ink5">
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

          <h3 className="mb-1 mt-4 text-sm font-semibold">🔬 Card grading</h3>
          {analytics.grading?.tracking === false ? (
            <p className="text-xs text-yellow-800">
              Saved grades need a one-time database update — run{" "}
              <code>supabase/migrations/024_grade_reports.sql</code>. From then on every grading
              is kept, with its flattened card photos.
            </p>
          ) : (analytics.grading?.total ?? 0) === 0 ? (
            <p className="text-xs text-brand-ink5">
              No cards graded yet — stats appear once members use the grading page.
            </p>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatTile label="Cards graded" value={String(analytics.grading?.total ?? 0)} sub="all-time" />
                <StatTile label="Graded" value={String(analytics.grading?.last30d ?? 0)} sub="last 30 days" />
                <StatTile
                  label="Average estimate"
                  value={
                    analytics.grading?.avgGrade != null
                      ? analytics.grading.avgGrade.toFixed(1)
                      : "—"
                  }
                />
              </div>
              {(analytics.grading?.distribution ?? []).length > 0 && (
                <p className="mt-2 text-xs text-brand-ink4">
                  {(analytics.grading?.distribution ?? [])
                    .map((d) => `${d.label}: ${d.count}`)
                    .join(" · ")}
                </p>
              )}
            </div>
          )}

          <h3 className="mb-1 mt-4 text-sm font-semibold">📣 Site notice</h3>
          <SiteNoticePanel />

          <h3 className="mb-1 mt-4 text-sm font-semibold">🎟️ Give credits</h3>
          <GrantCreditsPanel />

          <h3 className="mb-1 mt-4 text-sm font-semibold">🧬 Merge duplicate cards</h3>
          <DedupeCardsPanel />

          <h3 className="mb-1 mt-4 text-sm font-semibold">🩹 Fill price &amp; image gaps</h3>
          <PriceSyncPanel />

          <h3 className="mb-1 mt-4 text-sm font-semibold">💰 Price freshness</h3>
          <PriceRefreshPanel info={analytics.priceRefresh ?? null} />

          <h3 className="mb-1 mt-4 text-sm font-semibold">📚 Card catalogue</h3>
          <CardImportPanel />

          <h3 className="mb-1 mt-4 text-sm font-semibold">🎨 Finish detection</h3>
          {analytics.finish?.tracking === false ? (
            <p className="text-xs text-yellow-800">
              Finish learning needs a one-time database update — run{" "}
              <code>supabase/migrations/018_finish_feedback.sql</code>. From then on, every
              scan tracks whether the holo / reverse holo / normal call was right.
            </p>
          ) : (analytics.finish?.samples ?? 0) === 0 ? (
            <p className="text-xs text-brand-ink5">
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
                <p className="mt-2 text-xs text-brand-ink4">
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
        <h2 className="mb-2 font-display text-[17px] font-bold">
          🎫 Support tickets ({tickets.filter((t) => t.status !== "resolved").length} active)
        </h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-brand-ink5">No tickets — smooth sailing. 🎉</p>
        ) : (
          <>
            <ul className="divide-y divide-brand-line-soft">
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
                        <div className="text-xs text-brand-ink5">
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
                      <div className="mt-2 space-y-2 border-t border-brand-line-soft pt-2">
                        {t.messages.map((m) => (
                          <div
                            key={m.id}
                            className={`rounded-lg p-2 text-sm ${
                              m.isAdmin ? "ml-6 bg-poke-blue/10" : "mr-6 bg-slate-50"
                            }`}
                          >
                            <div className="text-xs font-semibold text-brand-ink4">
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
                className="mt-1 text-xs text-brand-ink5 hover:underline"
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

      {tab === "analytics" && (
        <div className="card-panel p-4">
          <h2 className="mb-2 font-display text-[17px] font-bold">🎓 Grading data export</h2>
          <p className="mb-3 text-[13px] leading-[1.55] text-brand-ink3">
            Every saved grading report — the photos, the centering the app measured, and what
            the grader estimated. Use it to improve the grading prompt and to see where the
            estimate drifts.
          </p>
          <div className="mb-3 rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-4 py-3 text-[12.5px] leading-[1.6] text-[#7A5A12]">
            <b>Only rows with a real grade can train anything.</b> The rest hold the model&apos;s
            own estimate, and training on those teaches it to repeat its current mistakes with
            more confidence. They&apos;re still worth having for spotting drift and finding
            disagreements to review. Real grades get recorded by the card&apos;s owner on their
            saved report, once it comes back from PSA, BGS or CGC.
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/admin/grade-export?format=jsonl"
              download
              className="rounded-full bg-brand-ink px-4 py-2 text-[13px] font-medium text-brand-canvas hover:bg-brand-ink2"
            >
              ⬇ JSONL — everything
            </a>
            <a
              href="/api/admin/grade-export?format=jsonl&only=labelled"
              download
              className="rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[13px] font-medium hover:bg-brand-sunken"
            >
              ⬇ JSONL — only real grades
            </a>
            <a
              href="/api/admin/grade-export?format=csv"
              download
              className="rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[13px] font-medium hover:bg-brand-sunken"
            >
              ⬇ CSV — for a spreadsheet
            </a>
            {/* Paged, because photos are heavy — 100 reports is roughly
                50–100 MB. The offset is in the filename so batches don't
                overwrite each other in the downloads folder. */}
            <a
              href="/api/admin/grade-export?format=zip&only=labelled&limit=100"
              download
              className="rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[13px] font-medium hover:bg-brand-sunken"
            >
              ⬇ ZIP — labelled + photos (first 100)
            </a>
            <a
              href="/api/admin/grade-export?format=zip&limit=100"
              download
              className="rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[13px] font-medium hover:bg-brand-sunken"
            >
              ⬇ ZIP — everything + photos (first 100)
            </a>
          </div>
          <p className="mb-0 mt-2 text-[11.5px] text-brand-ink5">
            The ZIP carries the actual photos as{" "}
            <code className="font-mono">images/&lt;id&gt;-front.jpg</code> alongside{" "}
            <code className="font-mono">examples.jsonl</code>, so each row&apos;s pictures are
            matched by name with no lookup. For later batches add{" "}
            <code className="font-mono">&amp;offset=100</code>, <code className="font-mono">200</code>{" "}
            and so on to the URL.
          </p>
          <p className="mb-0 mt-2.5 text-[11.5px] text-brand-ink5">
            User ids are replaced with a stable pseudonym, so you can split train/test without
            the same person landing in both, and without carrying identities into a dataset.
          </p>
        </div>
      )}

      {tab === "cards" && (
      <div className="card-panel p-4">
        <h2 className="mb-2 font-display text-[17px] font-bold">🖼 Card image review ({reviewRows.length})</h2>
        <p className="mb-2 text-xs text-brand-ink4">
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
              className="btn shrink-0 text-sm text-brand-ink4 hover:bg-slate-100"
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
          <p className="mb-2 text-xs text-brand-ink4">
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
            <div className="space-y-2 text-sm text-brand-ink4">
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
            <p className="text-sm text-brand-ink5">Nothing to review — every card has art. 🎉</p>
          )
        ) : (
          <ul className="divide-y divide-brand-line-soft">
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
                    <div className="text-xs text-brand-ink5">
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
                              <div className="mt-0.5 truncate text-[10px] text-brand-ink5">
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
                          className="btn px-2 py-1 text-xs text-brand-ink4 hover:bg-slate-100"
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
        <h2 className="mb-2 font-display text-[17px] font-bold">Pending invites ({invites.length})</h2>
        {invites.length === 0 ? (
          <p className="text-sm text-brand-ink5">No pending invites.</p>
        ) : (
          <ul className="divide-y divide-brand-line-soft">
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
interface ImportState {
  page: number;
  written: number;
  imagesPreserved: number;
  totalCount: number | null;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  done: boolean;
}

/** Pull the whole card catalogue into our own database.
 *
 *  The server does a bounded slice per call and saves its cursor, so this
 *  keeps calling until it reports done. That also means closing the page
 *  costs only the slice in flight — reopening picks up where it stopped. */
function CardImportPanel() {
  const [state, setState] = useState<ImportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    fetch("/api/admin/import-cards")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setState(j.state ?? null))
      .catch(() => {});
  }, []);

  async function run(restart: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    stop.current = false;
    try {
      let first = restart;
      for (;;) {
        const res = await fetch("/api/admin/import-cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restart: first }),
        });
        first = false;
        const json = (await res.json().catch(() => ({}))) as {
          state?: ImportState;
          error?: string;
          alreadyRunning?: boolean;
        };
        if (!res.ok) throw new Error(json.error || `Import failed (${res.status})`);
        if (json.alreadyRunning) throw new Error("An import is already running.");
        if (json.state) setState(json.state);
        if (json.state?.error) throw new Error(json.state.error);
        if (json.state?.done || stop.current) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    }
    setBusy(false);
  }

  const done = state?.done === true;
  const pct =
    state?.totalCount && state.totalCount > 0
      ? Math.min(100, Math.round((state.written / state.totalCount) * 100))
      : null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-brand-ink4">
        Downloads every Pokémon card into our own database, with prices. Cards normally
        arrive one at a time as people scan or search for them, so anything nobody has
        touched is invisible to search and to the deck builder. Safe to run more than once —
        it updates what it already has. Member photos and admin-locked artwork are never
        overwritten.
      </p>

      {state && (
        <div className="text-xs text-brand-ink4">
          {state.written.toLocaleString()} cards written
          {state.totalCount ? ` of ${state.totalCount.toLocaleString()}` : ""}
          {pct != null && ` (${pct}%)`}
          {state.imagesPreserved > 0 && ` · ${state.imagesPreserved} kept their own artwork`}
          {done ? " · finished" : ` · next page ${state.page}`}
          {state.updatedAt && ` · ${new Date(state.updatedAt).toLocaleString()}`}
        </div>
      )}
      {pct != null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all ${done ? "bg-green-500" : "bg-poke-blue"}`}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary text-xs" disabled={busy} onClick={() => run(false)}>
          {busy
            ? "Importing… leave this page open"
            : state && !done
              ? "Continue import"
              : done
                ? "Update catalogue again"
                : "Import all cards"}
        </button>
        {busy && (
          <button
            className="text-xs text-brand-ink4 hover:underline"
            onClick={() => {
              stop.current = true;
            }}
          >
            Stop after this batch
          </button>
        )}
        {!busy && state && !done && (
          <button className="text-xs text-brand-ink5 hover:underline" onClick={() => run(true)}>
            Start over from the beginning
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {state?.error && !error && (
        <p className="text-xs text-red-600">⚠️ Last attempt stopped: {state.error}</p>
      )}
    </div>
  );
}

interface BusinessData {
  kpis: {
    mrr: number; payingCustomers: number; totalAccounts: number; aiCost30: number;
    revenue30: number; grossMarginPct: number | null; conversionPct: number | null;
  };
  months: Array<{ label: string; revenue: number; cost: number }>;
  planMix: Array<{ label: string; count: number; mrr: number }>;
  credits: {
    granted30: number; spent30: number; spentPct: number | null;
    boostCreditsSold30: number; boostRevenue30: number; top5SharePct: number;
  };
  modelSplit: Array<{ model: string; cost: number }>;
  endpointSplit: Array<{ endpoint: string; cost: number }>;
  scanStats: { scans: number; matchRate: number | null; secondsPerCard: number | null; cardsPerScan: number | null };
  alerts: Array<{ severity: "red" | "amber"; title: string; body: string }>;
  customers: Array<{
    email: string; name: string | null; plan: string; cost30: number; revenue30: number;
    margin: number; joined: string | null;
  }>;
}

/** The owner dashboard (Owner Dashboard.dc.html): the business, on one dark
 *  panel, every figure from real tables via /api/admin/business. */
function BusinessDashboard() {
  const [data, setData] = useState<BusinessData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/business")
      .then((r) => r.json().then((j) => (r.ok ? setData(j) : setError(j.error))))
      .catch(() => setError("Couldn't load business data"));
  }, []);

  if (error) return <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="card-panel p-4 text-sm text-brand-ink4">Loading the business view…</div>;

  const k = data.kpis;
  const maxBar = Math.max(...data.months.map((m) => Math.max(m.revenue, m.cost)), 0.01);
  const maxModel = Math.max(...data.modelSplit.map((m) => m.cost), 0.01);
  const kpi = (label: string, value: string, note: string) => (
    <div key={label} className="rounded-[14px] bg-dark-panel-alt p-3.5">
      <div className="font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-dark-ink">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-dark-ink4">{note}</div>
    </div>
  );

  return (
    <div className="mb-4 rounded-[18px] bg-dark-canvas p-4 text-dark-ink sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="m-0 font-display text-lg font-bold">📈 The business</h2>
        <span className="font-mono text-[10.5px] uppercase tracking-[.08em] text-dark-ink4">
          last 30 days · real token spend
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {kpi("MRR", `$${k.mrr.toLocaleString()}`, `${k.payingCustomers} paying · ${k.totalAccounts} accounts`)}
        {kpi("Revenue 30d", `$${k.revenue30.toFixed(2)}`, "subs + boosts")}
        {kpi("AI cost 30d", `$${k.aiCost30.toFixed(2)}`, "via estimateCostUsd")}
        {kpi("Gross margin", k.grossMarginPct == null ? "—" : `${k.grossMarginPct}%`, "of 30d revenue")}
        {kpi("Free → paid", k.conversionPct == null ? "—" : `${k.conversionPct}%`, "of all accounts")}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-[14px] bg-dark-panel p-3.5">
          <div className="mb-2 flex justify-between font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">
            <span>Revenue vs AI cost · 7 months</span>
            <span><span className="text-brand-accent-soft">■</span> rev <span className="text-brand-highlight">■</span> cost</span>
          </div>
          <div className="flex h-28 items-end gap-2">
            {data.months.map((m) => (
              <div key={m.label} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end justify-center gap-1">
                  <span className="w-2/5 rounded-t bg-brand-accent-soft" style={{ height: `${Math.max((m.revenue / maxBar) * 100, 2)}%` }} title={`$${m.revenue}`} />
                  <span className="w-2/5 rounded-t bg-brand-highlight" style={{ height: `${Math.max((m.cost / maxBar) * 100, 2)}%` }} title={`$${m.cost}`} />
                </div>
                <span className="font-mono text-[9.5px] text-dark-ink4">{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="rounded-[14px] bg-dark-panel p-3.5">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">Plan mix</div>
            {data.planMix.map((pm) => (
              <div key={pm.label} className="flex items-center justify-between gap-2 py-1 text-[12.5px]">
                <span className="text-dark-ink2">{pm.label}</span>
                <span className="font-mono text-[11.5px] text-dark-ink3">
                  {pm.count} accts · ${pm.mrr.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <div className="rounded-[14px] bg-dark-panel p-3.5 text-[12.5px]">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">Credit economics · 30d</div>
            <div className="flex justify-between py-0.5"><span className="text-dark-ink2">Credits granted</span><span className="font-mono text-[11.5px]">{data.credits.granted30.toLocaleString()}</span></div>
            <div className="flex justify-between py-0.5"><span className="text-dark-ink2">Credits spent</span><span className="font-mono text-[11.5px]">{data.credits.spent30.toLocaleString()}{data.credits.spentPct != null ? ` (${data.credits.spentPct}%)` : ""}</span></div>
            <div className="flex justify-between py-0.5"><span className="text-dark-ink2">Boosts sold</span><span className="font-mono text-[11.5px] text-[#5BD66E]">{data.credits.boostCreditsSold30.toLocaleString()} · ${data.credits.boostRevenue30.toFixed(2)}</span></div>
            <div className="flex justify-between py-0.5"><span className="text-dark-ink2">Heaviest 5% of users</span><span className="font-mono text-[11.5px] text-brand-warning">{data.credits.top5SharePct}% of AI cost</span></div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-[14px] bg-dark-panel p-3.5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">AI cost by model · 30d</div>
          {data.modelSplit.length === 0 && <div className="text-[12.5px] text-dark-ink4">No AI calls yet.</div>}
          {data.modelSplit.map((m) => (
            <div key={m.model} className="flex items-center gap-2 py-1">
              <span className="w-40 truncate font-mono text-[11px] text-dark-ink3">{m.model}</span>
              <span className="h-2 rounded-full bg-brand-accent-soft" style={{ width: `${Math.max((m.cost / maxModel) * 60, 2)}%` }} />
              <span className="ml-auto font-mono text-[11.5px] text-dark-ink2">${m.cost.toFixed(2)}</span>
            </div>
          ))}
          <div className="mt-3 border-t border-dark-line2 pt-2.5">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">
              Scan quality · the landing page's numbers
            </div>
            <div className="flex flex-wrap gap-4 text-[12.5px] text-dark-ink2">
              <span><b className="font-display text-dark-ink">{data.scanStats.matchRate ?? "—"}%</b> auto-match</span>
              <span><b className="font-display text-dark-ink">{data.scanStats.secondsPerCard ?? "—"}s</b> per card</span>
              <span><b className="font-display text-dark-ink">{data.scanStats.cardsPerScan ?? "—"}</b> cards/photo</span>
              <span className="text-dark-ink4">{data.scanStats.scans} scans, 30d</span>
            </div>
          </div>
        </div>

        <div className="rounded-[14px] bg-dark-panel p-3.5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">Needs a human</div>
          {data.alerts.length === 0 ? (
            <div className="text-[12.5px] text-dark-ink4">Nothing waiting. 🎉</div>
          ) : (
            data.alerts.map((a) => (
              <div key={a.title} className="border-t border-dark-line2 py-2 first:border-t-0">
                <div className={`text-[13px] font-medium ${a.severity === "red" ? "text-brand-negative" : "text-brand-warning"}`}>{a.title}</div>
                <div className="text-[12px] text-dark-ink3">{a.body}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-[14px] bg-dark-panel">
        <div className="grid min-w-[560px] grid-cols-[1.8fr_70px_90px_90px_90px] gap-2 border-b border-dark-line2 px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-[.08em] text-dark-ink4">
          <span>Customer · by AI cost</span><span>Plan</span><span>Cost 30d</span><span>Rev 30d</span><span>Margin</span>
        </div>
        {data.customers.map((c) => (
          <div key={c.email} className="grid min-w-[560px] grid-cols-[1.8fr_70px_90px_90px_90px] items-center gap-2 border-b border-dark-line px-3.5 py-2 text-[12.5px]">
            <span className="truncate text-dark-ink2">{c.name ? `${c.name} · ` : ""}{c.email}</span>
            <span className={`justify-self-start rounded-full px-2 py-0.5 font-mono text-[10px] ${c.plan === "family" ? "bg-brand-highlight text-brand-ink" : c.plan === "pro" ? "bg-brand-accent text-white" : "bg-dark-tile text-dark-ink3"}`}>
              {c.plan.toUpperCase()}
            </span>
            <span className="font-mono text-[11.5px]">${c.cost30.toFixed(2)}</span>
            <span className="font-mono text-[11.5px]">${c.revenue30.toFixed(2)}</span>
            <span className={`font-mono text-[11.5px] ${c.margin < 0 ? "text-brand-negative" : "text-[#5BD66E]"}`}>
              {c.margin < 0 ? "−" : "+"}${Math.abs(c.margin).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

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
      <div className="flex flex-wrap items-center gap-3 text-xs text-brand-ink4">
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
        <p className="text-xs text-brand-ink4">
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


/** Publish the banner every signed-in page shows. One notice is live at a
 *  time; publishing replaces whatever was up. */
function SiteNoticePanel() {
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<"info" | "warning" | "outage">("info");
  const [dismissible, setDismissible] = useState(true);
  const [endsAt, setEndsAt] = useState("");
  const [live, setLive] = useState<{ id: string; body: string; level: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notice");
      const json = await res.json();
      setLive(json.notice ?? null);
    } catch {}
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          level,
          dismissible,
          // datetime-local gives local wall-clock; the Date turns it into the
          // instant the admin actually meant.
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't publish");
      setBody("");
      setEndsAt("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish");
    }
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      {live ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded bg-brand-sunken p-2.5 text-xs">
          <span className="font-mono uppercase text-brand-ink4">{live.level}</span>
          <span className="min-w-0 flex-1">{live.body}</span>
          <button
            className="text-brand-negative underline"
            onClick={async () => {
              await fetch("/api/notice", { method: "DELETE" });
              load();
            }}
          >
            Take it down
          </button>
        </div>
      ) : (
        <p className="mb-3 mt-0 text-xs text-brand-ink5">Nothing showing right now.</p>
      )}
      <textarea
        className="input mb-2 w-full text-sm"
        rows={2}
        maxLength={300}
        placeholder="Upgrade tonight at 11pm ET — scanning will be off for about 20 minutes."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="input w-auto text-sm"
          value={level}
          onChange={(e) => setLevel(e.target.value as typeof level)}
        >
          <option value="info">Info — heads-up</option>
          <option value="warning">Warning — degraded</option>
          <option value="outage">Outage — broken</option>
        </select>
        <label className="flex items-center gap-1.5">
          <span className="text-brand-ink4">until</span>
          <input
            type="datetime-local"
            className="input w-auto text-sm"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            title="Leave empty to keep it up until you take it down"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={dismissible}
            onChange={(e) => setDismissible(e.target.checked)}
          />
          <span>can be dismissed</span>
        </label>
        <button className="btn-primary text-sm" disabled={busy || !body.trim()} onClick={publish}>
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}

/** Add (or claw back) credits on one account. Every adjustment is audited —
 *  this mints value, so "who did this and why" is the point. */
function GrantCreditsPanel() {
  const [email, setEmail] = useState("");
  const [delta, setDelta] = useState("100");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [history, setHistory] = useState<
    Array<{ id: string; delta: number; note: string; at: string; target: string; by: string }>
  >([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/credits");
      const json = await res.json();
      setHistory(json.grants ?? []);
    } catch {}
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function grant() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), delta: Number(delta), note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't apply that");
      setResult(
        `Done — their balance is now ${json.balance.toLocaleString()} credits.` +
          (json.audited ? "" : " (NOT audited — run migration 032.)")
      );
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply that");
    }
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[200px] flex-1 text-xs">
          <span className="mb-1 block text-brand-ink4">Account email</span>
          <input
            className="input text-sm"
            type="email"
            placeholder="them@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-brand-ink4">Credits</span>
          <input
            className="input w-[110px] text-sm"
            type="number"
            step={25}
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            title="Negative takes credits away"
          />
        </label>
        <label className="min-w-[220px] flex-1 text-xs">
          <span className="mb-1 block text-brand-ink4">Reason (recorded)</span>
          <input
            className="input text-sm"
            placeholder="Comped after the scan outage on the 12th"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          className="btn-primary text-sm"
          disabled={busy || !email.trim() || !note.trim()}
          onClick={grant}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
      {result && <p className="mb-0 mt-2 text-xs text-brand-positive">{result}</p>}
      {history.length > 0 && (
        <div className="mt-3 border-t border-brand-line-soft pt-2">
          <p className="m-0 mb-1 text-[11px] uppercase tracking-wide text-brand-ink5">
            Recent adjustments
          </p>
          {history.slice(0, 8).map((g) => (
            <div key={g.id} className="flex flex-wrap gap-2 py-0.5 text-[11.5px] text-brand-ink3">
              <span className="font-mono">
                {g.delta > 0 ? "+" : ""}
                {g.delta}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {g.target} — {g.note}
              </span>
              <span className="text-brand-ink5">{new Date(g.at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/** Walk the catalogue against Pokémon Price Tracker, filling what's missing.
 *
 *  Bounded per press rather than run to completion: ~20,500 cards at one
 *  credit each is slightly more than a day's allowance, so a full pass is
 *  several presses (or several days) and the state remembers where it got to. */
function PriceSyncPanel() {
  const [info, setInfo] = useState<{
    enabled: boolean;
    budget: { used: number; cap: number; remainingUpstream: number | null };
    state: {
      sets: unknown[];
      setIndex: number;
      cardsSeen: number;
      pricesFilled: number;
      imagesFilled: number;
      idsFilled: number;
      skippedAmbiguous: number;
      indexedCards: number;
      rateLimited: boolean;
      cardsAdded?: number;
      unmatchedSamples?: Array<{ set: string; name: string; num: string }>;
      done: boolean;
      error: string | null;
    } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/price-sync");
      if (res.ok) setInfo(await res.json());
    } catch {}
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const stopRef = useRef(false);

  /** Small slices in a loop, not one big request.
   *
   *  Twelve sets with six-second spacing between them is a ninety-second
   *  request; Railway's proxy gives up first and answers with a plain-text
   *  "upstream error" page — which res.json() then turned into the baffling
   *  "Unexpected token 'u'". Three sets a call stays well inside the
   *  timeout, and the loop keeps going until done, rate-limited, stopped or
   *  failed. */
  async function run(restart = false) {
    setBusy(true);
    setError(null);
    stopRef.current = false;
    try {
      let first = true;
      for (;;) {
        if (stopRef.current) break;
        const res = await fetch("/api/admin/price-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxSets: 3, restart: restart && first }),
        });
        first = false;
        // The proxy's failure page is text, not JSON — read it as text and
        // show it as itself rather than as a JSON parse error.
        const text = await res.text();
        let json: { state?: { done?: boolean; rateLimited?: boolean; error?: string | null } };
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`The server answered with something other than JSON: ${text.slice(0, 120)}`);
        }
        if (!res.ok) throw new Error((json as { error?: string }).error || "Sync failed");
        await load();
        const st2 = json.state;
        if (!st2 || st2.done || st2.error) break;
        if (st2.rateLimited) {
          // Their minute window. Wait it out and carry on rather than making
          // the admin play the role of a retry loop.
          for (let i = 0; i < 65 && !stopRef.current; i++) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    }
    setBusy(false);
  }

  if (!info) return <p className="text-xs text-brand-ink5">Loading…</p>;
  if (!info.enabled) {
    return (
      <p className="text-xs text-brand-ink5">
        Needs <code className="font-mono">POKEMONPRICETRACKER_API_KEY</code> in Railway.
      </p>
    );
  }

  const st = info.state;
  const total = st?.sets?.length ?? 0;
  const pct = total > 0 ? Math.round(((st?.setIndex ?? 0) / total) * 100) : 0;

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Keeps every matched card&apos;s <b>price current</b> (same TCGplayer source as the
        import, refreshed daily), fills in <b>missing pictures</b>, records the TCGplayer id
        every bulk dataset joins on, and <b>adds cards we don&apos;t hold at all</b>. Members&apos;
        own price overrides, member photos and admin-locked art are never touched.
      </p>
      {st && total > 0 && (
        <>
          <p className="m-0 mb-1 text-xs">
            {/* Every number defaulted: this panel renders state persisted by
                whatever build wrote it last, and one undefined here blanks
                the entire admin page. */}
            Set {st.setIndex ?? 0} of {total} ({pct}%) ·{" "}
            {(st.cardsSeen ?? 0).toLocaleString()} cards seen ·{" "}
            <b>{(st.pricesFilled ?? 0).toLocaleString()} prices updated</b>,{" "}
            {(st.imagesFilled ?? 0).toLocaleString()} images,{" "}
            {(st.idsFilled ?? 0).toLocaleString()} ids filled
            {(st.cardsAdded ?? 0) > 0 && (
              <>
                {" "}
                · <b>{(st.cardsAdded ?? 0).toLocaleString()} new cards added</b>
              </>
            )}
            {(st.skippedAmbiguous ?? 0) > 0 && ` · ${st.skippedAmbiguous} skipped as ambiguous`}
          </p>
          {/* Zero matches with cards streaming past is the signature of a
              broken index, and looks identical to "their data is missing"
              unless the index size is on screen. */}
          {(st.cardsSeen ?? 0) > 50 && (st.idsFilled ?? 0) === 0 && (
            <p className="m-0 mb-1 text-xs text-brand-negative">
              {!st.indexedCards
                ? "None of our cards were indexed — the catalogue is empty, migration 033 hasn't run, or this run predates the check."
                : `${st.indexedCards.toLocaleString()} of our cards are indexed but nothing matched yet. ` +
                  `If the catalogue import isn't finished, that's the likely cause — their sets ` +
                  `arrive newest-first, and a partial import holds mostly older cards.`}
            </p>
          )}
          {(st.unmatchedSamples?.length ?? 0) > 0 && (st.idsFilled ?? 0) === 0 && (
            <details className="mb-1 text-[11px] text-brand-ink4">
              <summary className="cursor-pointer">
                Sample of unmatched cards (to tell &ldquo;we don&apos;t hold it&rdquo; from a
                format mismatch)
              </summary>
              {st.unmatchedSamples!.map((u, i) => (
                <div key={i} className="font-mono">
                  {u.set}: {u.name} #{u.num}
                </div>
              ))}
            </details>
          )}
          {st.rateLimited && (
            <p className="m-0 mb-1 text-xs text-brand-warning">
              Paused on their per-minute limit — wait a minute and press again. Progress is
              saved.
            </p>
          )}
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-brand-sunken">
            <span className="block h-full bg-brand-accent" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      <p className="m-0 mb-2 font-mono text-[11px] text-brand-ink5">
        {(info.budget?.used ?? 0).toLocaleString()} of{" "}
        {(info.budget?.cap ?? 0).toLocaleString()} credits used
        today
        {info.budget?.remainingUpstream != null &&
          ` · ${info.budget.remainingUpstream.toLocaleString()} left upstream`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary text-sm" disabled={busy} onClick={() => run(false)}>
          {busy ? "Syncing…" : st?.done ? "Run again" : "Sync"}
        </button>
        {busy && (
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              stopRef.current = true;
            }}
          >
            Stop after this slice
          </button>
        )}
        {st && !st.done && (
          <button className="btn-secondary text-sm" disabled={busy} onClick={() => run(true)}>
            Start over
          </button>
        )}
      </div>
      {st?.error && <p className="mb-0 mt-2 text-xs text-brand-negative">{st.error}</p>}
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}


/** Fold duplicate card rows — the same card held under two ids because two
 *  sources spelled its number differently ("#050" vs "#50"). Dry run first,
 *  always: this rewrites what people own. */
function DedupeCardsPanel() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    dryRun: boolean;
    duplicateGroups: number;
    merged: number;
    itemsMoved: number;
    sample: Array<{ name: string; set: string | null; rows: string[] }>;
    failures: string[];
    note: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dedupe-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Dedupe failed");
      setOut(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dedupe failed");
    }
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Finds cards held twice under different ids — same name, number and set, spelled
        differently by different sources (&ldquo;#050&rdquo; vs &ldquo;#50&rdquo;). Merging
        repoints collections before removing anything.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => run(true)}>
          {busy ? "Checking…" : "Check (dry run)"}
        </button>
        {out && out.dryRun && out.duplicateGroups > 0 && (
          <button className="btn-primary text-sm" disabled={busy} onClick={() => run(false)}>
            Merge {out.duplicateGroups} duplicate{out.duplicateGroups === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {out && (
        <div className="mt-2 text-xs text-brand-ink3">
          <p className="m-0">
            {out.duplicateGroups} duplicate group{out.duplicateGroups === 1 ? "" : "s"}
            {!out.dryRun && ` · ${out.merged} merged · ${out.itemsMoved} collection entries moved`}
            {" — "}
            {out.note}
          </p>
          {out.sample.length > 0 && (
            <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[11px]">
              {out.sample.map((g, i) => (
                <div key={i}>
                  {g.name} ({g.set ?? "?"}): {g.rows.join("  ·  ")}
                </div>
              ))}
            </div>
          )}
          {out.failures.length > 0 && (
            <p className="m-0 mt-1 text-brand-negative">{out.failures.join(" · ")}</p>
          )}
        </div>
      )}
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}
