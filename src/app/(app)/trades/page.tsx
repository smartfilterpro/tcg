"use client";

// The trade board, laid out to artboard 14: posts down the main column, a
// 320px rail carrying the safety note, the compose form and your own posts.
//
// Every behaviour the page had before survives — posting, attaching cards
// from search or your collection, replying, marking traded, reopening,
// deleting, showing closed posts. What changed is the shape: the compose
// form lives permanently in the rail instead of behind a toggle, and replies
// sit under their post rather than behind an accordion, which is what the
// mock shows and what makes a board feel like a conversation.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { APP_NAME } from "@/lib/branding";
import { artSrc } from "@/lib/art";
import { avatarColor, initialsFor } from "@/lib/avatar";
import { matchesSearch, shortAgo } from "@/lib/text";
import {
  itemPrice,
  variantLabel,
  type CardSummary,
  type CollectionItem,
} from "@/lib/types";

/** Said twice — in the rail on desktop, as a strip above the posts on
 *  mobile — so it lives in one place. */
const SAFETY_COPY =
  "Trades happen between members — we never hold cards or money and we don't sell " +
  "shipping. Check their history, post tracked, and report anything odd.";

interface PostCardRef {
  id: string;
  name: string;
  image: string | null;
  set_name: string | null;
  number: string | null;
  qty?: number;
}

interface TradePostComment {
  id: string;
  user_id: string;
  authorName: string;
  body: string;
  created_at: string;
}

interface TradePost {
  id: string;
  user_id: string;
  authorName: string;
  looking_for: string;
  offering: string;
  looking_for_cards: PostCardRef[];
  offering_cards: PostCardRef[];
  status: "open" | "closed";
  created_at: string;
  comments: TradePostComment[];
}

function Avatar({ seed, name, size }: { seed: string; name: string; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        background: avatarColor(seed),
        fontSize: size <= 24 ? 9.5 : 11,
      }}
      title={name}
    >
      {initialsFor(name)}
    </span>
  );
}

