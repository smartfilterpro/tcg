"use client";

// Your account. The controls here already existed, but scattered: your
// username and the sharing toggle lived on the Friends page, "let others add
// me" lived in the pals panel, and changing your password meant signing out
// and using the forgotten-password email. This is the one page you go to for
// anything about you rather than about your cards.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AI_NAME, APP_NAME } from "@/lib/branding";
import { formatFriendCode } from "@/lib/friendCode";

interface Account {
  email: string;
  displayName: string;
  role: string;
  plan: string;
  planExpiresAt: string | null;
  hasSubscription: boolean;
  createdAt: string | null;
  shareCollection: boolean;
  allowFriendRequests: boolean;
  friendCode: string | null;
  counts: { cards: number; decks: number; grades: number };
  ownsFamilyWith: number;
}

interface ExportToken {
  token: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

const PANEL = "rounded-[18px] border border-brand-line bg-white p-[22px]";
const TITLE = "font-display text-[17px] font-bold";
const FIELD =
  "w-full rounded-[11px] border border-brand-line-strong px-3 py-2 text-sm outline-none focus:border-brand-accent";
const PILL =
  "whitespace-nowrap rounded-full bg-brand-ink px-4 py-2 text-[13px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-50";
const PILL_QUIET =
  "whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[13px] font-medium hover:bg-brand-sunken disabled:opacity-50";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  family: "Family",
};

