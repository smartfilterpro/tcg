"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resilientFetch } from "@/lib/clientLoop";
import type { Profile } from "@/lib/types";
import { uploadCardPhoto } from "@/lib/photos";
import { artSrc, photoSrc } from "@/lib/art";

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
    suspicious: Array<{
      id: string;
      name: string;
      old: number;
      next: number;
      set?: string | null;
      number?: string | null;
      image?: string | null;
      rarity?: string | null;
    }>;
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
  /** False for a moderator: content tools yes, money and deletion no. */
  const [amAdmin, setAmAdmin] = useState(true);
  const [usage, setUsage] = useState<Record<string, UserUsage>>({});
  const [lastSignIn, setLastSignIn] = useState<Record<string, string | null>>({});
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
      // The route answers this: a moderator gets the list without the
      // spend, and the UI drops the tools they can't use anyway.
      setAmAdmin(json.isAdmin !== false);
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
  type AdminTab = "analytics" | "members" | "content" | "catalogue" | "bulk" | "support";
  const [tab, setTab] = useState<AdminTab>("analytics");
  // A moderator has no analytics tab; drop them on the one they came for.
  useEffect(() => {
    if (!amAdmin && (tab === "analytics" || tab === "catalogue" || tab === "bulk" || tab === "support")) {
      setTab("content");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amAdmin]);
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace("#", "");
      // "cards" survives as an alias — old bookmarks land on the catalogue tab.
      if (h === "cards") setTab("catalogue");
      else if (["analytics", "members", "content", "catalogue", "bulk", "support"].includes(h)) {
        setTab(h as AdminTab);
      }
    };
    apply();
    // A ?cardq= link (from a held-price row) lands on the catalogue tab
    // with that card already searched — the point of the link is to SEE
    // the card, so it must arrive showing it.
    const cardq = new URLSearchParams(window.location.search).get("cardq");
    if (cardq) {
      setTab("catalogue");
      setReviewSearchDraft(cardq);
      setReviewQuery(cardq);
      loadReview(cardq);
    }
    // Live, not just on mount: the dashboard's "Needs a human" buttons are
    // plain #tab links, and they should switch the tab when clicked.
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // The page canvas behind the content goes dark with the page, and comes
  // back when the admin leaves for a light-themed screen.
  useEffect(() => {
    document.body.classList.add("admin-dark-body");
    return () => document.body.classList.remove("admin-dark-body");
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

  /** One PATCH for the moderation switches — name reset, trade posting,
   *  deck sharing. Blocking sharing also takes down what's already shared
   *  (the server does that part). */
  async function moderateUser(u: Profile, body: Record<string, unknown>, doneMsg: string) {
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(doneMsg);
    load();
  }

  /** Comp a plan by hand.
   *
   *  Plans are otherwise written only by the Stripe webhook, which leaves no
   *  way to put your own account on Family — you'd be paying yourself, minus
   *  the card fee — or to make good on a checkout that went wrong. The server
   *  refuses when Stripe is already the source of truth for that account. */
  async function setPlan(u: Profile) {
    const current = u.plan ?? "free";
    const answer = prompt(
      `Plan for ${u.display_name || u.email}: free, pro or family.\n\n` +
        `This comps the plan — no Stripe subscription is created and nothing renews or ` +
        `bills. Refused if they already have a live subscription.`,
      current
    );
    if (answer == null) return;
    const plan = answer.trim().toLowerCase();
    if (!["free", "pro", "family"].includes(plan)) {
      setError("Plan must be free, pro or family.");
      return;
    }
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(`${u.display_name || u.email} is now on ${plan}.`);
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
    //
    // admin-dark: the whole page runs dark (owner-dashboard concept), via
    // scoped overrides in globals.css — the shared light components are
    // re-skinned where they're used, not forked.
    <div className="admin-dark space-y-4">
      <div>
        <h1 className="font-display text-[26px] font-bold tracking-[-.025em]">Admin</h1>
        <p className="mt-[3px] max-w-[70ch] text-sm leading-[1.6] text-brand-ink3">
          Analytics is the business view. Members holds every per-person control, Content the
          moderation surfaces, Catalogue the card-database tools, and Support the tickets.
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
          (amAdmin
            ? ([
                ["analytics", "📊 Analytics"],
                ["members", `👥 Members (${users.length})`],
                ["content", "🛡️ Content"],
                ["catalogue", `🎴 Catalogue${reviewRows.length > 0 ? ` (${reviewRows.length})` : ""}`],
                ["bulk", "📦 Bulk scan"],
                ["support", `🎫 Support (${tickets.filter((t) => t.status !== "resolved").length})`],
              ] as Array<[AdminTab, string]>)
            : ([
                ["content", "🛡️ Content"],
                ["members", `👥 Members (${users.length})`],
              ] as Array<[AdminTab, string]>))
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
                {amAdmin && u.role !== "admin" && (
                  <button
                    className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                    onClick={() => setAiBudget(u)}
                  >
                    AI limit
                  </button>
                )}
                {amAdmin && (
                  <button
                    className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                    onClick={() => resetPassword(u.id, u.email)}
                  >
                    Reset password
                  </button>
                )}
                {/* Promote/demote. The server refuses your own row, so an
                    admin can never demote themselves into a lockout. */}
                {!amAdmin ? null : u.role === "admin" || u.role === "moderator" ? (
                  <button
                    className="btn text-xs text-yellow-700 hover:bg-yellow-50"
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${u.role} access from ${u.display_name || u.email}? They become a regular member.`
                        )
                      ) {
                        moderateUser(u, { role: "member" }, `${u.display_name || u.email} is now a member.`);
                      }
                    }}
                  >
                    Remove {u.role} access
                  </button>
                ) : (
                  <button
                    className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                    onClick={() => {
                      const answer = prompt(
                        `Give ${u.display_name || u.email} staff access.\n\n` +
                          `Type "moderator" for content tools only — remove posts, rename shared decks, reset names, block sharing or trading, suspend.\n` +
                          `Type "admin" for everything you have: billing, credits, the business view, member deletion.`,
                        "moderator"
                      );
                      const role = (answer ?? "").trim().toLowerCase();
                      if (role === "moderator" || role === "admin") {
                        moderateUser(u, { role }, `${u.display_name || u.email} is now a ${role}.`);
                      } else if (answer != null) {
                        setError('Type "moderator" or "admin".');
                      }
                    }}
                  >
                    Make staff
                  </button>
                )}
                {/* Outside the block below, deliberately.
                    That block is gated on `u.role !== "admin"` because its
                    controls — suspend, remove, block sharing — are things
                    you cannot do to an admin. A plan is not one of those:
                    putting the operator's own account on Family is the
                    single case this button exists for, and gating it with
                    the rest hid it from exactly that row. */}
                {amAdmin && (
                  <button
                    className="btn text-xs"
                    title="Comp a plan. No Stripe subscription is created and nothing renews; refused if this account already has a live subscription."
                    onClick={() => setPlan(u)}
                  >
                    Plan: {u.plan ?? "free"}
                    {u.plan_comped === true && " (comped)"}
                  </button>
                )}
                {u.role !== "admin" && (
                  <>
                    <button
                      className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                      title="Wipe an inappropriate display name — they fall back to their email prefix until they pick a new one (screened)."
                      onClick={() => {
                        if (
                          confirm(
                            `Reset ${u.display_name || u.email}'s display name? They'll show as their email prefix until they pick a new one.`
                          )
                        ) {
                          moderateUser(u, { resetDisplayName: true }, `Display name reset.`);
                        }
                      }}
                    >
                      Reset name
                    </button>
                    {(() => {
                      const m = u as Profile & {
                        can_post_trades?: boolean | null;
                        can_share_decks?: boolean | null;
                      };
                      const tradesOff = m.can_post_trades === false;
                      const sharingOff = m.can_share_decks === false;
                      return (
                        <>
                          <button
                            className={`btn text-xs ${tradesOff ? "text-green-700 hover:bg-green-50" : "text-brand-ink4 hover:bg-slate-100"}`}
                            title="Whether this member may post on the trade board."
                            onClick={() =>
                              moderateUser(
                                u,
                                { canPostTrades: tradesOff },
                                `Trade posting ${tradesOff ? "restored" : "blocked"} for ${u.display_name || u.email}.`
                              )
                            }
                          >
                            {tradesOff ? "Allow trades" : "Block trades"}
                          </button>
                          <button
                            className={`btn text-xs ${sharingOff ? "text-green-700 hover:bg-green-50" : "text-brand-ink4 hover:bg-slate-100"}`}
                            title="Whether this member may share decks. Blocking also unshares everything they've already shared."
                            onClick={() =>
                              moderateUser(
                                u,
                                { canShareDecks: sharingOff },
                                `Deck sharing ${sharingOff ? "restored" : "blocked"} for ${u.display_name || u.email}.`
                              )
                            }
                          >
                            {sharingOff ? "Allow sharing" : "Block sharing"}
                          </button>
                        </>
                      );
                    })()}
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
                    {amAdmin && (
                      <button
                        className="btn text-xs text-red-600 hover:bg-red-50"
                        onClick={() => removeUser(u.id, u.email)}
                      >
                        Remove
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card-panel p-4">
        <h2 className="mb-2 font-display text-[17px] font-bold">🎟️ Give credits</h2>
        <GrantCreditsPanel />
      </div>

      <div className="card-panel p-4">
        <h2 className="mb-2 font-display text-[17px] font-bold">📥 Load a CSV into a collection</h2>
        <CsvLoadPanel />
      </div>
      </>
      )}

      {tab === "analytics" && (
        <BusinessDashboard priceCron={analytics?.priceRefresh?.ranAt ?? null} />
      )}

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

      {tab === "content" && (
        <>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">📣 Site notice</h2>
            <SiteNoticePanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🛡️ Shared decks</h2>
            <SharedDecksPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🔤 Name checks</h2>
            <NameAuditPanel />
          </div>
          <p className="text-xs leading-[1.6] text-brand-ink5">
            Trade board moderation lives on the Trades page — as admin you see &ldquo;Remove
            (admin)&rdquo; on every post and an ✕ on every reply. Per-member switches (block
            trades, block sharing, reset name) are on the Members tab.
          </p>
        </>
      )}

      {tab === "bulk" && <BulkScanPanel />}

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

      {tab === "catalogue" && (
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
                        src={artSrc(card.id, card.image_small)!}
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
                                src={photoSrc(cand.url)!}
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

      {tab === "catalogue" && (
        <>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">📚 Card catalogue</h2>
            <CardImportPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🩹 Fill price &amp; image gaps</h2>
            <PriceSyncPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">💰 Price freshness</h2>
            <PriceRefreshPanel info={analytics?.priceRefresh ?? null} />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🖼️ Mirror card art</h2>
            <MirrorArtPanel />
            <CardTextPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🧬 Merge duplicate cards</h2>
            <DedupeCardsPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">📦 Sealed product check</h2>
            <SealedProbePanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🔎 Why is this set short?</h2>
            <SetProbePanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🔬 Trace a search</h2>
            <SearchProbePanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🎱 Ball-pattern copies</h2>
            <PatternConsolidatePanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">⏱️ Recent scans</h2>
            <ScanLogPanel />
          </div>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-display text-[17px] font-bold">🪵 Server log</h2>
            <ServerLogPanel />
          </div>
        </>
      )}

    </div>
  );
}

/** Last background price-refresh summary + a run-it-now button. */
interface ImportState {
  page: number;
  written: number;
  imagesPreserved: number;
  pricesPreserved?: number;
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
        const res = await resilientFetch(
          "/api/admin/import-cards",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ restart: first }),
          },
          {
            onRetry: (n) => setError(`Connection dropped — reconnecting (${n})…`),
            stopped: () => stop.current,
          }
        );
        // Got through: clear any "reconnecting" note from a previous lap.
        setError(null);
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
          {(state.pricesPreserved ?? 0) > 0 &&
            ` · ${state.pricesPreserved} kept a price the source didn't carry`}
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
            ? "Importing… safe to lock the screen"
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
    memberAiCost30: number; staffAiCost30: number;
    revenue30: number; grossMarginPct: number | null; conversionPct: number | null;
  };
  months: Array<{ label: string; revenue: number; cost: number; staffCost: number }>;
  planMix: Array<{ label: string; count: number; mrr: number }>;
  credits: {
    granted30: number; spent30: number; spentPct: number | null;
    boostCreditsSold30: number; boostRevenue30: number; top5SharePct: number;
  };
  modelSplit: Array<{ model: string; cost: number }>;
  endpointSplit: Array<{ endpoint: string; cost: number }>;
  scanStats: { scans: number; matchRate: number | null; secondsPerCard: number | null; cardsPerScan: number | null };
  alerts: Array<{
    severity: "red" | "amber";
    title: string;
    body: string;
    href?: string;
    action?: string;
  }>;
  customers: Array<{
    email: string; name: string | null; plan: string; cost30: number; revenue30: number;
    margin: number; joined: string | null;
  }>;
}

/** Gross-margin target, set 2026-07 from the pricing-model review: at 1¢ a
 *  credit, Pro nets ~41% at full credit burn and ~59% at typical (~70%)
 *  burn; Family 17% / 42%. Blended with boost margins (45–52%), a healthy
 *  month lands in the mid-fifties — so 55% is the line the tile judges. */
const MARGIN_TARGET = 55;

/** The owner dashboard (the monetization-concept mock): the business, on one
 *  dark panel, every figure from real tables via /api/admin/business. The
 *  concept's deltas are computed from the months series — where history
 *  doesn't exist yet (conversion), the tile simply carries no delta rather
 *  than inventing one. */
function BusinessDashboard({ priceCron }: { priceCron: string | null }) {
  const [data, setData] = useState<BusinessData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custQuery, setCustQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("");

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

  // Month-over-month deltas, from the same series the chart draws.
  const cur = data.months[data.months.length - 1];
  const prev = data.months[data.months.length - 2];
  const pctDelta = (a: number, b: number) =>
    b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;
  const revDelta = cur && prev ? pctDelta(cur.revenue, prev.revenue) : null;
  const costDelta = cur && prev ? pctDelta(cur.cost, prev.cost) : null;
  const marginPctOf = (m: { revenue: number; cost: number }) =>
    m.revenue > 0 ? ((m.revenue - m.cost) / m.revenue) * 100 : null;
  const mCur = cur ? marginPctOf(cur) : null;
  const mPrev = prev ? marginPctOf(prev) : null;
  const marginDelta = mCur != null && mPrev != null ? Math.round((mCur - mPrev) * 10) / 10 : null;
  const delta = (v: number | null, unit: string, goodWhenUp: boolean, vs: string) =>
    v == null ? null : (
      <span className={v === 0 ? "text-dark-ink4" : (v > 0) === goodWhenUp ? "text-[#5BD66E]" : "text-brand-negative"}>
        {v > 0 ? "+" : "−"}
        {Math.abs(v)}
        {unit} vs {vs}
      </span>
    );
  const prevLabel = prev?.label ?? "last month";

  // The concept's cost story: which surfaces spend the money.
  const subsRevenue = Math.max(0, k.revenue30 - data.credits.boostRevenue30);
  const [ep1, ep2] = data.endpointSplit;
  const epRest = data.endpointSplit.slice(2).reduce((s, e) => s + e.cost, 0);
  const costNote = ep1
    ? `${ep1.endpoint} $${ep1.cost.toFixed(0)}${ep2 ? ` · ${ep2.endpoint} $${ep2.cost.toFixed(0)}` : ""}${epRest > 0 ? ` · other $${epRest.toFixed(0)}` : ""}`
    : "via estimateCostUsd";

  function exportCsv() {
    if (!data) return;
    const rows = [
      ["email", "name", "plan", "ai_cost_30d_usd", "revenue_30d_usd", "margin_usd", "joined"],
      ...data.customers.map((c) => [
        c.email,
        c.name ?? "",
        c.plan,
        c.cost30,
        c.revenue30,
        c.margin,
        c.joined ?? "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "trainerdeck-customers.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const kpi = (label: string, value: string, note: React.ReactNode, valueClass = "text-dark-ink") => (
    <div key={label} className="rounded-[14px] bg-dark-panel-alt p-3.5">
      <div className="font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">{label}</div>
      <div className={`mt-1 font-display text-[22px] font-bold tracking-tight ${valueClass}`}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-dark-ink4">{note}</div>
    </div>
  );

  return (
    <div className="mb-4 rounded-[18px] bg-dark-canvas p-4 text-dark-ink sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="m-0 font-display text-lg font-bold">📈 The business</h2>
        <div className="flex items-center gap-2.5">
          {priceCron && (
            <span
              className="font-mono text-[10px] uppercase tracking-[.08em] text-dark-ink4"
              title={new Date(priceCron).toLocaleString()}
            >
              <span className="text-[#5BD66E]">●</span> price cron ran{" "}
              {new Date(priceCron).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button
            className="rounded-full bg-dark-panel-alt px-3 py-1 text-[11.5px] font-medium text-dark-ink2 hover:text-dark-ink"
            onClick={exportCsv}
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {kpi("MRR", `$${k.mrr.toLocaleString()}`, `${k.payingCustomers} paying · ${k.totalAccounts} accounts`)}
        {kpi(
          "Revenue 30d",
          `$${k.revenue30.toFixed(2)}`,
          <>
            subs ${subsRevenue.toFixed(0)} · boosts ${data.credits.boostRevenue30.toFixed(0)}
            {revDelta != null && <> · {delta(revDelta, "%", true, prevLabel)}</>}
          </>
        )}
        {kpi(
          "AI cost 30d",
          `$${k.aiCost30.toFixed(2)}`,
          <>
            {/* Serving members, and running the place. A catalogue sweep or
                an afternoon of testing lands in the same endpoints a
                member's questions do, so the split is the only way to tell
                what the product costs from what you cost. */}
            members ${k.memberAiCost30.toFixed(2)}
            {k.staffAiCost30 > 0 && <> · staff ${k.staffAiCost30.toFixed(2)}</>}
            <br />
            {costNote}
            {costDelta != null && <> · {delta(costDelta, "%", false, prevLabel)}</>}
          </>
        )}
        {kpi(
          "Gross margin",
          k.grossMarginPct == null ? "—" : `${k.grossMarginPct}%`,
          <>
            on members · target {MARGIN_TARGET}%
            {marginDelta != null && <> · {delta(marginDelta, "pt", true, prevLabel)}</>}
          </>,
          // The owner's dial: green at or above target, amber within ten
          // points, red below that. Chosen from the pricing-model review —
          // blended margin at typical ~70% credit utilization.
          k.grossMarginPct == null
            ? "text-dark-ink"
            : k.grossMarginPct >= MARGIN_TARGET
              ? "text-[#5BD66E]"
              : k.grossMarginPct >= MARGIN_TARGET - 10
                ? "text-brand-warning"
                : "text-brand-negative"
        )}
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
              <div
                key={a.title}
                className="flex items-start gap-2 border-t border-dark-line2 py-2 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <div className={`text-[13px] font-medium ${a.severity === "red" ? "text-brand-negative" : "text-brand-warning"}`}>{a.title}</div>
                  <div className="text-[12px] text-dark-ink3">{a.body}</div>
                </div>
                {a.href && (
                  <a
                    className="shrink-0 rounded-full bg-dark-panel-alt px-3 py-1 text-[11.5px] font-medium text-dark-ink2 hover:text-dark-ink"
                    href={a.href}
                  >
                    {a.action ?? "Open"}
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-4 rounded-[14px] bg-dark-panel">
        <div className="flex flex-wrap items-center gap-2 px-3.5 pt-3">
          <span className="mr-auto font-mono text-[10px] uppercase tracking-[.1em] text-dark-ink4">
            Customers · sorted by AI cost — who could turn a $9 plan negative
          </span>
          <input
            className="w-40 rounded-full bg-dark-panel-alt px-3 py-1 text-[11.5px] text-dark-ink outline-none placeholder:text-dark-ink4"
            placeholder="Search email…"
            value={custQuery}
            onChange={(e) => setCustQuery(e.target.value)}
          />
          <select
            className="rounded-full bg-dark-panel-alt px-2.5 py-1 text-[11.5px] text-dark-ink2 outline-none"
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value)}
          >
            <option value="">All plans</option>
            <option value="pro">Pro</option>
            <option value="family">Family</option>
            <option value="free">Free</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <div className="mt-2 grid min-w-[640px] grid-cols-[1.8fr_70px_90px_90px_90px_70px] gap-2 border-b border-dark-line2 px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-[.08em] text-dark-ink4">
            <span>Customer</span><span>Plan</span><span>Cost 30d</span><span>Rev 30d</span><span>Margin</span><span>Joined</span>
          </div>
          {data.customers
            .filter(
              (c) =>
                (!planFilter || c.plan === planFilter) &&
                (!custQuery.trim() ||
                  `${c.name ?? ""} ${c.email}`.toLowerCase().includes(custQuery.trim().toLowerCase()))
            )
            .map((c) => (
              <div key={c.email} className="grid min-w-[640px] grid-cols-[1.8fr_70px_90px_90px_90px_70px] items-center gap-2 border-b border-dark-line px-3.5 py-2 text-[12.5px]">
                <span className="truncate text-dark-ink2">{c.name ? `${c.name} · ` : ""}{c.email}</span>
                <span className={`justify-self-start rounded-full px-2 py-0.5 font-mono text-[10px] ${c.plan === "family" ? "bg-brand-highlight text-brand-ink" : c.plan === "pro" ? "bg-brand-accent text-white" : "bg-dark-tile text-dark-ink3"}`}>
                  {c.plan.toUpperCase()}
                </span>
                <span className="font-mono text-[11.5px]">${c.cost30.toFixed(2)}</span>
                <span className="font-mono text-[11.5px]">${c.revenue30.toFixed(2)}</span>
                <span className={`font-mono text-[11.5px] ${c.margin < 0 ? "text-brand-negative" : "text-[#5BD66E]"}`}>
                  {c.margin < 0 ? "−" : "+"}${Math.abs(c.margin).toFixed(2)}
                </span>
                <span className="font-mono text-[11px] text-dark-ink3">
                  {c.joined
                    ? new Date(c.joined).toLocaleDateString([], { month: "short", year: "2-digit" })
                    : "—"}
                </span>
              </div>
            ))}
        </div>
        <div className="px-3.5 py-2 text-[11.5px] text-dark-ink4">
          Showing the {data.customers.length} heaviest AI spenders of {k.totalAccounts} accounts —
          the full list lives on the Members tab.
        </div>
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
    suspicious: Array<{
      id: string;
      name: string;
      old: number;
      next: number;
      set?: string | null;
      number?: string | null;
      image?: string | null;
      rarity?: string | null;
    }>;
    pt?: {
      matched: number;
      unmatched: number;
      priced: number;
      requests: number;
      error?: string;
    } | null;
    textWarmed?: number;
    freeArt?: number;
    trackerPriced?: number;
    trackerArt?: number;
    error?: string;
  } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<typeof info>(info);
  const [error, setError] = useState<string | null>(null);
  const [holdBusy, setHoldBusy] = useState<string | null>(null);
  const current = result ?? info;

  /** Settle one held price: apply the feed's new number, or keep ours. */
  async function decideHold(cardId: string, action: "apply" | "keep") {
    setHoldBusy(cardId);
    setError(null);
    try {
      const res = await fetch("/api/admin/price-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Review failed");
      setResult((r) => {
        const base = r ?? info;
        return base ? { ...base, suspicious: json.suspicious ?? [] } : base;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed");
    }
    setHoldBusy(null);
  }

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
            {(current.freeArt ?? 0) > 0 &&
              `, ${current.freeArt} given artwork free from TCGdex`}
            {(current.trackerPriced ?? 0) > 0 &&
              `, ${current.trackerPriced} priced by the paid tracker`}
            {(current.trackerArt ?? 0) > 0 &&
              `, ${current.trackerArt} given artwork by it`}
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
        <div className="rounded-lg bg-yellow-50 p-2.5 text-xs text-yellow-800">
          <b>Held for review (price jumped &gt;5×, not applied):</b>
          <span className="block text-yellow-700">
            Apply takes the feed&apos;s new price. Keep stands by the current one and stops
            it re-flagging tomorrow — if the feed still disagrees weeks from now, it comes
            back.
          </span>
          {current!.suspicious.map((s) => (
            <div key={s.id} className="mt-2 flex items-start gap-2.5 border-t border-yellow-200/40 pt-2 first:border-t-0">
              {/* The picture is the decision: "is 23¢ right for this card?"
                  is answerable at a glance and unanswerable from a name. */}
              <div className="aspect-[63/88] w-14 shrink-0 overflow-hidden rounded bg-black/20">
                {s.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={artSrc(s.id, s.image)!} alt={s.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] opacity-60">
                    no art
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {s.name}
                  {s.number ? ` #${s.number}` : ""}
                </div>
                <div className="opacity-80">
                  {[s.set, s.rarity].filter(Boolean).join(" · ") || "set unknown"}
                </div>
                <div className="mt-0.5">
                  ${(s.old ?? 0).toFixed(2)} → <b>${(s.next ?? 0).toFixed(2)}</b>{" "}
                  <span className="opacity-70">
                    ({s.next > s.old ? "×" : "÷"}
                    {(s.next > s.old ? s.next / Math.max(s.old, 0.01) : s.old / Math.max(s.next, 0.01)).toFixed(0)})
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <button
                    className="btn-secondary px-2.5 py-0.5 text-[11px]"
                    disabled={holdBusy === s.id}
                    onClick={() => decideHold(s.id, "apply")}
                  >
                    Apply ${(s.next ?? 0).toFixed(2)}
                  </button>
                  <button
                    className="btn-secondary px-2.5 py-0.5 text-[11px]"
                    disabled={holdBusy === s.id}
                    onClick={() => decideHold(s.id, "keep")}
                  >
                    Keep ${(s.old ?? 0).toFixed(2)}
                  </button>
                  {/* Straight to the catalogue search for anything the two
                      numbers can't settle — wrong art, duplicate records.
                      The collection page can't show a card nobody owns, so
                      this goes to the admin's own card search instead. */}
                  <a
                    className="btn-secondary px-2.5 py-0.5 text-[11px]"
                    href={`/admin?cardq=${encodeURIComponent(s.name)}#catalogue`}
                  >
                    Find in catalogue
                  </a>
                </div>
              </div>
            </div>
          ))}
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
      detailsFilled?: number;
      skippedAmbiguous: number;
      skippedSetMismatch?: number;
      setMismatchSamples?: Array<{ theirs: string; ours: string; card: string }>;
      indexedCards: number;
      rateLimited: boolean;
      cardsAdded?: number;
      unmatchedSamples?: Array<{ set: string; name: string; num: string; key?: string }>;
      matched?: number;
      plainSeen?: number;
      plainMatched?: number;
      addsPaused?: string | null;
      budgetPaused?: string | null;
      idConflicts?: number;
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
        const res = await resilientFetch(
          "/api/admin/price-sync",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ maxSets: 3, restart: restart && first }),
          },
          {
            onRetry: (n) => setError(`Connection dropped — reconnecting (${n})…`),
            stopped: () => stopRef.current,
          }
        );
        setError(null);
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
            {(st.imagesFilled ?? 0).toLocaleString()} missing image
            {(st.imagesFilled ?? 0) === 1 ? "" : "s"} filled,{" "}
            {(st.idsFilled ?? 0).toLocaleString()} ids filled,{" "}
            {(st.detailsFilled ?? 0).toLocaleString()} card details filled
            {(st.cardsAdded ?? 0) > 0 && (
              <>
                {" "}
                · <b>{(st.cardsAdded ?? 0).toLocaleString()} new cards added (with pictures)</b>
              </>
            )}
            {(st.skippedAmbiguous ?? 0) > 0 && ` · ${st.skippedAmbiguous} skipped as ambiguous`}
            {(st.skippedSetMismatch ?? 0) > 0 &&
              ` · ${(st.skippedSetMismatch ?? 0).toLocaleString()} skipped: same name and number, different set`}
            {(st.plainSeen ?? 0) > 0 &&
              ` · ${(st.plainMatched ?? 0).toLocaleString()} of ${(st.plainSeen ?? 0).toLocaleString()} plain cards matched`}
            {(st.idConflicts ?? 0) > 0 &&
              ` · ${st.idConflicts} already claimed by a duplicate row (merge them below)`}
          </p>
          {/* The guard that stops a promo bundle's price landing on the card
              it reprints. A handful is the guard working; thousands means
              the two catalogues name sets differently enough that real
              updates are being refused. */}
          {(st.setMismatchSamples?.length ?? 0) > 0 && (
            <details className="mb-1 text-xs text-brand-ink4">
              <summary className="cursor-pointer">
                Matched on name and number but not on set — not written
              </summary>
              <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                {st.setMismatchSamples!.map((s, i) => (
                  <div key={i}>
                    {s.card}: theirs &ldquo;{s.theirs}&rdquo; vs ours &ldquo;{s.ours}&rdquo;
                  </div>
                ))}
              </div>
            </details>
          )}
          {/* Zero matches with cards streaming past is the signature of a
              broken index, and looks identical to "their data is missing"
              unless the index size is on screen. */}
          {/* The alarm used to require ZERO matches, which is the one case
              that never happens when a matcher is merely mostly broken — a
              97%-miss run showed a few ids filled and looked healthy. It is
              the RATE that says whether matching works. */}
          {/* Judged on their PLAIN cards. Their per-printing products —
              "(Love Ball)", "(Poké Ball Pattern)" — are supposed not to
              match anything of ours: we hold one row per card and they sell
              one product per printing. Counting those as misses made a
              working sync look 50% broken. */}
          {(st.plainSeen ?? 0) > 50 &&
            (st.plainMatched ?? 0) / Math.max(1, st.plainSeen ?? 1) < 0.5 && (
              <p className="m-0 mb-1 text-xs text-brand-negative">
                {!st.indexedCards
                  ? "None of our cards were indexed — the catalogue is empty, migration 033 hasn't run, or this run predates the check."
                  : `Only ${(st.plainMatched ?? 0).toLocaleString()} of ${(st.plainSeen ?? 0).toLocaleString()} ` +
                    `of their plain cards matched ours, against ${st.indexedCards.toLocaleString()} indexed. ` +
                    `A healthy sync matches nearly everything — both catalogues are the same game — ` +
                    `so this is a name or number format mismatch, not a missing catalogue. ` +
                    `The examples below show how their side writes them.`}
              </p>
            )}
          {st.addsPaused && (
            <p className="m-0 mb-1 rounded border border-brand-warning/40 bg-brand-warning/10 p-2 text-xs text-brand-warning">
              <b>Adding new cards is paused.</b> {st.addsPaused}
            </p>
          )}
          {(st.unmatchedSamples?.length ?? 0) > 0 && (
            <details className="mb-1 text-[11px] text-brand-ink4">
              <summary className="cursor-pointer">
                Sample of unmatched cards (to tell &ldquo;we don&apos;t hold it&rdquo; from a
                format mismatch)
              </summary>
              {st.unmatchedSamples!.map((u, i) => (
                <div key={i} className="font-mono">
                  {u.set}: {u.name} #{u.num}
                  {u.key && <span className="opacity-60"> → looked up as {u.key}</span>}
                </div>
              ))}
            </details>
          )}
          {st.budgetPaused && (
            <p className="m-0 mb-1 text-xs text-brand-ink4">
              <b>Paused on the daily credit allowance.</b> {st.budgetPaused}
            </p>
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
interface BulkJob {
  id: string;
  label: string;
  status: string;
  expected_cards: number | null;
  ai_cost_usd: number;
  uploaded_at: string | null;
  created_at: string;
  pass1: number;
  pass2: number;
  verified: number;
  needsReview: number;
  reviewed: number;
  device_key?: string;
}

interface BulkRow {
  id: string;
  seq: number;
  photo1: string | null;
  photo2: string | null;
  read1: { name?: string; number?: string; cardName?: string | null; error?: string } | null;
  read2: { name?: string; number?: string; cardName?: string | null; error?: string } | null;
  card: { id: string; name: string; number: string; set_name: string | null } | null;
  variant: string;
  confidence: string | null;
  reviewed: boolean;
  note: string | null;
}

/** The mail-in scanning service's job board and review desk. */
function BulkScanPanel() {
  const [jobs, setJobs] = useState<BulkJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<{ id: string; key: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null); // job id being reviewed
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({}); // row id → card id text

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bulk");
      const json = await res.json();
      if (!res.ok) setError(json.error);
      else setJobs(json.jobs ?? []);
    } catch {
      setError("Couldn't load bulk jobs");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const loadRows = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/admin/bulk/${jobId}?rows=review`);
    const json = await res.json();
    if (res.ok) {
      setRows(json.rows ?? []);
      setRowCount(json.rowCount ?? 0);
    }
  }, []);

  async function createJob() {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else {
      setNewKey({ id: json.job.id, key: json.job.device_key });
      setLabel("");
      load();
    }
    setBusy(false);
  }

  async function jobAction(jobId: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const method = action === "finalize" || action === "reopen" || action === "cancel" ? "PATCH" : "POST";
    const res = await fetch(`/api/admin/bulk/${jobId}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else {
      if (action === "finalize" && json.result) {
        setMessage(
          `Paired ${json.result.total} cards: ${json.result.verified} verified, ${json.result.review} for review` +
            (json.result.aligned ? "." : " — pass counts differ, so nothing auto-verified.")
        );
      }
      if (action === "upload") setMessage(`Loaded ${json.cards} cards (${json.lines} lines) into ${json.member}'s collection.`);
      if (action === "undo") setMessage(`Undone: ${json.removed} rows removed, ${json.decremented} quantities decremented.`);
      load();
      if (open === jobId) loadRows(jobId);
    }
    setBusy(false);
  }

  async function exportCsv(jobId: string, jobLabel: string) {
    const res = await fetch(`/api/admin/bulk/${jobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "export" }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Export failed");
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `bulk-${jobLabel.replace(/[^a-zA-Z0-9-]/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveRow(row: BulkRow, cardId: string | null) {
    if (!open) return;
    const res = await fetch(`/api/admin/bulk/${open}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: row.id, cardId: cardId ?? row.card?.id ?? null }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else {
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      setRowCount((c) => Math.max(0, c - 1));
      load();
    }
  }

  return (
    <div className="space-y-4">
      <div className="card-panel p-4">
        <h2 className="mb-2 font-display text-[17px] font-bold">📦 Mail-in scanning jobs</h2>
        <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
          One job per customer stack. The rig posts one photo per card with the job&apos;s device
          key — pass 1 in feed order, pass 2 with the stack reversed. Two passes agreeing on the
          same catalogue card is what verifies a card with no human; everything else lands in
          the review queue below. AI spend is metered on the job, never on a member.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="input w-64"
            placeholder='Job name, e.g. "Smith shoebox"'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn-primary text-sm" disabled={busy || !label.trim()} onClick={createJob}>
            Create job
          </button>
        </div>
        {newKey && (
          <div className="mt-2 rounded-lg border border-brand-line p-2.5 font-mono text-[11px]">
            <div className="mb-1 text-brand-ink3">Device key for the rig (also shown on the job row):</div>
            <div className="select-all break-all">{newKey.key}</div>
            <div className="mt-1.5 text-brand-ink4">
              curl -X POST {typeof window !== "undefined" ? window.location.origin : ""}/api/bulk/photo -H
              &quot;x-bulk-key: {newKey.key.slice(0, 8)}…&quot; -F job={newKey.id} -F pass=1 -F
              photo=@card.jpg
            </div>
          </div>
        )}

        {jobs == null ? (
          <p className="mt-3 text-xs text-brand-ink4">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="mt-3 text-xs text-brand-ink4">No jobs yet.</p>
        ) : (
          <ul className="mt-3 flex list-none flex-col gap-2 p-0">
            {jobs.map((j) => (
              <li key={j.id} className="rounded-[14px] border border-brand-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-sm">{j.label}</b>
                  <span className="chip bg-slate-100 text-slate-600">{j.status}</span>
                  <span className="font-mono text-[11px] text-brand-ink4">
                    pass1 {j.pass1} · pass2 {j.pass2} · ✓{j.verified} · 👀{j.needsReview} · ✍️
                    {j.reviewed} · ${j.ai_cost_usd.toFixed(2)} AI
                  </span>
                  <span className="ml-auto flex flex-wrap gap-1.5">
                    {j.status !== "uploaded" && j.status !== "cancelled" && (
                      <button className="btn text-xs text-brand-ink4 hover:bg-slate-100" disabled={busy} onClick={() => jobAction(j.id, "finalize")}>
                        {j.status === "ready" ? "Re-pair" : "Finalize"}
                      </button>
                    )}
                    {j.needsReview > 0 && (
                      <button
                        className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                        onClick={() => {
                          setOpen(open === j.id ? null : j.id);
                          if (open !== j.id) loadRows(j.id);
                        }}
                      >
                        {open === j.id ? "Close review" : `Review ${j.needsReview}`}
                      </button>
                    )}
                    {j.status === "ready" && (
                      <>
                        <button className="btn text-xs text-brand-ink4 hover:bg-slate-100" onClick={() => exportCsv(j.id, j.label)}>
                          Export CSV
                        </button>
                        <button
                          className="btn text-xs text-brand-ink4 hover:bg-slate-100"
                          disabled={busy}
                          onClick={() => {
                            const email = prompt(`Load "${j.label}" into which member's collection? (email)`);
                            if (email?.trim()) jobAction(j.id, "upload", { email: email.trim() });
                          }}
                        >
                          Add to member
                        </button>
                      </>
                    )}
                    {j.status === "uploaded" && (
                      <button
                        className="btn text-xs text-red-600 hover:bg-red-50"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Undo the upload of "${j.label}"? Exactly what it wrote is removed.`)) {
                            jobAction(j.id, "undo");
                          }
                        }}
                      >
                        Undo upload
                      </button>
                    )}
                    {j.status === "ready" && (
                      <button className="btn text-xs text-brand-ink4 hover:bg-slate-100" disabled={busy} onClick={() => jobAction(j.id, "reopen")}>
                        Reopen
                      </button>
                    )}
                    {j.status !== "cancelled" && j.status !== "uploaded" && (
                      <button
                        className="btn text-xs text-red-600 hover:bg-red-50"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Cancel "${j.label}"?`)) jobAction(j.id, "cancel");
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <p className="mb-0 mt-2 text-xs text-brand-positive">{message}</p>}
        {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
      </div>

      {open && (
        <div className="card-panel p-4">
          <h2 className="mb-2 font-display text-[17px] font-bold">
            👀 Review queue ({rowCount} left)
          </h2>
          <p className="m-0 mb-3 text-xs leading-[1.6] text-brand-ink3">
            Both photos, both reads, and what the system picked. Accept the pick, or paste the
            right catalogue card id (find it with card search) and save. Saving marks the card
            human-reviewed — the upload button refuses to run while anything here is unreviewed.
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-brand-ink4">Queue clear. 🎉</p>
          ) : (
            <ul className="flex list-none flex-col gap-3 p-0">
              {rows.map((r) => (
                <li key={r.id} className="rounded-[14px] border border-brand-line p-3">
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-brand-ink3">
                    <b>Card #{r.seq}</b>
                    <span className="text-brand-warning">{r.note}</span>
                  </div>
                  <div className="flex flex-wrap items-start gap-3">
                    {[r.photo1, r.photo2].map(
                      (p, i) =>
                        p && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={p} alt={`pass ${i + 1}`} className="h-40 rounded-lg border border-brand-line object-contain" />
                        )
                    )}
                    <div className="min-w-56 flex-1 text-xs leading-[1.7]">
                      <div>
                        Pass 1 read: <b>{r.read1?.error ?? `${r.read1?.name ?? "—"} #${r.read1?.number ?? "?"}`}</b>
                      </div>
                      <div>
                        Pass 2 read: <b>{r.read2?.error ?? (r.read2 ? `${r.read2.name ?? "—"} #${r.read2.number ?? "?"}` : "no pass 2")}</b>
                      </div>
                      <div className="mt-1">
                        System pick:{" "}
                        <b>
                          {r.card ? `${r.card.name} #${r.card.number} · ${r.card.set_name ?? "?"} (${r.card.id})` : "none"}
                        </b>{" "}
                        · {r.variant}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {r.card && (
                          <button className="btn-primary text-xs" onClick={() => saveRow(r, r.card!.id)}>
                            Accept pick
                          </button>
                        )}
                        <input
                          className="input w-56 py-1 text-[11.5px]"
                          placeholder="…or correct card id (e.g. sv8pt5-50)"
                          value={pick[r.id] ?? ""}
                          onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.value }))}
                        />
                        <button
                          className="btn-secondary text-xs"
                          disabled={!(pick[r.id] ?? "").trim()}
                          onClick={() => saveRow(r, (pick[r.id] ?? "").trim())}
                        >
                          Save correction
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rowCount > rows.length && rows.length > 0 && (
            <button className="btn-secondary mt-3 text-sm" onClick={() => open && loadRows(open)}>
              Load next batch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Bulk-load a CSV of cards into one member's collection — for seeding a
 *  test account without scanning a shoebox by hand. Preview first, always:
 *  the server matches against the catalogue and refuses to guess, so the
 *  dry run shows exactly what would land and what needs a better column. */
function CsvLoadPanel() {
  const [email, setEmail] = useState("");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<{
    dryRun: boolean;
    member: string;
    rows: number;
    matched: number;
    added: number;
    updated: number;
    unmatched: Array<{ line: number; name: string; reason: string }>;
    unmatchedTotal: number;
    problems: string[];
    note: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/import-collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, csv, dryRun }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Import failed");
      setOut(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setOut(null);
    }
    setBusy(false);
  }

  return (
    <div>
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Columns (header row required, extra columns ignored): <code>name</code>,{" "}
        <code>number</code>, <code>set</code>, <code>quantity</code>, <code>variant</code> —
        only <code>name</code> is mandatory, but number and set are what pick the exact
        printing. Rows that don&apos;t match one catalogue card exactly are reported, never
        guessed. Preview first; nothing is written until Load.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setCsv(await f.text());
          setFileName(f.name);
          setOut(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          className="input w-64"
          placeholder="member@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn-secondary text-sm" onClick={() => fileRef.current?.click()}>
          {fileName ? `📄 ${fileName}` : "Choose CSV file"}
        </button>
        <button
          className="btn-secondary text-sm"
          disabled={busy || !email.trim() || !csv.trim()}
          onClick={() => run(true)}
        >
          {busy ? "Working…" : "Preview"}
        </button>
        {out && out.dryRun && out.matched > 0 && (
          <button className="btn-primary text-sm" disabled={busy} onClick={() => run(false)}>
            Load {out.matched} card{out.matched === 1 ? "" : "s"} → {out.member}
          </button>
        )}
      </div>
      <textarea
        className="input mt-2 min-h-20 font-mono text-[11.5px]"
        placeholder={"…or paste CSV here\nname,number,set,quantity,variant\nGengar,50,Perfect Order,2,holo"}
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          setFileName(null);
          setOut(null);
        }}
      />
      {out && (
        <div className="mt-2 text-xs text-brand-ink3">
          <p className="m-0">
            {out.rows} row{out.rows === 1 ? "" : "s"} · <b>{out.matched} matched</b>
            {!out.dryRun && ` · ${out.added} added · ${out.updated} quantities merged`}
            {out.unmatchedTotal > 0 && (
              <span className="text-brand-warning"> · {out.unmatchedTotal} unmatched</span>
            )}
            {" — "}
            {out.note}
          </p>
          {out.unmatched.length > 0 && (
            <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[11px]">
              {out.unmatched.map((u, i) => (
                <div key={i}>
                  line {u.line}: {u.name} — {u.reason}
                </div>
              ))}
              {out.unmatchedTotal > out.unmatched.length && (
                <div>…and {out.unmatchedTotal - out.unmatched.length} more</div>
              )}
            </div>
          )}
          {out.problems.length > 0 && (
            <p className="m-0 mt-1 text-brand-warning">{out.problems.join(" · ")}</p>
          )}
        </div>
      )}
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}

/** What people tried to call themselves and their decks.
 *
 *  The AI screen is prevention and this is detection. Both halves matter:
 *  refusals show who is working at the filter, and acceptances are what a
 *  human skims — the screen fails open on purpose, so "allowed" is not the
 *  same as "checked by someone". */
function NameAuditPanel() {
  const [rows, setRows] = useState<Array<{
    id: string;
    userId: string;
    who: string;
    kind: string;
    attempted: string;
    allowed: boolean;
    reason: string | null;
    at: string;
    strikes: number;
  }> | null>(null);
  const [refusedOnly, setRefusedOnly] = useState(true);
  const [migrated, setMigrated] = useState(true);

  const load = useCallback(async (refused: boolean) => {
    try {
      const res = await fetch(`/api/admin/name-audit${refused ? "?refused=1" : ""}`);
      const json = await res.json();
      if (res.ok) {
        setRows(json.rows ?? []);
        setMigrated(json.migrated !== false);
      }
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    load(refusedOnly);
  }, [load, refusedOnly]);

  if (!migrated) {
    return (
      <p className="m-0 text-xs text-brand-warning">
        Name monitoring needs a database update — run{" "}
        <code>supabase/migrations/042_name_audit.sql</code>.
      </p>
    );
  }

  return (
    <div>
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Every username and deck name people have tried. The screen refuses the obvious, but
        it fails open by design — so what it ALLOWED is the half worth skimming. Repeated
        refusals from one person are flagged: the screen held, but that is someone working
        at it, and the answer is a name reset or a suspension on the Members tab.
      </p>
      <div className="mb-2 flex gap-2">
        <button
          className={refusedOnly ? "btn-primary text-sm" : "btn-secondary text-sm"}
          onClick={() => setRefusedOnly(true)}
        >
          Refused
        </button>
        <button
          className={!refusedOnly ? "btn-primary text-sm" : "btn-secondary text-sm"}
          onClick={() => setRefusedOnly(false)}
        >
          Everything
        </button>
      </div>
      {rows == null ? (
        <p className="m-0 text-xs text-brand-ink4">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-xs text-brand-ink4">
          {refusedOnly ? "Nothing has been refused. 🎉" : "No name changes recorded yet."}
        </p>
      ) : (
        <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0">
          {rows.map((r) => (
            <li key={r.id} className="rounded border border-brand-line-soft px-2 py-1.5 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={r.allowed ? "text-brand-positive" : "text-brand-negative"}>
                  {r.allowed ? "allowed" : "refused"}
                </span>
                <span className="font-mono">&ldquo;{r.attempted}&rdquo;</span>
                <span className="opacity-70">
                  {r.kind} · {r.who} · {formatLastLogin(r.at)}
                </span>
                {r.strikes >= 3 && (
                  <span className="chip bg-red-100 text-red-700">
                    {r.strikes} refused this week
                  </span>
                )}
              </div>
              {r.reason && <div className="opacity-70">{r.reason}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SharedDecksPanel() {
  const [decks, setDecks] = useState<Array<{
    id: string;
    name: string;
    scope: string;
    ownerName: string;
  }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/shared-decks");
      const json = await res.json();
      if (res.ok) setDecks(json.decks ?? []);
      else setError(json.error ?? "Couldn't load shared decks");
    } catch {
      setError("Couldn't load shared decks");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(deckId: string, action: "rename" | "unshare", name?: string) {
    setBusy(deckId);
    setError(null);
    try {
      const res = await fetch("/api/admin/shared-decks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, deckId, name }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "Action failed");
      else await load();
    } catch {
      setError("Action failed");
    }
    setBusy(null);
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Every deck currently shared to the Friends page, whoever it belongs to — including
        pals-only shares between other members. Rename one with an inappropriate name, or
        unshare it entirely. To stop a repeat offender sharing at all, use “Block sharing”
        on their row in Members.
      </p>
      {decks == null ? (
        <p className="m-0 text-xs text-brand-ink4">Loading…</p>
      ) : decks.length === 0 ? (
        <p className="m-0 text-xs text-brand-ink4">Nothing is shared right now.</p>
      ) : (
        <ul className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto p-0">
          {decks.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded border border-brand-line-soft px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{d.name}</div>
                <div className="truncate text-[11px] text-brand-ink4">
                  by {d.ownerName} · {d.scope}
                </div>
              </div>
              <button
                className="btn shrink-0 text-xs text-brand-ink4 hover:bg-slate-100"
                disabled={busy === d.id}
                onClick={() => {
                  const name = prompt(`Rename "${d.name}" to:`, d.name);
                  if (name && name.trim() && name.trim() !== d.name) act(d.id, "rename", name.trim());
                }}
              >
                Rename
              </button>
              <button
                className="btn shrink-0 text-xs text-red-600 hover:bg-red-50"
                disabled={busy === d.id}
                onClick={() => {
                  if (confirm(`Unshare "${d.name}" (by ${d.ownerName})? The deck itself is kept.`)) {
                    act(d.id, "unshare");
                  }
                }}
              >
                Unshare
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}

/** Reading the catalogue's printed text.
 *
 *  Same shape as the art mirror above: batches, a cursor the client holds,
 *  stoppable. The difference is that this one can spend money — the free
 *  databases are tried first for every card, and only what they don't carry
 *  goes to the model. Owned-first is the default because a card in somebody's
 *  collection is a card that gets asked about. */
function CardTextPanel() {
  const [status, setStatus] = useState<{
    total: number;
    withText: number;
    missing: number;
    cooling: number;
    ownedMissing: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [ownedOnly, setOwnedOnly] = useState(true);
  const [run, setRun] = useState({ fromDatabase: 0, fromPicture: 0, shared: 0, failures: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/card-text");
      const json = await res.json();
      if (res.ok) setStatus(json);
    } catch {}
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function start() {
    setRunning(true);
    setError(null);
    stopRef.current = false;
    setRun({ fromDatabase: 0, fromPicture: 0, shared: 0, failures: [] });
    let after: string | null = null;
    try {
      for (;;) {
        if (stopRef.current) break;
        const res = await resilientFetch(
          "/api/admin/card-text",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ after, ownedOnly }),
          },
          {
            onRetry: (n) => setError(`Connection dropped — reconnecting (${n})…`),
            stopped: () => stopRef.current,
          }
        );
        setError(null);
        // Text first: a proxy timeout answers with prose, not JSON.
        const body = await res.text();
        let json: {
          fromDatabase: number;
          fromPicture: number;
          shared: number;
          failed: Array<{ id: string; name: string; reason: string }>;
          next: string | null;
          done: boolean;
          error?: string;
        };
        try {
          json = JSON.parse(body);
        } catch {
          throw new Error(body.slice(0, 200) || "The sweep returned nothing readable");
        }
        if (!res.ok) throw new Error(json.error || "Card-text sweep failed");
        setRun((r) => ({
          fromDatabase: r.fromDatabase + json.fromDatabase,
          fromPicture: r.fromPicture + json.fromPicture,
          shared: r.shared + json.shared,
          failures: [...r.failures, ...json.failed.map((f) => `${f.name}: ${f.reason}`)].slice(-8),
        }));
        after = json.next;
        if (json.done || !after) break;
        if (json.fromDatabase + json.fromPicture > 0) refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Card-text sweep failed");
    }
    setRunning(false);
    refresh();
  }

  const target = ownedOnly ? status?.ownedMissing : status?.missing;

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        What a card <i>does</i> — attacks, abilities, weakness, retreat. Free card databases
        are asked first; a brand-new set they haven&apos;t catalogued yet is read from the
        card&apos;s own picture, which costs money, so those are rationed per batch. Every
        read is copied to the card&apos;s other printings, so a chase card with three
        alternate arts costs one read rather than three.
      </p>
      {status && (
        <p className="m-0 mb-2 text-xs text-brand-ink3">
          {status.withText.toLocaleString()} of {status.total.toLocaleString()} cards have
          their text · {status.missing.toLocaleString()} missing
          {status.ownedMissing > 0 && `, ${status.ownedMissing.toLocaleString()} of them owned by somebody`}
          {status.cooling > 0 && ` · ${status.cooling.toLocaleString()} resting after failed reads`}
        </p>
      )}
      <label className="mb-2 flex items-center gap-2 text-xs text-brand-ink3">
        <input
          type="checkbox"
          checked={ownedOnly}
          disabled={running}
          onChange={(e) => setOwnedOnly(e.target.checked)}
        />
        Owned cards only — the ones people actually ask about
      </label>
      <div className="flex flex-wrap gap-2">
        {running ? (
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              stopRef.current = true;
            }}
          >
            Stop after this batch
          </button>
        ) : (
          <button className="btn-primary text-sm" disabled={target === 0} onClick={start}>
            {target === 0 ? "Every card has its text" : "Read the missing text"}
          </button>
        )}
      </div>
      {(running || run.fromDatabase + run.fromPicture > 0) && (
        <p className="m-0 mt-2 text-xs text-brand-ink3">
          {running ? "Running… " : "Stopped. "}
          {run.fromDatabase.toLocaleString()} from the free databases ·{" "}
          {run.fromPicture.toLocaleString()} read from pictures
          {run.shared > 0 && ` · ${run.shared.toLocaleString()} other printings filled for free`}
        </p>
      )}
      {run.failures.length > 0 && (
        <ul className="m-0 mt-2 list-none p-0 text-[11px] text-brand-ink4">
          {run.failures.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {error && <p className="m-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}

function MirrorArtPanel() {
  const [status, setStatus] = useState<{
    withImages: number;
    ours: number;
    remaining: number;
    auto?: {
      ranAt?: string;
      lastRunMirrored?: number;
      lastRunFailed?: number;
      mirroredTotal?: number;
      backlog?: boolean;
      lastError?: string | null;
    } | null;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState({ mirrored: 0, skipped: 0, failures: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mirror-art");
      const json = await res.json();
      if (res.ok) setStatus(json);
    } catch {}
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Give back the space spent on cards nobody owns. Loops until the pass
   *  reports done, same shape as the mirror run. */
  async function reclaim() {
    if (!confirm("Point every mirrored card nobody owns back at its source and delete our copies? Nothing is lost — viewing one re-mirrors it.")) return;
    setRunning(true);
    setError(null);
    stopRef.current = false;
    let cursor: string | null = null;
    let reverted = 0;
    let files = 0;
    try {
      for (;;) {
        if (stopRef.current) break;
        const res = await fetch("/api/admin/mirror-art", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reclaim: true, after: cursor }),
        });
        const text = await res.text();
        let json: { reverted: number; filesRemoved: number; cursor: string | null; done: boolean; error?: string };
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`The server said: ${text.slice(0, 140)}`);
        }
        if (!res.ok) throw new Error(json.error || "Reclaim failed");
        reverted += json.reverted;
        files += json.filesRemoved;
        setRun({ mirrored: reverted, skipped: 0, failures: [`${files} files removed so far`] });
        cursor = json.cursor;
        if (json.done) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reclaim failed");
    }
    setRunning(false);
    refresh();
  }

  async function start() {
    setRunning(true);
    setError(null);
    stopRef.current = false;
    setRun({ mirrored: 0, skipped: 0, failures: [] });
    let after: string | null = null;
    try {
      for (;;) {
        if (stopRef.current) break;
        const res = await resilientFetch(
          "/api/admin/mirror-art",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ after }),
          },
          {
            onRetry: (n) => setError(`Connection dropped — reconnecting (${n})…`),
            stopped: () => stopRef.current,
          }
        );
        setError(null);
        // Text first: a proxy timeout answers with prose, not JSON.
        const text = await res.text();
        let json: {
          mirrored: number;
          skipped?: number;
          failed: Array<{ id: string; reason: string }>;
          lastId: string | null;
          done: boolean;
          error?: string;
        };
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`The server said: ${text.slice(0, 140)}`);
        }
        if (!res.ok) throw new Error(json.error || "Mirror failed");
        setRun((r) => ({
          mirrored: r.mirrored + json.mirrored,
          skipped: r.skipped + (json.skipped ?? 0),
          failures: [...r.failures, ...json.failed.map((f) => `${f.id}: ${f.reason}`)].slice(-8),
        }));
        after = json.lastId;
        if (json.done) break;
        if (json.mirrored > 0) refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mirror failed");
    }
    setRunning(false);
    refresh();
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Card artwork is copied into our own storage automatically — a background job chews
        through the backlog a batch at a time and then sweeps every few hours for anything a
        catalogue import brought in. Originals are kept on file; failed downloads stay
        pointed at the source and are retried on a later sweep. The button below just runs a
        burst on demand; nothing depends on pressing it.
      </p>
      {status && (
        <p className="m-0 mb-2 text-xs text-brand-ink3">
          {status.ours.toLocaleString()} of {status.withImages.toLocaleString()} card images
          in our storage · {status.remaining.toLocaleString()} still hotlinked
          {status.auto?.ranAt && (
            <>
              <br />
              Background job: last ran {new Date(status.auto.ranAt).toLocaleString()} ·{" "}
              {(status.auto.lastRunMirrored ?? 0).toLocaleString()} mirrored
              {(status.auto.lastRunFailed ?? 0) > 0 && `, ${status.auto.lastRunFailed} failed`}
              {" · "}
              {status.auto.backlog === false ? "caught up, sweeping periodically" : "working through the backlog"}
              {status.auto.lastError && (
                <span className="text-brand-negative"> · {status.auto.lastError}</span>
              )}
            </>
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {running ? (
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              stopRef.current = true;
            }}
          >
            Stop after this batch
          </button>
        ) : (
          <>
            <button
              className="btn-primary text-sm"
              disabled={!status || status.remaining === 0}
              onClick={start}
            >
              {status && status.remaining === 0 ? "Everything is mirrored" : "Mirror next batches"}
            </button>
            <button
              className="btn-secondary text-sm"
              title="Point cards nobody owns back at their source and delete our copies. Nothing is lost — the source URL is where the picture came from, and viewing one re-mirrors it."
              onClick={reclaim}
            >
              Reclaim unowned art
            </button>
          </>
        )}
      </div>
      {(running || run.mirrored > 0) && (
        <p className="m-0 mt-2 text-xs text-brand-ink3">
          {running ? "Running… " : "Stopped. "}
          {run.mirrored.toLocaleString()} card{run.mirrored === 1 ? "" : "s"} mirrored this run.
          {run.skipped > 0 &&
            ` ${run.skipped.toLocaleString()} passed over — art that failed repeatedly, retried again in 30 days.`}
        </p>
      )}
      {run.failures.length > 0 && (
        <div className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] text-brand-ink4">
          {run.failures.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      )}
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}

function DedupeCardsPanel() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    dryRun: boolean;
    duplicateGroups: number;
    merged: number;
    itemsMoved: number;
    truncated: number;
    groups: Array<{
      key: string;
      name: string;
      set: string | null;
      blocked?: boolean;
      warning?: string | null;
      rows: Array<{
        id: string;
        number: string;
        image: string | null;
        price: number | null;
        locked: boolean;
        owned: number;
        survivor: boolean;
      }>;
    }>;
    failures: string[];
    note: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Keys the admin has UNticked. Absent means merge it — the default is
   *  yes, because the grouping is right the vast majority of the time and
   *  ticking seventy boxes by hand is its own kind of mistake.
   *
   *  Anything the server flagged starts here, though. Grouping HAS been
   *  wrong — it treated a full art as a duplicate of its plain version —
   *  and a wrong merge deletes a card and repoints somebody's collection,
   *  while a missed merge leaves one duplicate. Those costs are not
   *  symmetrical, so a doubtful pair defaults to no. */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const keys =
        !dryRun && out
          ? out.groups.filter((g) => !skipped.has(g.key)).map((g) => g.key)
          : undefined;
      const res = await fetch("/api/admin/dedupe-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, ...(keys ? { keys } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Dedupe failed");
      setOut(json);
      // Start with every flagged pair unticked, so a warning has to be read
      // and overridden rather than merely ignored.
      if (dryRun) {
        setSkipped(
          new Set(
            (json.groups ?? [])
              .filter((g: { warning?: string | null }) => g.warning)
              .map((g: { key: string }) => g.key)
          )
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dedupe failed");
    }
    setBusy(false);
  }

  const selected = out ? out.groups.filter((g) => !skipped.has(g.key)).length : 0;

  return (
    <div className="rounded-lg border border-brand-line bg-white p-3">
      <p className="m-0 mb-2 text-xs leading-[1.6] text-brand-ink3">
        Finds cards held twice under different ids — same name, number and set, spelled
        differently by different sources (&ldquo;#050&rdquo; vs &ldquo;#50&rdquo;). Check the
        pictures match before merging: if two rows are genuinely different printings, untick
        that pair and the rest still fold. The survivor is marked KEEP; merging repoints
        every collection entry before removing anything.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => run(true)}>
          {busy ? "Checking…" : "Check (dry run)"}
        </button>
        {out && out.dryRun && selected > 0 && (
          <button className="btn-primary text-sm" disabled={busy} onClick={() => run(false)}>
            Merge {selected} selected
          </button>
        )}
        {out && out.dryRun && out.groups.length > 0 && (
          <>
            <button
              className="btn-secondary text-sm"
              onClick={() => setSkipped(new Set(out.groups.map((g) => g.key)))}
            >
              Untick all
            </button>
            <button className="btn-secondary text-sm" onClick={() => setSkipped(new Set())}>
              Tick all
            </button>
          </>
        )}
      </div>
      {out && (
        <div className="mt-2 text-xs text-brand-ink3">
          <p className="m-0">
            {out.duplicateGroups} duplicate group{out.duplicateGroups === 1 ? "" : "s"}
            {out.dryRun && ` · ${selected} ticked`}
            {!out.dryRun && ` · ${out.merged} merged · ${out.itemsMoved} collection entries moved`}
            {" — "}
            {out.note}
          </p>
          {out.truncated > 0 && (
            <p className="m-0 mt-1 text-brand-warning">
              Showing the first {out.groups.length}; {out.truncated} more will be listed after
              this round.
            </p>
          )}
          {out.dryRun && out.groups.length > 0 && (
            <ul className="mt-2 flex max-h-[26rem] list-none flex-col gap-1.5 overflow-y-auto p-0">
              {out.groups.map((g) => {
                const on = !skipped.has(g.key);
                return (
                  <li
                    key={g.key}
                    className={`rounded-[10px] border p-2 ${on ? "border-brand-line" : "border-brand-line opacity-45"}`}
                  >
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0"
                        checked={on}
                        onChange={() =>
                          setSkipped((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.key)) next.delete(g.key);
                            else next.add(g.key);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium">
                          {g.name}
                          <span className="font-normal opacity-70"> · {g.set ?? "no set"}</span>
                        </div>
                        {/* Said plainly and in the row itself. A warning in
                            a legend somewhere is a warning nobody reads at
                            the moment they are about to delete a card. */}
                        {g.warning && (
                          <div
                            className={`mt-1 rounded px-2 py-1 text-[11px] leading-snug ${
                              g.blocked
                                ? "bg-brand-negative/15 text-brand-negative"
                                : "bg-brand-warning/15 text-brand-warning"
                            }`}
                          >
                            {g.warning}
                          </div>
                        )}
                        {/* The pictures ARE the check: two thumbnails of the
                            same art means one card under two ids; two
                            different arts means leave it alone. */}
                        <div className="mt-1 flex flex-wrap gap-2">
                          {g.rows.map((r) => (
                            <div key={r.id} className="w-[74px] shrink-0">
                              <div className="aspect-[63/88] w-full overflow-hidden rounded bg-brand-sunken">
                                {r.image ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={artSrc(r.id, r.image)!}
                                    alt={`${g.name} ${r.id}`}
                                    className="h-full w-full object-cover"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-[10px] opacity-60">
                                    no art
                                  </div>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-[9.5px] leading-tight">
                                <div className={r.survivor ? "text-brand-positive" : "opacity-70"}>
                                  {r.survivor ? "KEEP" : "merge"} #{r.number}
                                </div>
                                <div className="truncate opacity-60" title={r.id}>
                                  {r.id}
                                </div>
                                <div className="opacity-60">
                                  {r.owned > 0 ? `${r.owned} owned` : "unowned"}
                                  {r.price != null ? ` · $${r.price.toFixed(2)}` : ""}
                                  {r.locked ? " · 🔒" : ""}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
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


/** The recent server log, readable and downloadable from a phone.
 *
 *  The background jobs narrate themselves to the console, but on Railway
 *  that output needs a desktop and the right deployment selected before the
 *  interesting lines scroll away. This is the same output, kept by the
 *  process, in a form that can be read here or handed to somebody as a file.
 *
 *  Per process: a deploy or restart empties it, which the header states
 *  rather than leaving a gap to be misread as silence. */
function ServerLogPanel() {
  const [entries, setEntries] = useState<Array<{ t: string; level: string; msg: string }>>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/logs", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't read the log");
      setEntries(json.entries ?? []);
      setStartedAt(json.startedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the log");
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = onlyProblems
    ? entries.filter((e) => e.level === "error" || e.level === "warn")
    : entries;
  // Newest first: the reason anyone opens a log is what just happened.
  const ordered = [...shown].reverse();

  async function copyAll() {
    const text = ordered
      .slice()
      .reverse()
      .map((e) => `${e.t} [${e.level}] ${e.msg}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — use Download instead.");
    }
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        What this server has been doing: the background jobs, their results, and anything
        that failed. Kept by the running process, so a deploy or restart starts it fresh —
        Railway&apos;s own logs remain the complete record.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary text-xs" disabled={busy} onClick={load}>
          {busy ? "Reading…" : "Refresh"}
        </button>
        <a className="btn-secondary text-xs" href="/api/admin/logs?format=text" download>
          Download
        </a>
        <button className="btn-secondary text-xs" onClick={copyAll} disabled={ordered.length === 0}>
          {copied ? "Copied" : "Copy"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-brand-ink4">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
          />
          Problems only
        </label>
      </div>

      {startedAt && (
        <p className="m-0 text-[11px] text-brand-ink5">
          Process up since {new Date(startedAt).toLocaleString()} · {entries.length} lines
          {onlyProblems && ` · showing ${ordered.length}`}
        </p>
      )}
      {error && <p className="m-0 text-xs text-brand-negative">{error}</p>}

      {ordered.length === 0 ? (
        <p className="m-0 text-xs text-brand-ink5">
          Nothing logged yet. The background jobs report when they run — the first is a few
          minutes after a restart.
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded border border-brand-line bg-brand-sunken p-2">
          {ordered.map((e, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-snug ${
                e.level === "error"
                  ? "text-brand-negative"
                  : e.level === "warn"
                    ? "text-brand-warning"
                    : "text-brand-ink4"
              }`}
            >
              <span className="opacity-50">{new Date(e.t).toLocaleTimeString()} </span>
              {e.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What our own search did with a query.
 *
 *  set-probe asks what the SOURCES hold; this asks what our pipeline made of
 *  it. Between them, "the card is missing" lands in one of four places — the
 *  query parsed wrong, the catalogue lacks it, the external call was skipped,
 *  or the merge or the cap threw it away — rather than being narrowed down
 *  over days by editing code and looking again. Runs the real search. */
function SearchProbePanel() {
  const [q, setQ] = useState("Haunter");
  /** Trace the picker's escalation rather than a plain search. Off by
   *  default because it spends paid credits. */
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    source?: string;
    resultCount?: number;
    results?: string[];
    notes?: string[];
    trace?: {
      parsed: Record<string, unknown>;
      listingSet: boolean;
      needExternal: boolean;
      stages: Array<{ stage: string; detail: string; count?: number; sample?: string[] }>;
      foldedAway: string[];
      cutByLimit: string[];
    };
    error?: string;
  } | null>(null);

  async function run() {
    setBusy(true);
    setOut(null);
    try {
      const res = await fetch(
        `/api/admin/search-probe?q=${encodeURIComponent(q)}${deep ? "&deep=1" : ""}`
      );
      const json = await res.json();
      setOut(res.ok ? json : { error: json.error || "Probe failed" });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "Probe failed" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        Runs the real card search and reports every stage — what the query parsed to, what our
        catalogue answered, whether the outside sources were asked and why, and what the merge
        and the result cap threw away.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className="input w-full text-xs sm:w-72"
          placeholder='Anything you would type in Add card — "Haunter", "set:trick or trade"'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button className="btn-secondary shrink-0 text-xs" disabled={busy} onClick={run}>
          {busy ? "Tracing…" : "Trace it"}
        </button>
        <label className="flex items-center gap-1 text-[11px] text-brand-ink4">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          every source (spends credits)
        </label>
      </div>

      {out?.error && <p className="m-0 text-xs text-brand-negative">{out.error}</p>}

      {(out?.notes?.length ?? 0) > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11.5px] leading-snug text-amber-900">
          {out!.notes!.map((n, i) => (
            <p key={i} className="m-0 mb-1 last:mb-0">
              {n}
            </p>
          ))}
        </div>
      )}

      {out?.trace && (
        <>
          <div className="text-[11px] text-brand-ink4">
            <span className="font-semibold text-brand-ink3">Parsed as:</span>{" "}
            <span className="font-mono">{JSON.stringify(out.trace.parsed)}</span>
            {out.trace.listingSet && " · set listing"}
          </div>
          <div className="text-[11px] text-brand-ink4">
            <span className="font-semibold text-brand-ink3">Result:</span> {out.resultCount} cards
            from {out.source}
          </div>
          {out.trace.stages.map((st, i) => (
            <details key={i} className="text-[11px] text-brand-ink4">
              <summary className="cursor-pointer">
                <span className="font-semibold text-brand-ink3">{st.stage}</span>
                {st.count != null && <> — {st.count}</>}
              </summary>
              <p className="m-0 mt-1">{st.detail}</p>
              {(st.sample?.length ?? 0) > 0 && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
                  {st.sample!.join("\n")}
                </pre>
              )}
            </details>
          ))}
          {out.trace.foldedAway.length > 0 && (
            <details className="text-[11px] text-brand-ink4">
              <summary className="cursor-pointer text-brand-negative">
                Folded away as duplicates — {out.trace.foldedAway.length}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
                {out.trace.foldedAway.join("\n")}
              </pre>
            </details>
          )}
          {out.trace.cutByLimit.length > 0 && (
            <details className="text-[11px] text-brand-ink4">
              <summary className="cursor-pointer text-brand-negative">
                Cut by the result limit — {out.trace.cutByLimit.length}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
                {out.trace.cutByLimit.join("\n")}
              </pre>
            </details>
          )}
          <details className="text-[11px] text-brand-ink4">
            <summary className="cursor-pointer">What the search returned</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
              {(out.results ?? []).join("\n")}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

/** Move ball-pattern copies onto the printing's own card.
 *
 *  The same card could be recorded two ways: the plain card wearing a "Poké
 *  Ball pattern" finish, or the printing's own row. Saving prefers the row
 *  now, so nothing new splits — this is for everything recorded before that,
 *  which is otherwise valued as the plain card it isn't. */
function PatternConsolidatePanel() {
  const [out, setOut] = useState<{
    dryRun?: boolean;
    considered?: number;
    moved?: number;
    moves?: Array<{
      card: string;
      from: string;
      to: string;
      toCard: string;
      quantity: number;
      merged: boolean;
    }>;
    skipped?: string[];
    skippedCount?: number;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/pattern-consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const json = await res.json();
      setOut(res.ok ? json : { error: json.error || "Failed" });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "Failed" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        A Poké Ball reverse holo can be recorded as the plain card with a pattern finish, or as
        the printing&apos;s own card. Only the second carries that printing&apos;s real price.
        New saves already prefer it; this moves the ones saved before that. Copies whose
        printing we hold no row for are left alone — the finish is doing its job there.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary text-xs" disabled={busy} onClick={() => void run(true)}>
          {busy ? "Checking…" : "Preview"}
        </button>
        <button
          className="btn-secondary text-xs"
          disabled={busy || !out || (out.moved ?? 0) === 0}
          onClick={() => void run(false)}
        >
          Move them
        </button>
      </div>

      {out?.error && <p className="m-0 text-xs text-brand-negative">{out.error}</p>}
      {out && !out.error && (
        <p className="m-0 text-xs text-brand-ink3">
          {out.dryRun ? "Would move" : "Moved"} {out.moved} of {out.considered} pattern
          {(out.considered ?? 0) === 1 ? " copy" : " copies"}
          {(out.skippedCount ?? 0) > 0 && ` · ${out.skippedCount} left alone`}
        </p>
      )}
      {(out?.moves?.length ?? 0) > 0 && (
        <div className="max-h-56 space-y-0.5 overflow-y-auto text-[11px] text-brand-ink4">
          {out!.moves!.map((m, i) => (
            <div key={i} className="font-mono">
              {m.quantity}× {m.card}: {m.from} → &ldquo;{m.toCard}&rdquo; ({m.to})
              {m.merged ? " · merged into an existing row" : ""}
            </div>
          ))}
        </div>
      )}
      {(out?.skipped?.length ?? 0) > 0 && (
        <details className="text-[11px] text-brand-ink4">
          <summary className="cursor-pointer">Left alone</summary>
          <div className="mt-1 space-y-0.5">
            {out!.skipped!.map((sk, i) => (
              <div key={i}>{sk}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Where recent scans spent their time.
 *
 *  A slow scan has three possible culprits and one number, so the number
 *  tells you nothing. This splits it: what the model took to read the photo,
 *  what matching took, and for each card which source answered. Cards
 *  answered by our own catalogue are effectively free; anything answered
 *  outside is a network round trip, and those are what a 57-second nine-card
 *  scan is made of. */
function ScanLogPanel() {
  const [out, setOut] = useState<{
    scans?: Array<{
      id: string;
      at: string;
      status: string;
      cardCount: number;
      durationMs: number | null;
      modelMs: number | null;
      matchMs: number | null;
      byPath: Record<string, number>;
      slowest: Array<{ name: string; ms: number; path: string; swapped?: boolean }>;
      error: string | null;
    }>;
    summary?: {
      scans: number;
      avgModelMs: number;
      avgMatchMs: number;
      fromCatalogue: number;
      fromOutside: number;
      unmatched: number;
    } | null;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/scan-log");
      const json = await res.json();
      setOut(res.ok ? json : { error: json.error || "Failed" });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "Failed" });
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const secs = (ms: number | null) => (ms == null ? "?" : `${(ms / 1000).toFixed(1)}s`);

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        Every scan records where its time went. A card answered by our own catalogue is
        instant; one answered by an external database is a round trip, and a handful of those
        is what makes one scan take four times as long as another.
      </p>
      <button className="btn-secondary text-xs" disabled={busy} onClick={() => void load()}>
        {busy ? "Loading…" : "Refresh"}
      </button>

      {out?.error && <p className="m-0 text-xs text-brand-negative">{out.error}</p>}

      {out?.summary && (
        <p className="m-0 text-xs text-brand-ink3">
          Last {out.summary.scans} timed scans: model {secs(out.summary.avgModelMs)} avg, matching{" "}
          {secs(out.summary.avgMatchMs)} avg · {out.summary.fromCatalogue} cards from our
          catalogue, {out.summary.fromOutside} from outside
          {out.summary.unmatched > 0 && `, ${out.summary.unmatched} unmatched`}.
        </p>
      )}
      {out && !out.summary && (
        <p className="m-0 text-xs text-brand-ink4">
          No timing data yet — run migration 053, then scan something.
        </p>
      )}

      <div className="space-y-1">
        {(out?.scans ?? []).map((s) => (
          <details key={s.id} className="text-[11px] text-brand-ink4">
            <summary className="cursor-pointer">
              <span
                className={
                  (s.durationMs ?? 0) > 20000 ? "text-brand-negative" : "text-brand-ink3"
                }
              >
                {secs(s.durationMs)}
              </span>{" "}
              · {s.cardCount} card{s.cardCount === 1 ? "" : "s"} ·{" "}
              {new Date(s.at).toLocaleString()}
              {s.status !== "done" && ` · ${s.status}`}
            </summary>
            <div className="mt-1 space-y-0.5">
              <div>
                model {secs(s.modelMs)} · matching {secs(s.matchMs)}
                {Object.keys(s.byPath).length > 0 &&
                  " · " +
                    Object.entries(s.byPath)
                      .map(([k, v]) => `${v} ${k}`)
                      .join(", ")}
              </div>
              {s.slowest.map((c, i) => (
                <div key={i} className="font-mono">
                  {secs(c.ms)} {c.name} via {c.path}
                  {c.swapped ? " (swapped to a printing)" : ""}
                </div>
              ))}
              {s.error && <div className="text-brand-negative">{s.error}</div>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

/** Why a set search returns what it returns.
 *
 *  The same checks as scripts/probe-set-search.sh, run from the server. The
 *  script needs a terminal, curl and jq; this needs a thumb — which matters,
 *  because the person who needs the answer is usually holding a phone and a
 *  stack of cards. Asks the sources directly rather than through our own
 *  search, so the answer is what upstream holds rather than what our code
 *  made of it. Read-only, free requests. */
function SetProbePanel() {
  const [setName, setSetName] = useState("trick or trade");
  const [card, setCard] = useState("Haunter");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    upstreamSets?: Array<{ id: string; name: string; total?: number; releaseDate?: string }>;
    setsError?: string | null;
    attempts?: Array<{
      query: string;
      asks: string;
      ok: boolean;
      count: number | null;
      sets?: string[];
      sample?: string[];
      error?: string;
    }>;
    tcgdex?: { sets: Array<{ id: string; name: string; cards: number }>; cards: string[]; error?: string | null };
    paid?: {
      configured: boolean;
      creditsRemaining: number;
      fetched: boolean;
      knownSets?: number;
      matchingSets?: Array<{ id: string; name: string }>;
      count?: number;
      log?: string;
      sample?: string[];
    };
    ourCatalogue?: { count: number; setNames: string[]; sample: string[]; hasCard: boolean | null };
    notes?: string[];
    error?: string;
  } | null>(null);

  async function run(spend = false) {
    setBusy(true);
    setOut(null);
    try {
      const res = await fetch(
        `/api/admin/set-probe?set=${encodeURIComponent(setName)}&card=${encodeURIComponent(card)}` +
          (spend ? "&paid=1" : "")
      );
      const json = await res.json();
      setOut(res.ok ? json : { error: json.error || "Probe failed" });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "Probe failed" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        Asks pokemontcg.io and TCGdex directly what they hold for a set, and compares it with
        our own catalogue — so &ldquo;the card is missing&rdquo; can be pinned on the right
        one. Changes nothing.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className="input w-full text-xs sm:w-56"
          placeholder="Set name, or part of it"
          value={setName}
          onChange={(e) => setSetName(e.target.value)}
        />
        <input
          className="input w-full text-xs sm:w-36"
          placeholder="A card that should be in it"
          value={card}
          onChange={(e) => setCard(e.target.value)}
        />
        <button className="btn-secondary shrink-0 text-xs" disabled={busy} onClick={() => run(false)}>
          {busy ? "Asking…" : "Run the check"}
        </button>
        <button
          className="btn-secondary shrink-0 text-xs"
          disabled={busy}
          onClick={() => run(true)}
          title="Also fetches the set from the paid source — 200 credits per matching set"
        >
          {busy ? "Asking…" : "…and buy the set list (200 credits)"}
        </button>
      </div>

      {out?.error && <p className="m-0 text-xs text-brand-negative">{out.error}</p>}

      {(out?.notes?.length ?? 0) > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11.5px] leading-snug text-amber-900">
          {out!.notes!.map((n, i) => (
            <p key={i} className="m-0 mb-1 last:mb-0">
              {n}
            </p>
          ))}
        </div>
      )}

      {out?.upstreamSets && (
        <div className="text-[11px] text-brand-ink4">
          <div className="font-semibold text-brand-ink3">
            pokemontcg.io sets matching &ldquo;{setName}&rdquo;: {out.upstreamSets.length}
          </div>
          {out.upstreamSets.map((s) => (
            <div key={s.id} className="font-mono">
              {s.name} · {s.total ?? "?"} cards · {s.releaseDate ?? "?"}
            </div>
          ))}
        </div>
      )}

      {out?.ourCatalogue && (
        <div className="text-[11px] text-brand-ink4">
          <span className="font-semibold text-brand-ink3">Our catalogue:</span>{" "}
          {out.ourCatalogue.count} cards
          {out.ourCatalogue.hasCard != null &&
            ` · ${card}: ${out.ourCatalogue.hasCard ? "present" : "MISSING"}`}
        </div>
      )}

      {out?.tcgdex && (
        <div className="text-[11px] text-brand-ink4">
          <span className="font-semibold text-brand-ink3">TCGdex:</span>{" "}
          {out.tcgdex.error
            ? out.tcgdex.error
            : `${out.tcgdex.sets.length} matching set(s), ${out.tcgdex.cards.length} cards`}
          {out.tcgdex.sets.map((s) => (
            <div key={s.id} className="font-mono">
              {s.name} · {s.cards} cards
            </div>
          ))}
        </div>
      )}

      {out?.paid && (
        <div className="text-[11px] text-brand-ink4">
          <span className="font-semibold text-brand-ink3">Paid source:</span>{" "}
          {!out.paid.configured
            ? "no key configured — skipped entirely"
            : `${out.paid.creditsRemaining} credits left today` +
              (out.paid.knownSets != null ? ` · ${out.paid.knownSets} sets known` : "") +
              (out.paid.matchingSets ? ` · ${out.paid.matchingSets.length} matching this name` : "")}
          {out.paid.matchingSets?.map((s) => (
            <div key={s.id} className="font-mono">
              {s.name} · {s.id}
            </div>
          ))}
          {out.paid.fetched && (
            <>
              <div className="mt-1">
                Fetched {out.paid.count} cards. {out.paid.log}
              </div>
              {(out.paid.sample?.length ?? 0) > 0 && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
                  {out.paid.sample!.join("\n")}
                </pre>
              )}
            </>
          )}
        </div>
      )}

      {out?.attempts?.map((a, i) => (
        <details key={i} className="text-[11px] text-brand-ink4">
          <summary className="cursor-pointer">
            <span className={a.ok && (a.count ?? 0) > 0 ? "text-brand-positive" : "text-brand-negative"}>
              {a.ok ? (a.count ?? 0) : (a.error ?? "error")}
            </span>{" "}
            — <span className="font-mono">{a.query}</span>
          </summary>
          <p className="m-0 mt-1">{a.asks}</p>
          {a.error && <p className="m-0 text-brand-negative">{a.error}</p>}
          {(a.sets?.length ?? 0) > 0 && (
            <p className="m-0 mt-1">Sets returned: {a.sets!.join(", ")}</p>
          )}
          {(a.sample?.length ?? 0) > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-brand-sunken p-2">
              {a.sample!.join("\n")}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

/** Asks the paid source whether it carries sealed product at all.
 *
 *  Everything built against them so far is card-shaped, so whether booster
 *  boxes and Elite Trainer Boxes exist in their index is genuinely unknown.
 *  This tries a few plausible shapes for the question and reports what came
 *  back — a 404 is a real answer and shown as one. Nothing is built on any
 *  of it until an attempt succeeds. Costs a few credits. */
function SealedProbePanel() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    verdict?: string;
    hits?: Array<{ path: string; query: string; firstName: string | null }>;
    attempts?: Array<Record<string, unknown>>;
    error?: string;
  } | null>(null);

  async function run() {
    setBusy(true);
    setOut(null);
    try {
      const res = await fetch("/api/admin/sealed-probe");
      const json = await res.json();
      setOut(res.ok ? json : { error: json.error || "Probe failed" });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "Probe failed" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-xs text-brand-ink4">
        Asks the paid pricing source whether it holds booster boxes, Elite Trainer Boxes and
        tins — the thing we&apos;d need before sealed product could go in a collection with a
        value on it. Costs a handful of credits and changes nothing.
      </p>
      <button className="btn-secondary text-xs" disabled={busy} onClick={run}>
        {busy ? "Asking…" : "Run the check"}
      </button>
      {out?.error && <p className="m-0 text-xs text-brand-negative">{out.error}</p>}
      {out?.verdict && (
        <>
          <p className="m-0 text-xs font-semibold text-brand-ink3">{out.verdict}</p>
          {(out.hits?.length ?? 0) > 0 && (
            <div className="font-mono text-[11px] text-brand-ink4">
              {out.hits!.map((h, i) => (
                <div key={i}>
                  {h.path} · {h.query} → {h.firstName}
                </div>
              ))}
            </div>
          )}
          <details className="text-[11px] text-brand-ink4">
            <summary className="cursor-pointer">Every attempt, verbatim</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-brand-sunken p-2">
              {JSON.stringify(out.attempts, null, 1)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
