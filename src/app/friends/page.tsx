"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  itemPrice,
  variantLabel,
  type CollectionItem,
  type Deck,
  type DeckCardEntry,
} from "@/lib/types";
import { AI_NAME } from "@/lib/branding";

interface Friend {
  id: string;
  name: string;
  cardCount: number;
}

interface SharedDeck extends Deck {
  ownerName: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** key = collection item id */
type TradeSide = Record<string, number>;

function itemLabel(it: CollectionItem): string {
  const finish = it.variant && it.variant !== "normal" ? ` [${variantLabel(it.variant)}]` : "";
  return `${it.card.name} #${it.card.number} (${it.card.set_name})${finish}`;
}

function sideTotal(side: TradeSide, items: CollectionItem[]): number {
  return items.reduce((sum, it) => {
    const qty = side[it.id] ?? 0;
    return sum + qty * (itemPrice(it) ?? 0);
  }, 0);
}

export default function FriendsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [sharedDecks, setSharedDecks] = useState<SharedDeck[]>([]);
  const [viewingDeck, setViewingDeck] = useState<SharedDeck | null>(null);

  // Trade state
  const [friend, setFriend] = useState<Friend | null>(null);
  const [theirItems, setTheirItems] = useState<CollectionItem[]>([]);
  const [myItems, setMyItems] = useState<CollectionItem[]>([]);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [give, setGive] = useState<TradeSide>({});
  const [get, setGet] = useState<TradeSide>({});
  const [mySearch, setMySearch] = useState("");
  const [theirSearch, setTheirSearch] = useState("");