function Toggle({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-brand-accent" : "bg-brand-line-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export default function AccountPage() {
  const [data, setData] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [nameDraft, setNameDraft] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportToken, setExportToken] = useState<ExportToken | null>(null);
  const [tokenShown, setTokenShown] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't load your account");
      setData(json);
      setNameDraft(json.displayName ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your account");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fetched separately and never blocking: the export link is a convenience,
  // and a failure here should not stop somebody changing their password.
  useEffect(() => {
    fetch("/api/export/token")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.token && setExportToken(j))
      .catch(() => {});
  }, []);

  async function rotateToken() {
    if (!confirm("Replace the export link? The old one stops working immediately.")) return;
    setTokenBusy(true);
    try {
      const res = await fetch("/api/export/token", { method: "POST" });
      const json = await res.json();
      if (res.ok && json.token) {
        setExportToken(json);
        setTokenShown(true);
        setNotice("New export link created — the old one no longer works.");
      }
    } catch {
      setError("Couldn't create a new link.");
    }
    setTokenBusy(false);
  }

  async function send(input: string, init: RequestInit, ok: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(input, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "That didn't work");
      await load();
      setNotice(ok);
      setBusy(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
      setBusy(false);
      return false;
    }
  }

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  /** Re-authenticate before changing the password.
   *
   *  Supabase's updateUser will change it from an active session without
   *  asking for the old one, which means an unattended logged-in browser is
   *  enough to lock the owner out of their own account. Signing in with the
   *  current password first is the check it doesn't do. */
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setPwBusy(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = createClient();
      const { error: reauth } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: currentPw,
      });
      if (reauth) throw new Error("That's not your current password.");
      const { error: upd } = await supabase.auth.updateUser({ password: newPw });
      if (upd) throw new Error(upd.message);
      setCurrentPw("");
      setNewPw("");
      setNotice("Password changed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change your password");
    }
    setPwBusy(false);
  }

  async function deleteAccount() {
    const done = await send(
      "/api/account",
      json("DELETE", { confirmEmail: confirmDelete }),
      "Account deleted."
    );
    if (done) window.location.href = "/";
  }

  if (error && !data) {
    return <p className="text-sm text-brand-negative">{error}</p>;
  }
  if (!data) return <p className="text-sm text-brand-ink4">Loading your account…</p>;

  const isAdmin = data.role === "admin";

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      <div>
        <h2 className="m-0 mb-1 font-display text-2xl font-bold tracking-[-.025em]">Account</h2>
        <p className="m-0 text-[14.5px] leading-[1.6] text-brand-ink3">
          Who you are on {APP_NAME}, who can see you, and how to get out.
        </p>
      </div>

      {error && (
        <div className="rounded-[14px] border border-brand-line bg-white px-4 py-3 text-[13px] text-brand-negative">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-[14px] border border-brand-line bg-white px-4 py-3 text-[13px] text-brand-positive">
          {notice}
        </div>
      )}

      {/* ---- identity ---- */}
      <div className={PANEL}>
        <div className={`${TITLE} mb-3`}>You</div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-brand-line-soft pb-3">
          <span className="text-[13px] text-brand-ink3">Email</span>
          <span className="font-mono text-[13px]">{data.email}</span>
        </div>
        {data.createdAt && (
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-brand-line-soft pb-3">
            <span className="text-[13px] text-brand-ink3">Joined</span>
            <span className="text-[13px]">
              {new Date(data.createdAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
          </div>
        )}
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            send("/api/account", json("PATCH", { displayName: nameDraft }), "Username saved.");
          }}
        >
          <label className="text-[13px] font-medium text-brand-ink3">
            Username
            <span className="ml-1.5 font-normal text-brand-ink5">
              — what other members see instead of your email
            </span>
          </label>
          <div className="flex gap-2">
            <input
              className={FIELD}
              maxLength={30}
              value={nameDraft}
              placeholder="e.g. AshK"
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <button
              className={PILL}
              disabled={busy || !nameDraft.trim() || nameDraft.trim() === data.displayName}
            >
              Save
            </button>
          </div>
        </form>
      </div>

      {/* ---- privacy ---- */}
      <div className={PANEL}>
        <div className={`${TITLE} mb-1`}>Who can see you</div>
        <p className="mb-3 text-[13px] leading-[1.55] text-brand-ink3">
          Both of these are off-by-default in spirit: nobody finds you by browsing. Members reach
          you because you gave them your code.
        </p>

        <div className="flex items-start gap-3 border-t border-brand-line-soft py-3">
          <Toggle
            on={data.shareCollection}
            label="Share my collection"
            disabled={busy}
            onClick={() =>
              send(
                "/api/friends",
                json("POST", { share: !data.shareCollection }),
                data.shareCollection ? "Collection hidden." : "Collection shared."
              )
            }
          />
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">Share my collection</div>
            <div className="text-[12.5px] leading-[1.5] text-brand-ink3">
              {data.shareCollection
                ? "On — members sharing theirs can see what you own and propose trades."
                : "Off — nobody can see your cards or propose a trade."}
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3 border-t border-brand-line-soft py-3">
          <Toggle
            on={data.allowFriendRequests}
            label="Let others add me"
            disabled={busy}
            onClick={() =>
              send(
                "/api/friends/requests",
                json("PATCH", { allowRequests: !data.allowFriendRequests }),
                data.allowFriendRequests ? "Friend requests off." : "Friend requests on."
              )
            }
          />
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">Let others add me</div>
            <div className="text-[12.5px] leading-[1.5] text-brand-ink3">
              {data.allowFriendRequests
                ? "On — someone holding your friend code can send you a request."
                : "Off — your code won't work for anyone, and you can't send requests either."}
            </div>
          </div>
        </div>

        {data.friendCode && (
          <div className="flex flex-wrap items-center gap-2 border-t border-brand-line-soft pt-3">
            <span className="text-[13px] text-brand-ink3">Your friend code</span>
            <span className="font-mono text-[15px] font-medium tracking-[.12em]">
              {formatFriendCode(data.friendCode)}
            </span>
            <Link href="/friends" className="ml-auto text-[12.5px] text-brand-accent hover:underline">
              Share it →
            </Link>
          </div>
        )}
      </div>

      {/* ---- password ---- */}
      <div className={PANEL}>
        <div className={`${TITLE} mb-3`}>Password</div>
        <form className="flex flex-col gap-2" onSubmit={changePassword}>
          <input
            type="password"
            className={FIELD}
            autoComplete="current-password"
            placeholder="Current password"
            required
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
          />
          <input
            type="password"
            className={FIELD}
            autoComplete="new-password"
            placeholder="New password (8+ characters)"
            required
            minLength={8}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
          <button className={`${PILL} self-start`} disabled={pwBusy || !currentPw || newPw.length < 8}>
            {pwBusy ? "Changing…" : "Change password"}
          </button>
        </form>
      </div>

      {/* ---- plan ---- */}
      <div className={PANEL}>
        <div className={`${TITLE} mb-3`}>Plan</div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-brand-sunken px-3 py-1 font-mono text-[12px] text-brand-ink2">
            {isAdmin ? "admin · unmetered" : PLAN_LABEL[data.plan] ?? data.plan}
          </span>
          {data.planExpiresAt && (
            <span className="text-[12.5px] text-brand-ink4">
              runs to {new Date(data.planExpiresAt).toLocaleDateString()}
            </span>
          )}
          <Link href="/settings/billing" className={`${PILL_QUIET} ml-auto`}>
            {data.hasSubscription ? "Manage billing" : "See plans"}
          </Link>
        </div>
        {!isAdmin && data.plan === "family" && (
          <Link
            href="/settings/family"
            className="mt-2.5 inline-block text-[12.5px] text-brand-accent hover:underline"
          >
            Family profiles and credit limits →
          </Link>
        )}
      </div>

      {/* ---- export link ---- */}
      {exportToken && (
        <div className={PANEL}>
          <div className={`${TITLE} mb-1`}>Export link</div>
          <p className="mb-2.5 text-[13px] leading-[1.55] text-brand-ink2">
            A private web address that returns your whole collection as data — for the{" "}
            {AI_NAME} deck builder, a spreadsheet, or anything else that can read a link.
            Anyone holding it can read your collection, so treat it like a password.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[11px] bg-brand-sunken px-3 py-2 font-mono text-[12px] text-brand-ink2">
              {tokenShown
                ? `${typeof window === "undefined" ? "" : window.location.origin}/api/export?token=${exportToken.token}`
                : "•".repeat(48)}
            </code>
            <button className={PILL_QUIET} onClick={() => setTokenShown((v) => !v)}>
              {tokenShown ? "Hide" : "Show"}
            </button>
            <button
              className={PILL}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/api/export?token=${exportToken.token}`
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setTokenShown(true);
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[12.5px] text-brand-ink4">
            <span>
              {/* The whole reason this is on screen: a date you don't recognise
                  is the only signal a member will ever get that the link got out. */}
              {exportToken.lastUsedAt
                ? `Last used ${new Date(exportToken.lastUsedAt).toLocaleString()}`
                : "Never used"}
            </span>
            <button
              className="ml-auto text-brand-accent hover:underline disabled:opacity-50"
              disabled={tokenBusy}
              onClick={rotateToken}
            >
              {tokenBusy ? "Replacing…" : "Replace link"}
            </button>
          </div>
        </div>
      )}

      {/* ---- delete ---- */}
      <div className="rounded-[18px] border border-brand-line bg-brand-sunken p-[22px]">
        <div className={`${TITLE} mb-1`}>Close this account</div>
        <p className="mb-2 text-[13px] leading-[1.55] text-brand-ink2">
          This deletes {data.counts.cards} card{data.counts.cards === 1 ? "" : "s"},{" "}
          {data.counts.decks} deck{data.counts.decks === 1 ? "" : "s"}, {data.counts.grades} saved
          grade{data.counts.grades === 1 ? "" : "s"}, your {AI_NAME} credits and history, your
          trades, battles and pals. It cannot be undone.
        </p>
        {/* Two things genuinely survive, so the panel says so rather than
            claiming a clean sweep it doesn't perform: card artwork you
            uploaded belongs to the shared card database, and scan-accuracy
            measurements are kept with the link to you removed. Both are
            `on delete set null`, not cascade. */}
        <p className="mb-3 text-[12px] leading-[1.5] text-brand-ink4">
          Two things stay, both detached from you: card pictures you uploaded remain in the shared
          card database, and anonymous scan-accuracy measurements are kept with your name removed.
          Neither can be traced back to this account afterwards.
        </p>

        {data.hasSubscription ? (
          <p className="m-0 text-[12.5px] leading-[1.55] text-brand-ink3">
            Cancel your subscription from{" "}
            <Link href="/settings/billing" className="font-medium text-brand-accent hover:underline">
              Billing
            </Link>{" "}
            first — deleting while it&apos;s live would leave Stripe billing an account that no
            longer exists.
          </p>
        ) : data.ownsFamilyWith > 1 ? (
          <p className="m-0 text-[12.5px] leading-[1.55] text-brand-ink3">
            Your family still has other profiles in it. Remove them in{" "}
            <Link href="/settings/family" className="font-medium text-brand-accent hover:underline">
              Family settings
            </Link>{" "}
            first, so nobody is left without a plan.
          </p>
        ) : !deleteOpen ? (
          <button
            className="whitespace-nowrap rounded-full border border-brand-negative bg-white px-4 py-2 text-[13px] font-medium text-brand-negative hover:bg-[#FDF0EE]"
            onClick={() => setDeleteOpen(true)}
          >
            Delete my account
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Said at the point of no return, not buried in a policy page.
                Someone with boost credits left should find this out here,
                while cancelling instead is still an option. */}
            <p className="m-0 text-[12.5px] leading-[1.55] text-brand-ink2">
              This also forfeits any credits left on the account, <b>including boost credits you
              paid for</b> — they aren&apos;t reimbursed. If you might come back, cancel your plan
              instead: cancelling keeps your boosts.
            </p>
            <label className="text-[12.5px] text-brand-ink2">
              Type <b className="font-mono">{data.email}</b> to confirm.
            </label>
            <input
              className={FIELD}
              autoComplete="off"
              placeholder={data.email}
              value={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="whitespace-nowrap rounded-full bg-brand-negative px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50"
                disabled={
                  busy || confirmDelete.trim().toLowerCase() !== data.email.trim().toLowerCase()
                }
                onClick={deleteAccount}
              >
                {busy ? "Deleting…" : "Delete for good"}
              </button>
              <button
                className={PILL_QUIET}
                onClick={() => {
                  setDeleteOpen(false);
                  setConfirmDelete("");
                }}
              >
                Keep my account
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
