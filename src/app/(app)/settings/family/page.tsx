"use client";

// Family settings, from App Screens artboard 07. Members table with
// per-profile usage bars and caps, plus the one parent control that's real
// today (the trade board toggle backed by profiles.trade_board_enabled).
// The mock's other toggles — spending approvals, outside-trade approvals,
// value hiding, digest — arrive with the features behind them; a switch
// that flips a column nothing reads would be theatre.

import { useCallback, useEffect, useState } from "react";
import Modal, { ModalClose } from "@/components/Modal";
import { MONTHLY_GRANT } from "@/lib/credits";
import { artSrc } from "@/lib/art";
import { itemPrice, type CollectionItem } from "@/lib/types";

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
    meId: string;
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

interface InviteData {
  incoming: Array<{ id: string; role: string; token: string; expiresAt: string; from: string }>;
  sent: Array<{ id: string; email: string; role: string; token: string; expires_at: string }>;
}

export default function FamilyPage() {
  const [data, setData] = useState<FamilyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"kid" | "parent">("kid");
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});
  const [invites, setInvites] = useState<InviteData>({ incoming: [], sent: [] });
  // The invitation link, shown once after sending. There is no outbound mail
  // yet, so this IS the delivery mechanism — hiding it would mean the
  // invitation quietly went nowhere.
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Which pending invitation was just copied, so only that row says so. */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [peeking, setPeeking] = useState<{ id: string; name: string } | null>(null);

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

  const loadInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/family/invites");
      if (res.ok) setInvites(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    loadInvites();
  }, [load, loadInvites]);

  async function answerInvite(token: string, accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/family/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, accept }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't answer that invitation");
      await Promise.all([load(), loadInvites()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't answer that invitation");
    }
    setBusy(false);
  }

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

  // Somebody has asked to add this account to their family. Shown before
  // anything else on the page: it is a request for real control over this
  // account, so it should not be something you have to go looking for.
  const incoming = invites.incoming.length > 0 && (
    <div className="mb-5 overflow-hidden rounded-[18px] border border-brand-accent bg-white">
      <div className="border-b border-brand-line-soft px-5 py-3 font-display text-[15px] font-bold">
        {invites.incoming.length === 1 ? "A family invitation" : "Family invitations"}
      </div>
      {invites.incoming.map((i) => (
        <div key={i.id} className="px-5 py-4">
          <p className="m-0 mb-1 text-[14px]">
            <b>{i.from}</b> invited you to join their family as a{" "}
            {i.role === "parent" ? "parent" : "kid"} profile.
          </p>
          <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-brand-ink3">
            Your credits would come from their shared pool, and a parent could set a monthly
            limit for you and see what you&apos;ve used. Your collection, decks and trades stay
            yours, and you can leave whenever you like.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-full bg-brand-ink px-4 py-2 text-[13px] font-medium text-brand-canvas disabled:opacity-50"
              disabled={busy}
              onClick={() => answerInvite(i.token, true)}
            >
              Accept
            </button>
            <button
              className="rounded-full border border-brand-line-strong px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              disabled={busy}
              onClick={() => answerInvite(i.token, false)}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  if (!data.group) {
    return (
      <div className="max-w-2xl">
        <h2 className="m-0 mb-1 font-display text-2xl font-bold tracking-[-.025em]">Family</h2>
        {incoming}
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
            {g.members.length} of 5 profiles used
            {invites.sent.length > 0 && ` · ${invites.sent.length} invited`} ·{" "}
            {g.poolGrant.toLocaleString()} shared credits a month
          </p>
        </div>
      </div>
      {incoming}
      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <BoostRequests myRole={g.myRole} />

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
                  {m.userId !== g.meId && (
                    <button
                      className="mt-0.5 text-xs font-medium text-brand-accent hover:underline"
                      onClick={() => setPeeking({ id: m.userId, name: m.name })}
                    >
                      View cards
                    </button>
                  )}
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

      {amParent && g.members.length + invites.sent.length < 5 && (
        <form
          className="mb-4 flex flex-wrap items-end gap-2 rounded-[18px] border border-brand-line bg-brand-panel p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!inviteEmail.trim()) return;
            setBusy(true);
            setError(null);
            setLastLink(null);
            try {
              const res = await fetch("/api/family", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "invite", email: inviteEmail.trim(), role: inviteRole }),
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "Couldn't send that invitation");
              setLastLink(json.link ?? null);
              setInviteEmail("");
              setCopied(false);
              await loadInvites();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't send that invitation");
            }
            setBusy(false);
          }}
        >
          <div className="min-w-[220px] flex-1">
            <label className="mb-1.5 block text-[12.5px] font-medium text-brand-ink3">
              Invite a trainer — they choose whether to join
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
            {busy ? "Sending…" : "Send invite"}
          </button>
        </form>
      )}

      {lastLink && (
        <div className="mb-4 rounded-[18px] border border-brand-line bg-white p-4">
          <p className="m-0 mb-2 text-[13.5px] font-medium">
            Invitation created — send them this link
          </p>
          <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-brand-ink3">
            They join only when they open it and agree. Nothing has changed on their account
            yet, and the link stops working after 14 days.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[10px] bg-brand-sunken px-3 py-2 font-mono text-[12px]">
              {lastLink}
            </code>
            <button
              className="btn-secondary shrink-0 text-[13px]"
              onClick={() => {
                navigator.clipboard?.writeText(lastLink).then(
                  () => setCopied(true),
                  () => setCopied(false)
                );
              }}
            >
              {copied ? "Copied ✓" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      {invites.sent.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-[18px] border border-brand-line bg-brand-panel">
          <div className="border-b border-brand-line-soft px-5 py-3 font-display text-[15px] font-bold">
            Waiting on a reply
          </div>
          {invites.sent.map((i) => (
            <div
              key={i.id}
              className="flex flex-wrap items-center gap-3 border-b border-brand-panel-alt px-5 py-3 text-[13.5px] last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate">{i.email}</span>
              <span className="font-mono text-[11.5px] text-brand-ink4">
                {i.role === "parent" ? "parent" : "kid"}
              </span>
              {/* The link, again, for as long as the invitation is alive.
                  It used to exist only in React state for the seconds after
                  sending: navigate away or reload and the only way back to
                  it was to cancel the invitation and make a new one. The
                  token was in this list the whole time — the API has always
                  returned it — it simply was not being used. Showing it
                  grants nothing new either: a parent who can cancel an
                  invitation can already do more to it than resend it. */}
              <button
                className="text-[12.5px] text-brand-accent underline"
                onClick={() => {
                  const link = `${window.location.origin}/family/join/${i.token}`;
                  navigator.clipboard?.writeText(link).then(
                    () => setCopiedId(i.id),
                    () => setLastLink(link)
                  );
                }}
              >
                {copiedId === i.id ? "Copied ✓" : "Copy link"}
              </button>
              <button
                className="text-[12.5px] text-brand-ink5 underline hover:text-brand-negative"
                onClick={async () => {
                  await fetch("/api/family/invites", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: i.id }),
                  });
                  loadInvites();
                }}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-[12.5px] leading-relaxed text-brand-ink5">
        Kids can&apos;t buy boosts — a purchase attempt tells them to ask a parent. More parent
        controls (spending approvals, outside-trade approvals, weekly digest) arrive with those
        features.
      </p>

      {peeking && (
        <CollectionPeek
          userId={peeking.id}
          name={peeking.name}
          onClose={() => setPeeking(null)}
        />
      )}
    </div>
  );
}

/** One household member's cards, to look at and nothing else.
 *
 *  Deliberately not the collection page in disguise. That page is built for
 *  the person who owns the cards — add, edit quantities, set a value, delete
 *  — and none of it applies here. What a parent actually wants is the answer
 *  to "does she already have this one", so: every card, biggest first, with
 *  a count and a total. */
function CollectionPeek({
  userId,
  name,
  onClose,
}: {
  userId: string;
  name: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/family/collection/${userId}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!live) return;
        if (!ok) throw new Error(j.error || "Couldn't load that collection.");
        setItems(j.items ?? []);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load it."));
    return () => {
      live = false;
    };
  }, [userId]);

  const cards = (items ?? []).reduce((s, it) => s + it.quantity, 0);
  const value = (items ?? []).reduce((s, it) => s + (itemPrice(it) ?? 0) * it.quantity, 0);
  // Most valuable first: scrolling a thousand cards alphabetically to find
  // out whether anything good is in there is not an answer to any question.
  const sorted = [...(items ?? [])].sort(
    (a, b) => (itemPrice(b) ?? 0) - (itemPrice(a) ?? 0)
  );

  return (
    <Modal onClose={onClose} size="xl" labelledBy="peek-title">
      <>
        <div className="flex items-start justify-between gap-2">
          <h2 id="peek-title" className="min-w-0 break-words font-display text-xl font-bold">
            {name}&apos;s cards
          </h2>
          <ModalClose onClose={onClose} />
        </div>

        {error ? (
          <p className="mt-3 text-sm text-brand-negative">{error}</p>
        ) : items === null ? (
          <p className="mt-3 text-sm text-brand-ink3">Loading…</p>
        ) : items.length === 0 ? (
          <p className="mt-3 text-sm text-brand-ink3">
            {name} hasn&apos;t added any cards yet.
          </p>
        ) : (
          <>
            <p className="mt-1 font-mono text-xs text-brand-ink3">
              {cards.toLocaleString()} cards · ${value.toFixed(2)}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-6">
              {sorted.map((it) => {
                const src = artSrc(it.card.id, it.card.image_small);
                const price = itemPrice(it);
                return (
                  <div key={it.id} className="min-w-0">
                    <div className="relative aspect-[63/88] w-full overflow-hidden rounded bg-brand-sunken">
                      {src && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={src}
                          alt={it.card.name}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      )}
                      {it.quantity > 1 && (
                        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                          ×{it.quantity}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] font-medium">{it.card.name}</div>
                    <div className="truncate font-mono text-[10.5px] text-brand-ink4">
                      {price != null ? `$${price.toFixed(2)}` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </>
    </Modal>
  );
}

/** A kid asked for credits; a parent answers.
 *
 *  The child never reaches Stripe — approving opens checkout under the
 *  PARENT's customer, so the card and the receipt are theirs, and the
 *  credits land in the pool the child already spends from. */
function BoostRequests({ myRole }: { myRole: "parent" | "kid" }) {
  const [rows, setRows] = useState<Array<{
    id: string;
    pack: string;
    credits: number;
    price: string;
    note: string | null;
    status: string;
    mine: boolean;
    who: string;
    created_at: string;
  }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/family/boost-requests");
      const json = await res.json();
      if (res.ok) setRows(json.requests ?? []);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, action: "approve" | "decline" | "cancel") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/family/boost-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't do that");
      // Approving hands back a checkout url — the parent pays there.
      if (json.url) window.location.href = json.url as string;
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that");
    }
    setBusy(null);
  }

  const pending = (rows ?? []).filter((r) => r.status === "pending");
  if (!rows || pending.length === 0) return null;

  return (
    <div className="mb-4 rounded-[18px] border border-brand-line bg-white p-5">
      <h3 className="m-0 mb-1 font-display text-[17px] font-bold">
        Credit requests ({pending.length})
      </h3>
      <p className="m-0 mb-3 text-[13px] leading-[1.55] text-brand-ink3">
        {myRole === "parent"
          ? "Approving opens checkout on your card. The credits go into the shared pool, so everyone's caps still apply."
          : "Waiting for a parent to say yes. Nothing is charged to you."}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {pending.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded-[14px] border border-brand-line px-3.5 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">
                {r.mine ? "You" : r.who} asked for {r.credits.toLocaleString()} credits ·{" "}
                {r.price}
              </div>
              {r.note && <div className="text-[12.5px] text-brand-ink4">&ldquo;{r.note}&rdquo;</div>}
            </div>
            {myRole === "parent" ? (
              <>
                <button
                  className="btn-primary text-sm"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, "approve")}
                >
                  {busy === r.id ? "Opening…" : `Approve · ${r.price}`}
                </button>
                <button
                  className="btn-secondary text-sm"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, "decline")}
                >
                  Decline
                </button>
              </>
            ) : (
              r.mine && (
                <button
                  className="btn-secondary text-sm"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, "cancel")}
                >
                  Withdraw
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mb-0 mt-2 text-xs text-brand-negative">{error}</p>}
    </div>
  );
}