  // Chat state
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await fetch("/api/friends");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setMigrated(json.migrated);
      setSharing(json.sharing);
      setFriends(json.friends ?? []);
      setSharedDecks(json.sharedDecks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, chatBusy]);

  async function toggleSharing() {
    setError(null);
    const next = !sharing;
    const res = await fetch("/api/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ share: next }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setSharing(next);
  }

  async function openTrade(f: Friend) {
    setFriend(f);
    setGive({});
    setGet({});
    setChat([]);
    setTradeLoading(true);
    setError(null);
    try {
      const [theirsRes, mineRes] = await Promise.all([
        fetch(`/api/friends/${f.id}/collection`),
        fetch("/api/collection"),
      ]);
      const theirs = await theirsRes.json();
      const mine = await mineRes.json();
      if (!theirsRes.ok) throw new Error(theirs.error || "Couldn't load their collection");
      if (!mineRes.ok) throw new Error(mine.error || "Couldn't load your collection");
      setTheirItems(theirs.items ?? []);
      setMyItems(mine.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load collections");
      setFriend(null);
    }
    setTradeLoading(false);
  }

  function adjust(side: "give" | "get", item: CollectionItem, delta: number) {
    const setter = side === "give" ? setGive : setGet;
    setter((prev) => {
      const current = prev[item.id] ?? 0;
      const next = Math.max(0, Math.min(item.quantity, current + delta));
      const copy = { ...prev };
      if (next === 0) delete copy[item.id];
      else copy[item.id] = next;
      return copy;
    });
  }

  function tradeLines(side: TradeSide, items: CollectionItem[]) {
    return items
      .filter((it) => (side[it.id] ?? 0) > 0)
      .map((it) => ({ label: itemLabel(it), qty: side[it.id], value: itemPrice(it) }));
  }

  async function sendChat(text: string) {
    if (!friend || !text.trim() || chatBusy) return;
    const nextChat: ChatMsg[] = [...chat, { role: "user", content: text.trim() }];
    setChat(nextChat);
    setChatInput("");
    setChatBusy(true);
    try {
      const res = await fetch("/api/trade/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          friendId: friend.id,
          messages: nextChat.slice(-20),
          trade: { mine: tradeLines(give, myItems), theirs: tradeLines(get, theirItems) },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Chat failed");
      setChat([...nextChat, { role: "assistant", content: json.answer }]);
    } catch (e) {
      setChat([
        ...nextChat,
        {
          role: "assistant",
          content: `Sorry — that didn't go through (${e instanceof Error ? e.message : "error"}). Try again!`,
        },
      ]);
    }
    setChatBusy(false);
  }

  const giveTotal = useMemo(() => sideTotal(give, myItems), [give, myItems]);
  const getTotal = useMemo(() => sideTotal(get, theirItems), [get, theirItems]);

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Friends</h1>
        <p className="text-sm text-slate-500">
          Share collections, browse each other&apos;s decks, and work out trades with {AI_NAME}.
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {!migrated && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          Sharing needs a one-time database update — ask the admin to run{" "}
          <code>supabase/migrations/008_sharing.sql</code> in the Supabase SQL editor.
        </div>
      )}

      <div className="card-panel flex items-center justify-between gap-3 p-4">
        <div>
          <h2 className="font-semibold">Share my collection</h2>
          <p className="text-xs text-slate-500">
            Lets other members see your cards and propose trades. You can turn this off any
            time.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={sharing}
          onClick={toggleSharing}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
            sharing ? "bg-green-500" : "bg-slate-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
              sharing ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {!friend && (
        <>
          <div className="card-panel p-4">
            <h2 className="mb-2 font-semibold">Trading partners ({friends.length})</h2>
            {friends.length === 0 ? (
              <p className="text-sm text-slate-400">
                No one else is sharing their collection yet. Once a friend flips their toggle,
                they&apos;ll show up here.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {friends.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <div className="text-sm font-medium">{f.name}</div>
                      <div className="text-xs text-slate-400">
                        {f.cardCount} card{f.cardCount === 1 ? "" : "s"} shared
                      </div>
                    </div>
                    <button className="btn-primary px-3 py-1.5 text-sm" onClick={() => openTrade(f)}>
                      Browse &amp; trade
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card-panel p-4">
            <h2 className="mb-2 font-semibold">Friends&apos; decks ({sharedDecks.length})</h2>
            <p className="mb-2 text-xs text-slate-500">
              Decks members chose to share. Share yours from the Decks page (open a deck →
              Share).
            </p>
            {sharedDecks.length === 0 ? (
              <p className="text-sm text-slate-400">No shared decks yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {sharedDecks.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <div className="text-sm font-medium">{d.name}</div>
                      <div className="text-xs text-slate-400">
                        by {d.ownerName} ·{" "}
                        {(d.cards ?? []).reduce((s, c) => s + c.quantity, 0)} cards
                      </div>
                    </div>
                    <button
                      className="btn-secondary px-3 py-1.5 text-sm"
                      onClick={() => setViewingDeck(d)}
                    >
                      View
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {friend && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Trade with {friend.name}</h2>
            <button className="btn-secondary px-3 py-1.5 text-sm" onClick={() => setFriend(null)}>
              ← Back
            </button>
          </div>

          {tradeLoading ? (
            <p className="text-slate-500">Loading collections…</p>
          ) : (
            <>
              {/* Trade summary */}
              <div className="card-panel p-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="mb-1 font-semibold">
                      You give <span className="text-slate-400">~${giveTotal.toFixed(2)}</span>
                    </div>
                    <TradePickList
                      items={myItems.filter((it) => (give[it.id] ?? 0) > 0)}
                      side={give}
                      onRemove={(it) => adjust("give", it, -1)}
                    />
                  </div>
                  <div>
                    <div className="mb-1 font-semibold">
                      You get <span className="text-slate-400">~${getTotal.toFixed(2)}</span>
                    </div>
                    <TradePickList
                      items={theirItems.filter((it) => (get[it.id] ?? 0) > 0)}
                      side={get}
                      onRemove={(it) => adjust("get", it, -1)}
                    />
                  </div>
                </div>
                {(giveTotal > 0 || getTotal > 0) && (
                  <p className="mt-2 text-xs text-slate-500">
                    Difference: ~${Math.abs(giveTotal - getTotal).toFixed(2)}{" "}
                    {giveTotal === getTotal
                      ? "— even!"
                      : giveTotal > getTotal
                        ? "in their favor"
                        : "in your favor"}
                  </p>
                )}
              </div>

              {/* Pickers */}
              <div className="grid gap-4 sm:grid-cols-2">
                <CardPicker
                  title="Your cards"
                  items={myItems}
                  side={give}
                  search={mySearch}
                  setSearch={setMySearch}
                  onAdd={(it) => adjust("give", it, 1)}
                />
                <CardPicker
                  title={`${friend.name}'s cards`}
                  items={theirItems}
                  side={get}
                  search={theirSearch}
                  setSearch={setTheirSearch}
                  onAdd={(it) => adjust("get", it, 1)}
                />
              </div>

              {/* Trainer AI chat */}
              <div className="card-panel p-4">
                <h3 className="mb-1 font-semibold">🤖 Ask {AI_NAME}</h3>
                <p className="mb-2 text-xs text-slate-500">
                  {AI_NAME} can see both collections and the trade above — ask whether
                  it&apos;s fair, or for ideas.
                </p>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    className="chip bg-poke-blue/10 text-poke-blue hover:bg-poke-blue/20"
                    disabled={chatBusy}
                    onClick={() =>
                      sendChat(
                        "Suggest 2-3 fair trades between us. Prefer duplicates, and explain the value on both sides."
                      )
                    }
                  >
                    💡 Suggest fair trades
                  </button>
                  <button
                    className="chip bg-poke-blue/10 text-poke-blue hover:bg-poke-blue/20"
                    disabled={chatBusy || (giveTotal === 0 && getTotal === 0)}
                    onClick={() => sendChat("Is the currently proposed trade fair? Why or why not?")}
                  >
                    ⚖️ Is this trade fair?
                  </button>
                </div>
                {chat.length > 0 && (
                  <div className="mb-2 max-h-80 space-y-2 overflow-y-auto rounded-lg bg-slate-50 p-3">
                    {chat.map((m, i) => (
                      <div
                        key={i}
                        className={`whitespace-pre-wrap rounded-lg p-2 text-sm ${
                          m.role === "user"
                            ? "ml-6 bg-poke-blue/10 text-slate-800"
                            : "mr-6 bg-white shadow-sm"
                        }`}
                      >
                        {m.content}
                      </div>
                    ))}
                    {chatBusy && (
                      <div className="mr-6 rounded-lg bg-white p-2 text-sm text-slate-400 shadow-sm">
                        {AI_NAME} is thinking…
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendChat(chatInput);
                  }}
                >
                  <input
                    className="input"
                    placeholder="e.g. Would my extra Charizard for their Pikachu be fair?"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={chatBusy}
                  />
                  <button className="btn-primary shrink-0" disabled={chatBusy || !chatInput.trim()}>
                    Ask
                  </button>
                </form>
                <p className="mt-2 text-[11px] text-slate-400">
                  Values are market estimates — agree on the final trade in person. Nothing is
                  moved automatically.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Shared deck viewer */}
      {viewingDeck && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setViewingDeck(null)}
        >
          <div
            className="card-panel max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-xl font-bold">{viewingDeck.name}</h2>
                <p className="text-xs text-slate-400">shared by {viewingDeck.ownerName}</p>
              </div>
              <button
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
                onClick={() => setViewingDeck(null)}
              >
                ✕
              </button>
            </div>
            {viewingDeck.strategy && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                {viewingDeck.strategy}
              </p>
            )}
            <SharedDeckList cards={viewingDeck.cards ?? []} />
          </div>
        </div>
      )}
    </div>
  );
}

function TradePickList({
  items,
  side,
  onRemove,
}: {
  items: CollectionItem[];
  side: Record<string, number>;
  onRemove: (it: CollectionItem) => void;
}) {
  if (items.length === 0) return <p className="text-xs text-slate-400">Tap cards below to add.</p>;
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it.id} className="flex items-center gap-1.5 text-xs">
          <button
            aria-label="Remove one"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 hover:bg-red-100"
            onClick={() => onRemove(it)}
          >
            −
          </button>
          <span className="truncate">
            {side[it.id]}x {it.card.name} #{it.card.number}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CardPicker({
  title,
  items,
  side,
  search,
  setSearch,
  onAdd,
}: {
  title: string;
  items: CollectionItem[];
  side: Record<string, number>;
  search: string;
  setSearch: (s: string) => void;
  onAdd: (it: CollectionItem) => void;
}) {
  const q = search.trim().toLowerCase();
  const filtered = items
    .filter(
      (it) =>
        !q ||
        it.card.name.toLowerCase().includes(q) ||
        it.card.set_name.toLowerCase().includes(q) ||
        it.card.number.toLowerCase().includes(q)
    )
    .slice(0, 60);
  return (
    <div className="card-panel p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <input
        className="input mb-2 text-sm"
        placeholder="Search…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
        {filtered.map((it) => {
          const picked = side[it.id] ?? 0;
          const value = itemPrice(it);
          return (
            <li key={it.id} className="flex items-center gap-2 py-1.5">
              <div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-slate-100">
                {it.card.image_small && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.card.image_small}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">
                  {it.card.name}{" "}
                  {it.variant !== "normal" && (
                    <span className="text-slate-400">· {variantLabel(it.variant)}</span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400">
                  #{it.card.number} · x{it.quantity}
                  {value != null ? ` · ~$${value.toFixed(2)}` : ""}
                </div>
              </div>
              <button
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  picked > 0
                    ? "bg-green-100 text-green-700"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
                disabled={picked >= it.quantity}
                onClick={() => onAdd(it)}
              >
                {picked > 0 ? `${picked} added` : "+ Add"}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="py-2 text-xs text-slate-400">No cards match.</li>
        )}
      </ul>
    </div>
  );
}

function SharedDeckList({ cards }: { cards: DeckCardEntry[] }) {
  const groups: Record<"pokemon" | "trainer" | "energy", DeckCardEntry[]> = {
    pokemon: [],
    trainer: [],
    energy: [],
  };
  for (const c of cards) (groups[c.category] ?? groups.trainer).push(c);
  return (
    <div className="mt-3 space-y-3">
      {(["pokemon", "trainer", "energy"] as const).map(
        (cat) =>
          groups[cat].length > 0 && (
            <div key={cat}>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">
                {cat} ({groups[cat].reduce((s, c) => s + c.quantity, 0)})
              </h4>
              <ul className="space-y-0.5 text-sm">
                {groups[cat].map((c, i) => (
                  <li key={i}>
                    {c.quantity}x {c.name}
                  </li>
                ))}
              </ul>
            </div>
          )
      )}
    </div>
  );
}
