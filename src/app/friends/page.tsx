"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  itemPrice,
  variantLabel,
  type CardSummary,
  type CollectionItem,
  type Deck,
  type DeckCardEntry,
} from "@/lib/types";
import { AI_NAME } from "@/lib/branding";
import { matchesSearch } from "@/lib/text";

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

interface OfferLine {
  label: string;
  qty: number;
  value: number | null;
}

interface TradeOffer {
  id: string;
  direction: "incoming" | "outgoing";
  otherName: string;
  give: OfferLine[];
  get: OfferLine[];
  message: string | null;
  status: "pending" | "accepted" | "declined" | "withdrawn";
  created_at: string;
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
  const [myName, setMyName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
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

  // Trade requests
  const [offers, setOffers] = useState<TradeOffer[]>([]);
  const [tradeMessage, setTradeMessage] = useState("");
  const [sendingOffer, setSendingOffer] = useState(false);
  const [offerNotice, setOfferNotice] = useState<string | null>(null);

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
      setMyName(json.myName ?? "");
      setNameDraft(json.myName ?? "");
      setFriends(json.friends ?? []);
      setSharedDecks(json.sharedDecks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  async function loadOffers() {
    try {
      const res = await fetch("/api/trade/offers");
      const json = await res.json();
      if (res.ok) setOffers(json.offers ?? []);
    } catch {}
  }

  useEffect(() => {
    load();
    loadOffers();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, chatBusy]);

  async function sendTradeRequest() {
    if (!friend || sendingOffer) return;
    setSendingOffer(true);
    setOfferNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/trade/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toUserId: friend.id,
          give: tradeLines(give, myItems),
          get: tradeLines(get, theirItems),
          message: tradeMessage,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't send the trade request");
      setOfferNotice(
        `Trade request sent to ${friend.name}! They'll see it on their Friends page.`
      );
      setGive({});
      setGet({});
      setTradeMessage("");
      loadOffers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the trade request");
    }
    setSendingOffer(false);
  }

  async function respondToOffer(offer: TradeOffer, status: "accepted" | "declined" | "withdrawn") {
    const res = await fetch(`/api/trade/offers/${offer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    loadOffers();
  }

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

      <div className="card-panel p-4">
        <h2 className="font-semibold">Your username</h2>
        <p className="mb-2 text-xs text-slate-500">
          This is what other members see instead of your email — on shared collections,
          decks, trades, and the trade board.
        </p>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setNameSaved(false);
            const res = await fetch("/api/account", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ displayName: nameDraft }),
            });
            const json = await res.json();
            if (!res.ok) setError(json.error);
            else {
              setMyName(json.displayName);
              setNameSaved(true);
            }
          }}
        >
          <input
            className="input"
            maxLength={30}
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setNameSaved(false);
            }}
            placeholder="e.g. AshK"
          />
          <button
            className="btn-secondary shrink-0"
            disabled={!nameDraft.trim() || nameDraft.trim() === myName}
          >
            {nameSaved ? "✓ Saved" : "Save"}
          </button>
        </form>
      </div>

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
          {offers.length > 0 && (
            <div className="card-panel p-4">
              <h2 className="mb-2 font-semibold">
                📨 Trade requests (
                {offers.filter((o) => o.status === "pending").length} pending)
              </h2>
              <ul className="divide-y divide-slate-100">
                {offers
                  .filter((o, i) => o.status === "pending" || i < 8)
                  .map((o) => (
                    <li key={o.id} className="py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm">
                          <span className="font-semibold">
                            {o.direction === "incoming" ? o.otherName : `To ${o.otherName}`}
                          </span>{" "}
                          <span className="text-xs text-slate-400">
                            {new Date(o.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <span
                          className={`chip shrink-0 ${
                            o.status === "pending"
                              ? "bg-yellow-50 text-yellow-800"
                              : o.status === "accepted"
                                ? "bg-green-100 text-green-700"
                                : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {o.status}
                        </span>
                      </div>
                      <div className="mt-1 grid gap-2 text-xs sm:grid-cols-2">
                        <div className="rounded bg-slate-50 p-2">
                          <div className="font-bold uppercase tracking-wide text-slate-400">
                            {o.direction === "incoming" ? "You get" : "You give"}
                          </div>
                          {o.give.map((l, i) => (
                            <div key={i}>
                              {l.qty}x {l.label}
                              {l.value != null ? ` ~$${l.value.toFixed(2)}` : ""}
                            </div>
                          ))}
                          {o.give.length === 0 && <div className="text-slate-400">nothing</div>}
                        </div>
                        <div className="rounded bg-slate-50 p-2">
                          <div className="font-bold uppercase tracking-wide text-slate-400">
                            {o.direction === "incoming" ? "You give" : "You get"}
                          </div>
                          {o.get.map((l, i) => (
                            <div key={i}>
                              {l.qty}x {l.label}
                              {l.value != null ? ` ~$${l.value.toFixed(2)}` : ""}
                            </div>
                          ))}
                          {o.get.length === 0 && <div className="text-slate-400">nothing</div>}
                        </div>
                      </div>
                      {o.message && (
                        <p className="mt-1 text-xs italic text-slate-500">&ldquo;{o.message}&rdquo;</p>
                      )}
                      {o.status === "pending" && (
                        <div className="mt-2 flex gap-2">
                          {o.direction === "incoming" ? (
                            <>
                              <button
                                className="btn-primary px-3 py-1 text-xs"
                                onClick={() => respondToOffer(o, "accepted")}
                              >
                                ✓ Accept
                              </button>
                              <button
                                className="btn px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                                onClick={() => respondToOffer(o, "declined")}
                              >
                                Decline
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn px-3 py-1 text-xs text-slate-500 hover:bg-slate-100"
                              onClick={() => respondToOffer(o, "withdrawn")}
                            >
                              Withdraw
                            </button>
                          )}
                        </div>
                      )}
                      {o.status === "accepted" && (
                        <p className="mt-1 text-xs text-green-700">
                          Deal! Arrange the hand-off in person — the app doesn&apos;t move cards.
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <TradeBoard />

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
                {offerNotice && (
                  <div className="mt-2 rounded-lg bg-green-50 p-2.5 text-sm text-green-800">
                    {offerNotice}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <input
                    className="input min-w-0 flex-1 text-sm"
                    placeholder="Optional note — e.g. can meet Saturday!"
                    maxLength={1000}
                    value={tradeMessage}
                    onChange={(e) => setTradeMessage(e.target.value)}
                  />
                  <button
                    className="btn-primary shrink-0 text-sm"
                    disabled={sendingOffer || Object.keys(give).length + Object.keys(get).length === 0}
                    onClick={sendTradeRequest}
                  >
                    {sendingOffer ? "Sending…" : "📨 Send trade request"}
                  </button>
                </div>
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

/** Pick offered cards from YOUR OWN collection — you can only trade away
 *  cards you actually have, up to the number of copies you own. */
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

/** Small debounced card search for attaching card pictures to a post. */
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
  const q = search.trim();
  const filtered = items
    .filter((it) => matchesSearch(q, it.card.name, it.card.set_name, it.card.number))
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