function TradeBoard() {
  const [posts, setPosts] = useState<TradePost[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [boardEnabled, setBoardEnabled] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  /** Admins may remove any post or reply — the moderation power section 6
   *  of the Terms promises. */
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookingFor, setLookingFor] = useState("");
  const [offering, setOffering] = useState("");
  const [lookingForCards, setLookingForCards] = useState<PostCardRef[]>([]);
  const [offeringCards, setOfferingCards] = useState<PostCardRef[]>([]);
  const [posting, setPosting] = useState(false);
  // Keyed by post: several reply boxes are on screen at once now, so a single
  // shared string would have you typing into all of them.
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [showClosed, setShowClosed] = useState(false);
  /** Card ids the viewer owns, for the "you own this" flag on want lists.
   *  Fetched only when the board actually asks for cards. */
  const [ownedCardIds, setOwnedCardIds] = useState<Set<string> | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market");
      const json = await res.json();
      if (res.ok) {
        setMigrated(json.migrated !== false);
        setBoardEnabled(json.boardEnabled !== false);
        setPosts(json.posts ?? []);
        if (json.myId) setMyId(json.myId);
        setIsAdmin(json.isAdmin === true);
      }
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Ownership lookup, deferred until we know somebody's asking for cards —
  // the collection is a big payload and most of the board doesn't need it.
  useEffect(() => {
    if (ownedCardIds !== null) return;
    if (!posts.some((p) => p.looking_for_cards.length > 0)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/collection");
        const json = await res.json();
        if (cancelled || !res.ok) return;
        setOwnedCardIds(
          new Set((json.items ?? []).map((it: CollectionItem) => it.card.id as string))
        );
      } catch {
        if (!cancelled) setOwnedCardIds(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [posts, ownedCardIds]);

  async function submitPost(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPosting(true);
    try {
      const res = await fetch("/api/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookingFor, offering, lookingForCards, offeringCards }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't post");
      setLookingFor("");
      setOffering("");
      setLookingForCards([]);
      setOfferingCards([]);
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't post");
    }
    setPosting(false);
  }

  async function setStatus(post: TradePost, status: "open" | "closed") {
    await fetch(`/api/market/${post.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  async function removePost(post: TradePost) {
    const mine = myId === post.user_id;
    if (!confirm(mine ? "Delete this post?" : `Remove ${post.authorName}'s post? (admin)`)) return;
    await fetch(`/api/market/${post.id}`, { method: "DELETE" });
    load();
  }

  async function removeComment(post: TradePost, commentId: string) {
    if (!confirm("Remove this reply?")) return;
    const res = await fetch(`/api/market/${post.id}/comments`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
    if (res.ok) {
      setPosts((ps) =>
        ps.map((p) =>
          p.id === post.id ? { ...p, comments: p.comments.filter((c) => c.id !== commentId) } : p
        )
      );
    } else {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Couldn't remove the reply");
    }
  }

  async function reply(post: TradePost) {
    const text = (replyText[post.id] ?? "").trim();
    if (!text || replying) return;
    setReplying(post.id);
    const res = await fetch(`/api/market/${post.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    if (res.ok) {
      setReplyText((r) => ({ ...r, [post.id]: "" }));
      await load();
    }
    setReplying(null);
  }

  if (!boardEnabled) return <BoardOff />;

  const visible = posts.filter((p) => showClosed || p.status === "open");
  const closedCount = posts.length - posts.filter((p) => p.status === "open").length;
  const myPosts = myId ? posts.filter((p) => p.user_id === myId) : [];

  return (
    <>
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-.025em]">Trade board</h1>
          <p className="mt-[3px] max-w-[70ch] text-sm leading-[1.6] text-brand-ink3">
            Post what you&apos;re offering and what you&apos;re after. Members reply in the
            comments, then you settle it card for card — {APP_NAME} never holds cards or money.
          </p>
        </div>
        <button
          className="shrink-0 whitespace-nowrap rounded-full bg-brand-ink px-5 py-[11px] text-sm font-medium text-brand-canvas hover:bg-brand-ink2"
          onClick={() => {
            composeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            composeRef.current?.focus();
          }}
        >
          Post a trade
        </button>
      </div>

      {!migrated && (
        <div className="mb-3 rounded-xl border border-brand-line bg-white p-3 text-sm text-brand-ink2">
          The trade board needs a one-time database update — ask the admin to run{" "}
          <code className="font-mono text-[12.5px]">supabase/migrations/009_trade_board.sql</code>.
        </div>
      )}

      {/* Mobile carries the short form of the safety note above the posts,
          per artboard 14b; desktop gets the full panel in the rail. */}
      <div className="mb-3 rounded-[14px] bg-brand-ink px-[15px] py-[13px] text-[12.5px] leading-[1.55] text-dark-ink2 lg:hidden">
        <b className="font-display text-brand-canvas">Member to member.</b> {SAFETY_COPY}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          {visible.length === 0 && migrated ? (
            <div className="rounded-[18px] border border-brand-line bg-white p-8 text-center">
              <p className="text-sm text-brand-ink3">
                No open posts yet. Write the first one in the compose box — say what you&apos;re
                after and what you can part with.
              </p>
            </div>
          ) : (
            visible.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                mine={myId === p.user_id}
                moderator={isAdmin}
                myId={myId}
                onDeleteComment={removeComment}
                ownedCardIds={ownedCardIds}
                replyValue={replyText[p.id] ?? ""}
                onReplyChange={(v) => setReplyText((r) => ({ ...r, [p.id]: v }))}
                onReply={() => reply(p)}
                replying={replying === p.id}
                expanded={!!expandedComments[p.id]}
                onToggleComments={() =>
                  setExpandedComments((e) => ({ ...e, [p.id]: !e[p.id] }))
                }
                onSetStatus={setStatus}
                onDelete={removePost}
              />
            ))
          )}

          {closedCount > 0 && (
            <button
              className="self-start text-xs text-brand-ink5 hover:underline"
              onClick={() => setShowClosed(!showClosed)}
            >
              {showClosed ? "Hide" : "Show"} {closedCount} closed post
              {closedCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        <aside className="flex flex-col gap-3">
          <div className="hidden rounded-[18px] bg-brand-ink p-5 text-brand-canvas lg:block">
            <span className="mb-3 inline-block rounded-full bg-brand-highlight px-[9px] py-[3px] font-mono text-[10px] font-medium tracking-[.08em] text-brand-ink">
              SAFETY
            </span>
            <p className="text-[13.5px] leading-[1.6] text-dark-ink2">{SAFETY_COPY}</p>
            <Link
              href="/support"
              className="mt-3 inline-block text-[13px] text-[#8FA9FF] hover:underline"
            >
              How trading works
            </Link>
          </div>

          <form
            onSubmit={submitPost}
            className="rounded-[18px] border border-brand-line bg-white p-5"
          >
            <div className="mb-3 font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink5">
              Post a trade
            </div>
            {error && (
              <div className="mb-2.5 rounded-lg bg-[#FDF0EE] p-2.5 text-[12.5px] text-brand-negative">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2.5">
              <div>
                <label className="mb-[5px] block text-[12.5px] font-medium text-brand-ink3">
                  🔍 I&apos;m looking for…
                </label>
                <textarea
                  ref={composeRef}
                  className="min-h-[56px] w-full rounded-[11px] border border-brand-line-strong px-[13px] py-2.5 text-[13px] leading-[1.5] outline-none placeholder:text-brand-ink5 focus:border-brand-accent"
                  rows={2}
                  required
                  maxLength={1000}
                  placeholder="Charizard ex from Obsidian Flames, or any Arven"
                  value={lookingFor}
                  onChange={(e) => setLookingFor(e.target.value)}
                />
                <AttachCards cards={lookingForCards} setCards={setLookingForCards} />
              </div>
              <div>
                <label className="mb-[5px] block text-[12.5px] font-medium text-brand-ink3">
                  🎁 I&apos;ll trade…
                </label>
                <textarea
                  className="min-h-[56px] w-full rounded-[11px] border border-brand-line-strong px-[13px] py-2.5 text-[13px] leading-[1.5] outline-none placeholder:text-brand-ink5 focus:border-brand-accent"
                  rows={2}
                  required
                  maxLength={1000}
                  placeholder="What you're offering"
                  value={offering}
                  onChange={(e) => setOffering(e.target.value)}
                />
                <AttachFromCollection cards={offeringCards} setCards={setOfferingCards} />
              </div>
              <button
                className="self-start whitespace-nowrap rounded-full bg-brand-ink px-4 py-[9px] text-[12.5px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-60"
                disabled={posting}
              >
                {posting ? "Posting…" : "Post it"}
              </button>
            </div>
          </form>

          {myPosts.length > 0 && (
            <div className="rounded-[18px] bg-brand-sunken p-5">
              <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink4">
                Your posts
              </div>
              <div className="flex flex-col gap-[9px]">
                {myPosts.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 text-[13px]">
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{ background: m.status === "open" ? "#1F7A43" : "#9A9A99" }}
                      title={m.status === "open" ? "Open" : "Closed"}
                    />
                    <span className="min-w-0 flex-1 truncate text-brand-ink2" title={m.offering}>
                      {m.offering}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-brand-ink4">
                      {m.comments.length}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** How many replies show before the rest fold away. Three is what the mock
 *  draws, and it keeps a busy post from burying the ones under it. */
const COMMENT_PREVIEW = 3;

function PostCard({
  post,
  mine,
  moderator,
  myId,
  ownedCardIds,
  replyValue,
  onReplyChange,
  onReply,
  replying,
  expanded,
  onToggleComments,
  onSetStatus,
  onDelete,
  onDeleteComment,
}: {
  post: TradePost;
  mine: boolean;
  /** True for admins: may remove any post or reply, per the Terms. */
  moderator: boolean;
  myId: string | null;
  ownedCardIds: Set<string> | null;
  replyValue: string;
  onReplyChange: (v: string) => void;
  onReply: () => void;
  replying: boolean;
  expanded: boolean;
  onToggleComments: () => void;
  onSetStatus: (p: TradePost, s: "open" | "closed") => void;
  onDelete: (p: TradePost) => void;
  onDeleteComment: (p: TradePost, commentId: string) => void;
}) {
  const shown = expanded ? post.comments : post.comments.slice(0, COMMENT_PREVIEW);
  const hidden = post.comments.length - shown.length;

  return (
    <article className="rounded-[18px] border border-brand-line bg-white p-5">
      <div className="mb-[14px] flex items-center gap-[11px]">
        <Avatar seed={post.user_id} name={post.authorName} size={30} />
        <span className="min-w-0 truncate text-sm font-medium">{post.authorName}</span>
        {mine && (
          <span className="shrink-0 rounded-[5px] bg-brand-accent-tint px-1.5 py-0.5 font-mono text-[10px] text-brand-accent">
            YOUR POST
          </span>
        )}
        <span
          className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10.5px] text-brand-ink5"
          title={new Date(post.created_at).toLocaleString()}
        >
          {shortAgo(post.created_at)}
        </span>
        {post.status === "closed" && (
          <span className="shrink-0 rounded-[5px] bg-brand-sunken px-1.5 py-0.5 font-mono text-[10px] text-brand-ink4">
            CLOSED
          </span>
        )}
      </div>

      <div className="grid gap-[14px] sm:grid-cols-2">
        <PostSide label="Offering" text={post.offering} cards={post.offering_cards} />
        <PostSide
          label="Looking for"
          text={post.looking_for}
          cards={post.looking_for_cards}
          want
          ownedCardIds={ownedCardIds}
        />
      </div>

      <div className="mt-[14px] border-t border-brand-line-soft pt-[14px]">
        {shown.length > 0 && (
          <div className="flex flex-col gap-2.5">
            {shown.map((c) => (
              <div key={c.id} className="flex items-start gap-2.5">
                <Avatar seed={c.user_id} name={c.authorName} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] leading-[1.55] text-brand-ink2">
                    <b className="font-medium">{c.authorName}</b>{" "}
                    <span className="whitespace-pre-wrap">{c.body}</span>
                  </div>
                  <div
                    className="mt-0.5 font-mono text-[10px] text-brand-ink5"
                    title={new Date(c.created_at).toLocaleString()}
                  >
                    {shortAgo(c.created_at)}
                  </div>
                </div>
                {(moderator || c.user_id === myId) && (
                  <button
                    className="shrink-0 rounded px-1 font-mono text-[11px] text-brand-ink5 hover:bg-[#FDF0EE] hover:text-brand-negative"
                    title={c.user_id === myId ? "Remove your reply" : "Remove this reply (admin)"}
                    onClick={() => onDeleteComment(post, c.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {(hidden > 0 || expanded) && post.comments.length > COMMENT_PREVIEW && (
          <button
            className="mt-2.5 text-[12px] font-medium text-brand-accent hover:underline"
            onClick={onToggleComments}
          >
            {expanded ? "Show fewer replies" : `Show all ${post.comments.length} replies`}
          </button>
        )}

        {post.status === "open" ? (
          <form
            className="mt-[14px] flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onReply();
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-full border border-brand-line-strong px-[15px] py-[9px] text-[13px] outline-none placeholder:text-brand-ink5 focus:border-brand-accent"
              placeholder={`Reply to ${post.authorName}…`}
              value={replyValue}
              maxLength={1000}
              onChange={(e) => onReplyChange(e.target.value)}
            />
            <button
              className="shrink-0 whitespace-nowrap rounded-full bg-brand-ink px-[18px] py-2.5 text-[13px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-60"
              disabled={replying || !replyValue.trim()}
            >
              {replying ? "Sending…" : "Send a request"}
            </button>
          </form>
        ) : (
          post.comments.length === 0 && (
            <p className="text-[12.5px] text-brand-ink5">
              This post is closed — replies are off.
            </p>
          )
        )}

        {(mine || moderator) && (
          <div className="mt-2.5 flex gap-1.5 text-xs">
            {mine && (
              <button
                className="rounded-full px-2.5 py-1 text-brand-ink4 hover:bg-brand-sunken"
                onClick={() => onSetStatus(post, post.status === "open" ? "closed" : "open")}
              >
                {post.status === "open" ? "Mark traded" : "Reopen"}
              </button>
            )}
            <button
              className="rounded-full px-2.5 py-1 text-brand-negative hover:bg-[#FDF0EE]"
              onClick={() => onDelete(post)}
            >
              {mine ? "Delete" : "Remove (admin)"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function PostSide({
  label,
  text,
  cards,
  want,
  ownedCardIds,
}: {
  label: string;
  text: string;
  cards: PostCardRef[];
  want?: boolean;
  ownedCardIds?: Set<string> | null;
}) {
  return (
    <div
      className={`rounded-[14px] p-[14px] ${want ? "bg-brand-accent-tint" : "bg-brand-panel-alt"}`}
    >
      <div
        className={`mb-2 font-mono text-[9.5px] uppercase tracking-[.08em] ${
          want ? "text-brand-accent" : "text-brand-ink4"
        }`}
      >
        {label}
      </div>
      <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55] text-brand-ink2">{text}</p>
      {cards.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {cards.map((c) => {
            const owned = want && ownedCardIds?.has(c.id);
            return (
              <div
                key={c.id}
                className="relative w-[38px]"
                title={`${(c.qty ?? 1) > 1 ? `${c.qty}x ` : ""}${c.name}${
                  c.number ? ` #${c.number}` : ""
                }${owned ? " — you own this" : ""}`}
              >
                <div className="aspect-[63/88] overflow-hidden rounded-[4px] bg-brand-line">
                  {c.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.image}
                      alt={c.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
                {(c.qty ?? 1) > 1 && (
                  <span className="absolute -right-[3px] -top-1 rounded-full bg-brand-ink px-[5px] py-px font-mono text-[8.5px] font-medium text-white">
                    {c.qty}
                  </span>
                )}
                {owned && (
                  <span className="absolute -bottom-[3px] -left-0.5 whitespace-nowrap rounded-[3px] bg-brand-accent px-1 py-px font-mono text-[8px] font-medium text-white">
                    you own
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Shown when a parent has switched the public board off for this profile.
 *  The one action offered is the one that exists: family and approved pals
 *  trade directly from the Friends page, which the board never gated. */
function BoardOff() {
  return (
    <div className="mx-auto max-w-[580px] py-6">
      <div className="rounded-[20px] border border-brand-line bg-white p-9 text-center">
        <div className="mx-auto mb-[18px] flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-sunken text-[22px]">
          🔒
        </div>
        <h2 className="font-display text-2xl font-bold tracking-[-.025em]">
          The public trade board is off
        </h2>
        <p className="mx-auto mt-2.5 text-[15px] leading-[1.6] text-brand-ink3">
          A parent turned this off for your profile. You can still trade with anyone in the
          family and with pals they&apos;ve approved — those don&apos;t need the board.
        </p>
        <Link
          href="/friends"
          className="mt-[22px] inline-block whitespace-nowrap rounded-full bg-brand-ink px-[22px] py-3 text-sm font-medium text-brand-canvas hover:bg-brand-ink2"
        >
          Trade inside the family
        </Link>
      </div>
      <div className="mt-4 rounded-[18px] bg-brand-sunken p-6">
        <div className="mb-1.5 font-display text-[16.5px] font-bold">What a parent controls</div>
        <p className="text-[13.5px] leading-[1.55] text-brand-ink2">
          A parent can switch the public board back on from Family settings, and can set how
          many {APP_NAME} credits each profile may spend in a cycle. Everything else — your
          collection, decks, values and battles — is yours and isn&apos;t affected by this.
        </p>
      </div>
    </div>
  );
}

function AttachFromCollection({
  cards,
  setCards,
}: {
  cards: PostCardRef[];
  setCards: (c: PostCardRef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [search, setSearch] = useState("");

  async function openPicker() {
    setOpen(true);
    if (items === null) {
      try {
        const res = await fetch("/api/collection");
        const json = await res.json();
        setItems(res.ok ? (json.items ?? []) : []);
      } catch {
        setItems([]);
      }
    }
  }

  function refFor(it: CollectionItem): PostCardRef {
    const finish = it.variant && it.variant !== "normal" ? ` (${variantLabel(it.variant)})` : "";
    return {
      id: it.id, // collection item id — distinguishes finishes of the same card
      name: `${it.card.name}${finish}`,
      image: artSrc(it.card.id, it.card.image_small),
      set_name: it.card.set_name,
      number: it.card.number,
      qty: 1,
    };
  }

  function addOne(it: CollectionItem) {
    const existing = cards.find((c) => c.id === it.id);
    if (existing) {
      if ((existing.qty ?? 1) >= it.quantity) return; // can't offer more than you own
      setCards(cards.map((c) => (c.id === it.id ? { ...c, qty: (c.qty ?? 1) + 1 } : c)));
    } else {
      if (cards.length >= 10) return;
      setCards([...cards, refFor(it)]);
    }
  }

  function removeOne(id: string) {
    const existing = cards.find((c) => c.id === id);
    if (!existing) return;
    if ((existing.qty ?? 1) > 1) {
      setCards(cards.map((c) => (c.id === id ? { ...c, qty: (c.qty ?? 1) - 1 } : c)));
    } else {
      setCards(cards.filter((c) => c.id !== id));
    }
  }

  const q = search.trim();
  const filtered = (items ?? [])
    .filter((it) => matchesSearch(q, it.card.name, it.card.set_name, it.card.number))
    .slice(0, 60);

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {cards.map((c) => (
          <div key={c.id} className="relative w-10" title={`${c.qty ?? 1}x ${c.name}`}>
            <div className="aspect-[63/88] overflow-hidden rounded bg-brand-line">
              {c.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt={c.name} className="h-full w-full object-cover" />
              )}
            </div>
            {(c.qty ?? 1) > 1 && (
              <span className="absolute -left-1 -top-1 rounded-full bg-brand-ink px-1 font-mono text-[9px] font-medium text-white">
                {c.qty}
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove one ${c.name}`}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand-ink2 text-[10px] text-white"
              onClick={() => removeOne(c.id)}
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-3.5 py-2 text-[12.5px] font-medium hover:bg-brand-sunken"
          onClick={() => (open ? setOpen(false) : openPicker())}
        >
          {open ? "Done" : "+ Attach cards"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          {items === null ? (
            <p className="text-xs text-brand-ink5">Loading your collection…</p>
          ) : (
            <>
              <input
                className="w-full rounded-[11px] border border-brand-line-strong px-3 py-2 text-[13px] outline-none focus:border-brand-accent"
                placeholder="Search your cards…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ul className="mt-1 max-h-48 divide-y divide-brand-line-soft overflow-y-auto rounded-[11px] border border-brand-line bg-white">
                {filtered.map((it) => {
                  const picked = cards.find((c) => c.id === it.id)?.qty ?? 0;
                  const value = itemPrice(it);
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 p-1.5 text-left hover:bg-brand-panel-alt disabled:opacity-50"
                        disabled={picked >= it.quantity}
                        onClick={() => addOne(it)}
                      >
                        <div className="h-9 w-6 shrink-0 overflow-hidden rounded bg-brand-sunken">
                          {it.card.image_small && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={it.card.image_small}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {it.card.name}
                            {it.variant !== "normal" && (
                              <span className="text-brand-ink5"> · {variantLabel(it.variant)}</span>
                            )}
                          </div>
                          <div className="text-[11px] text-brand-ink5">
                            #{it.card.number} · you own x{it.quantity}
                            {value != null ? ` · ~$${value.toFixed(2)}` : ""}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                            picked > 0
                              ? "bg-[#E8F3EC] text-brand-positive"
                              : "bg-brand-sunken text-brand-ink3"
                          }`}
                        >
                          {picked > 0 ? `${picked} added` : "+ Add"}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="p-2 text-xs text-brand-ink5">
                    {items.length === 0 ? "Your collection is empty." : "No cards match."}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AttachCards({
  cards,
  setCards,
}: {
  cards: PostCardRef[];
  setCards: (c: PostCardRef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CardSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onQuery(q: string) {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q.trim())}`);
        const json = await res.json();
        if (res.ok) setResults((json.cards ?? []).slice(0, 8));
      } catch {}
      setSearching(false);
    }, 400);
  }

  function add(c: CardSummary) {
    if (cards.some((x) => x.id === c.id) || cards.length >= 10) return;
    setCards([
      ...cards,
      { id: c.id, name: c.name, image: c.imageSmall, set_name: c.setName, number: c.number },
    ]);
  }

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {cards.map((c) => (
          <div key={c.id} className="relative w-10" title={c.name}>
            <div className="aspect-[63/88] overflow-hidden rounded bg-brand-line">
              {c.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt={c.name} className="h-full w-full object-cover" />
              )}
            </div>
            <button
              type="button"
              aria-label={`Remove ${c.name}`}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand-ink2 text-[10px] text-white"
              onClick={() => setCards(cards.filter((x) => x.id !== c.id))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-3.5 py-2 text-[12.5px] font-medium hover:bg-brand-sunken"
          onClick={() => setOpen(!open)}
        >
          {open ? "Done" : "+ Attach cards"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          <input
            className="w-full rounded-[11px] border border-brand-line-strong px-3 py-2 text-[13px] outline-none focus:border-brand-accent"
            placeholder="Search a card, e.g. charizard 199/165"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {searching && <p className="mt-1 text-xs text-brand-ink5">Searching…</p>}
          {results.length > 0 && (
            <ul className="mt-1 max-h-48 divide-y divide-brand-line-soft overflow-y-auto rounded-[11px] border border-brand-line bg-white">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 p-1.5 text-left hover:bg-brand-panel-alt"
                    onClick={() => add(c)}
                  >
                    <div className="h-9 w-6 shrink-0 overflow-hidden rounded bg-brand-sunken">
                      {c.imageSmall && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageSmall} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{c.name}</div>
                      <div className="text-[11px] text-brand-ink5">
                        {c.setName} · #{c.number}
                      </div>
                    </div>
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

export default function TradesPage() {
  return <TradeBoard />;
}
