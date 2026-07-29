"use client";

// The trade board on its own route. Moved verbatim from the Friends page —
// posts, comments, attach-cards and open/close behave exactly as before;
// only the address and the page header are new. Friends keeps pals,
// sharing and direct trade offers.

import { useEffect, useRef, useState } from "react";
import { APP_NAME } from "@/lib/branding";
import { matchesSearch } from "@/lib/text";
import {
  itemPrice,
  variantLabel,
  type CardSummary,
  type CollectionItem,
} from "@/lib/types";

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

function TradeBoard() {
  const [posts, setPosts] = useState<TradePost[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [lookingFor, setLookingFor] = useState("");
  const [offering, setOffering] = useState("");
  const [lookingForCards, setLookingForCards] = useState<PostCardRef[]>([]);
  const [offeringCards, setOfferingCards] = useState<PostCardRef[]>([]);
  const [posting, setPosting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/market");
      const json = await res.json();
      if (res.ok) {
        setMigrated(json.migrated !== false);
        setPosts(json.posts ?? []);
        if (json.myId) setMyId(json.myId);
      }
    } catch {}
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setComposing(false);
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
    if (!confirm("Delete this post?")) return;
    await fetch(`/api/market/${post.id}`, { method: "DELETE" });
    load();
  }

  async function reply(post: TradePost) {
    if (!replyText.trim() || replying) return;
    setReplying(true);
    const res = await fetch(`/api/market/${post.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: replyText }),
    });
    if (res.ok) {
      setReplyText("");
      await load();
    }
    setReplying(false);
  }

  const visible = posts.filter((p) => showClosed || p.status === "open");
  const closedCount = posts.length - posts.filter((p) => p.status === "open").length;

  return (
    <div className="card-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">📣 Trade board</h2>
        {!composing && (
          <button className="btn-primary px-3 py-1.5 text-sm" onClick={() => setComposing(true)}>
            + New post
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Post what you&apos;re looking for and what you&apos;ll trade for it — friends reply
        right on the post.
      </p>

      {!migrated && (
        <div className="mt-2 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          The trade board needs a one-time database update — ask the admin to run{" "}
          <code>supabase/migrations/009_trade_board.sql</code>.
        </div>
      )}
      {error && <div className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {composing && (
        <form onSubmit={submitPost} className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              🔍 I&apos;m looking for…
            </label>
            <textarea
              className="input"
              rows={2}
              required
              maxLength={1000}
              placeholder="e.g. Charizard ex 199/165 (Obsidian Flames), or any Eeveelution SIRs"
              value={lookingFor}
              onChange={(e) => setLookingFor(e.target.value)}
            />
            <AttachCards cards={lookingForCards} setCards={setLookingForCards} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              🤝 I&apos;m willing to trade…
            </label>
            <textarea
              className="input"
              rows={2}
              required
              maxLength={1000}
              placeholder="e.g. My extra Pikachu with Grey Felt Hat, plus a few reverse holos"
              value={offering}
              onChange={(e) => setOffering(e.target.value)}
            />
            <AttachFromCollection cards={offeringCards} setCards={setOfferingCards} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={posting}>
              {posting ? "Posting…" : "Post to board"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {visible.length === 0 && migrated ? (
        <p className="mt-3 text-sm text-slate-400">
          No open posts. Be the first — tap &ldquo;New post&rdquo;!
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {visible.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs text-slate-400">
                  <span className="font-semibold text-slate-600">{p.authorName}</span> ·{" "}
                  {new Date(p.created_at).toLocaleDateString()}
                  {p.status === "closed" && (
                    <span className="ml-2 chip bg-slate-200 text-slate-600">Closed</span>
                  )}
                </div>
                {myId === p.user_id && (
                  <div className="flex shrink-0 gap-1 text-xs">
                    <button
                      className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100"
                      onClick={() => setStatus(p, p.status === "open" ? "closed" : "open")}
                    >
                      {p.status === "open" ? "Mark traded" : "Reopen"}
                    </button>
                    <button
                      className="rounded px-2 py-0.5 text-red-600 hover:bg-red-50"
                      onClick={() => removePost(p)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <PostSide label="🔍 Looking for" text={p.looking_for} cards={p.looking_for_cards} />
                <PostSide label="🤝 Offering" text={p.offering} cards={p.offering_cards} />
              </div>
              <button
                className="mt-2 text-xs font-medium text-poke-blue hover:underline"
                onClick={() => {
                  setExpanded(expanded === p.id ? null : p.id);
                  setReplyText("");
                }}
              >
                💬 {p.comments.length} repl{p.comments.length === 1 ? "y" : "ies"}
                {expanded === p.id ? " ▲" : " ▼"}
              </button>
              {expanded === p.id && (
                <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
                  {p.comments.map((c) => (
                    <div key={c.id} className="text-sm">
                      <span className="font-semibold">{c.authorName}</span>{" "}
                      <span className="text-xs text-slate-400">
                        {new Date(c.created_at).toLocaleDateString()}
                      </span>
                      <p className="whitespace-pre-wrap text-slate-700">{c.body}</p>
                    </div>
                  ))}
                  {p.status === "open" && (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        reply(p);
                      }}
                    >
                      <input
                        className="input text-sm"
                        placeholder="I've got one! / Would you take…?"
                        value={replyText}
                        maxLength={1000}
                        onChange={(e) => setReplyText(e.target.value)}
                      />
                      <button className="btn-secondary shrink-0 text-sm" disabled={replying}>
                        Reply
                      </button>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {closedCount > 0 && (
        <button
          className="mt-2 text-xs text-slate-400 hover:underline"
          onClick={() => setShowClosed(!showClosed)}
        >
          {showClosed ? "Hide" : "Show"} {closedCount} closed post{closedCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

function PostSide({
  label,
  text,
  cards,
}: {
  label: string;
  text: string;
  cards: PostCardRef[];
}) {
  return (
    <div className="rounded bg-slate-50 p-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{text}</p>
      {cards.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {cards.map((c) => (
            <div
              key={c.id}
              className="relative w-12"
              title={`${(c.qty ?? 1) > 1 ? `${c.qty}x ` : ""}${c.name} #${c.number ?? ""}`}
            >
              <div className="overflow-hidden rounded aspect-[63/88] bg-slate-200">
                {c.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.image} alt={c.name} className="h-full w-full object-cover" loading="lazy" />
                )}
              </div>
              {(c.qty ?? 1) > 1 && (
                <span className="absolute -right-1 -top-1 rounded-full bg-poke-dark px-1 text-[10px] font-bold text-white">
                  x{c.qty}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
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
      image: it.card.image_small,
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
            <div className="overflow-hidden rounded aspect-[63/88] bg-slate-200">
              {c.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt={c.name} className="h-full w-full object-cover" />
              )}
            </div>
            {(c.qty ?? 1) > 1 && (
              <span className="absolute -left-1 -top-1 rounded-full bg-poke-dark px-1 text-[10px] font-bold text-white">
                x{c.qty}
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove one ${c.name}`}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-[10px] text-white"
              onClick={() => removeOne(c.id)}
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          className="chip bg-slate-200 text-slate-600 hover:bg-slate-300"
          onClick={() => (open ? setOpen(false) : openPicker())}
        >
          {open ? "Done" : "🗂 Pick from my collection"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          {items === null ? (
            <p className="text-xs text-slate-400">Loading your collection…</p>
          ) : (
            <>
              <input
                className="input text-sm"
                placeholder="Search your cards…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ul className="mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 bg-white">
                {filtered.map((it) => {
                  const picked = cards.find((c) => c.id === it.id)?.qty ?? 0;
                  const value = itemPrice(it);
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 p-1.5 text-left hover:bg-slate-50 disabled:opacity-50"
                        disabled={picked >= it.quantity}
                        onClick={() => addOne(it)}
                      >
                        <div className="h-9 w-6 shrink-0 overflow-hidden rounded bg-slate-100">
                          {it.card.image_small && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={it.card.image_small} alt="" className="h-full w-full object-cover" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {it.card.name}
                            {it.variant !== "normal" && (
                              <span className="text-slate-400"> · {variantLabel(it.variant)}</span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            #{it.card.number} · you own x{it.quantity}
                            {value != null ? ` · ~$${value.toFixed(2)}` : ""}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                            picked > 0
                              ? "bg-green-100 text-green-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {picked > 0 ? `${picked} added` : "+ Add"}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="p-2 text-xs text-slate-400">
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
            <div className="overflow-hidden rounded aspect-[63/88] bg-slate-200">
              {c.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt={c.name} className="h-full w-full object-cover" />
              )}
            </div>
            <button
              type="button"
              aria-label={`Remove ${c.name}`}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-[10px] text-white"
              onClick={() => setCards(cards.filter((x) => x.id !== c.id))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="chip bg-slate-200 text-slate-600 hover:bg-slate-300"
          onClick={() => setOpen(!open)}
        >
          {open ? "Done" : "🖼 Attach card pictures"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          <input
            className="input text-sm"
            placeholder="Search a card, e.g. charizard 199/165"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {searching && <p className="mt-1 text-xs text-slate-400">Searching…</p>}
          {results.length > 0 && (
            <ul className="mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 bg-white">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 p-1.5 text-left hover:bg-slate-50"
                    onClick={() => add(c)}
                  >
                    <div className="h-9 w-6 shrink-0 overflow-hidden rounded bg-slate-100">
                      {c.imageSmall && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageSmall} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{c.name}</div>
                      <div className="text-[11px] text-slate-400">
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
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-[26px] font-bold tracking-[-.025em]">Trade board</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Post what you&apos;re hunting and what you can part with — trades happen member to
          member, and {APP_NAME} never holds cards or money.
        </p>
      </div>
      <TradeBoard />
    </div>
  );
}
