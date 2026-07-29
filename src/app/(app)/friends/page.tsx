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
  image?: string | null;
}

interface OfferMessage {
  id: string;
  authorName: string;
  mine: boolean;
  body: string;
  created_at: string;
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
  messages: OfferMessage[];
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

  const [offerChatOpen, setOfferChatOpen] = useState<string | null>(null);
  const [offerChatText, setOfferChatText] = useState("");
  const [offerChatBusy, setOfferChatBusy] = useState(false);

  async function sendOfferMessage(offer: TradeOffer) {
    if (!offerChatText.trim() || offerChatBusy) return;
    setOfferChatBusy(true);
    const res = await fetch(`/api/trade/offers/${offer.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: offerChatText }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setOfferChatText("");
    await loadOffers();
    setOfferChatBusy(false);
  }

  async function clearOffer(offer: TradeOffer) {
    setError(null);
    const res = await fetch(`/api/trade/offers/${offer.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Couldn't clear the trade request");
    loadOffers();
  }

  async function clearResolvedOffers() {
    if (!confirm("Clear all finished trade requests? This removes them for both sides.")) return;
    setError(null);
    const res = await fetch("/api/trade/offers", { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Couldn't clear trade requests");
    } else if ((json.cleared ?? 0) === 0) {
      setError(
        "Nothing was cleared — the admin needs to run supabase/migrations/014_trade_cleanup.sql to enable clearing."
      );
    }
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
      .map((it) => ({
        label: itemLabel(it),
        qty: side[it.id],
        value: itemPrice(it),
        image: it.card.image_small,
      }));
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

      {!friend && <PalsSection />}

      {!friend && (
        <>
          {offers.length > 0 && (
            <div className="card-panel p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="font-semibold">
                  📨 Trade requests (
                  {offers.filter((o) => o.status === "pending").length} pending)
                </h2>
                {offers.some((o) => o.status !== "pending") && (
                  <button
                    className="shrink-0 text-xs text-slate-400 hover:underline"
                    onClick={clearResolvedOffers}
                  >
                    Clear resolved
                  </button>
                )}
              </div>
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
                        <div className="flex shrink-0 items-center gap-1">
                          <span
                            className={`chip ${
                              o.status === "pending"
                                ? "bg-yellow-50 text-yellow-800"
                                : o.status === "accepted"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {o.status}
                          </span>
                          {o.status !== "pending" && (
                            <button
                              aria-label="Clear this trade request"
                              title="Clear this trade request (removes it for both sides)"
                              className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100"
                              onClick={() => clearOffer(o)}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 grid gap-2 text-xs sm:grid-cols-2">
                        <OfferSide
                          label={o.direction === "incoming" ? "You get" : "You give"}
                          lines={o.give}
                        />
                        <OfferSide
                          label={o.direction === "incoming" ? "You give" : "You get"}
                          lines={o.get}
                        />
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
                      {(o.status === "pending" || o.status === "accepted" || o.messages.length > 0) && (
                        <div className="mt-2">
                          <button
                            className="text-xs font-medium text-poke-blue hover:underline"
                            onClick={() => {
                              setOfferChatOpen(offerChatOpen === o.id ? null : o.id);
                              setOfferChatText("");
                            }}
                          >
                            💬 {o.messages.length} message{o.messages.length === 1 ? "" : "s"}
                            {offerChatOpen === o.id ? " ▲" : " ▼"}
                          </button>
                          {offerChatOpen === o.id && (
                            <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                              {o.messages.map((m) => (
                                <div
                                  key={m.id}
                                  className={`max-w-[85%] rounded-lg p-2 text-xs ${
                                    m.mine
                                      ? "ml-auto bg-poke-blue/10 text-slate-800"
                                      : "bg-slate-50 text-slate-800"
                                  }`}
                                >
                                  <span className="font-semibold">
                                    {m.mine ? "You" : m.authorName}:
                                  </span>{" "}
                                  <span className="whitespace-pre-wrap">{m.body}</span>
                                </div>
                              ))}
                              {(o.status === "pending" || o.status === "accepted") && (
                                <form
                                  className="flex gap-2 pt-1"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    sendOfferMessage(o);
                                  }}
                                >
                                  <input
                                    className="input min-w-0 flex-1 text-sm"
                                    placeholder={
                                      o.status === "accepted"
                                        ? "e.g. Saturday at the card shop?"
                                        : "e.g. Would you add a reverse holo?"
                                    }
                                    maxLength={1000}
                                    value={offerChatText}
                                    onChange={(e) => setOfferChatText(e.target.value)}
                                  />
                                  <button
                                    className="btn-secondary shrink-0 text-sm"
                                    disabled={offerChatBusy || !offerChatText.trim()}
                                  >
                                    Send
                                  </button>
                                </form>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <a href="/trades" className="card-panel block p-4 transition-colors hover:bg-brand-sunken">
            <h2 className="mb-1 font-semibold">🤝 Trade board</h2>
            <p className="text-sm text-slate-500">
              Looking-for and offering posts have their own page now — open the board →
            </p>
          </a>

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
                        {d.share_scope === "friends" && (
                          <span className="ml-1 chip bg-poke-blue/10 text-poke-blue">🤝 pals</span>
                        )}
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

      {/* Shared deck viewer — the OVERLAY scrolls (not the panel): inner
          scroll areas inside fixed overlays are unreliable on iOS Safari */}
      {viewingDeck && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60 p-4"
          onClick={() => setViewingDeck(null)}
        >
          <div
            className="card-panel mx-auto my-6 w-full max-w-lg p-5"
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



/** Pick offered cards from YOUR OWN collection — you can only trade away
 *  cards you actually have, up to the number of copies you own. */

/** Small debounced card search for attaching card pictures to a post. */

function OfferSide({ label, lines }: { label: string; lines: OfferLine[] }) {
  return (
    <div className="rounded bg-slate-50 p-2">
      <div className="font-bold uppercase tracking-wide text-slate-400">{label}</div>
      {lines.length === 0 ? (
        <div className="text-slate-400">nothing</div>
      ) : (
        <ul className="mt-1 space-y-1">
          {lines.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {l.image && (
                <div className="relative h-10 w-7 shrink-0 overflow-hidden rounded bg-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                </div>
              )}
              <span className="min-w-0">
                {l.qty}x {l.label}
                {l.value != null ? (
                  <span className="text-slate-400"> ~${l.value.toFixed(2)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
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
  // card_id → image url, same visual grid as your own decks
  const [images, setImages] = useState<Record<string, string | null>>({});
  // name → image, for entries with no card id ("Basic Fighting Energy" etc.)
  const [nameImages, setNameImages] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const ids = [...new Set(cards.map((c) => c.card_id).filter((id): id is string => !!id))];
    const names = [...new Set(cards.filter((c) => !c.card_id).map((c) => c.name))];
    if (ids.length === 0 && names.length === 0) return;
    const params = new URLSearchParams();
    if (ids.length > 0) params.set("ids", ids.join(","));
    if (names.length > 0) params.set("names", names.join(","));
    fetch(`/api/cards/images?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.images) setImages(j.images);
        if (j?.imagesByName) setNameImages(j.imagesByName);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  const groups: Record<"pokemon" | "trainer" | "energy", DeckCardEntry[]> = {
    pokemon: [],
    trainer: [],
    energy: [],
  };
  for (const c of cards) (groups[c.category] ?? groups.trainer).push(c);
  return (
    <div className="mt-3 space-y-4">
      {(["pokemon", "trainer", "energy"] as const).map(
        (cat) =>
          groups[cat].length > 0 && (
            <div key={cat}>
              <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                {cat} ({groups[cat].reduce((s, c) => s + c.quantity, 0)})
              </h4>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {groups[cat].map((c, i) => (
                  <div key={i} title={c.name}>
                    <div className="relative">
                      {(c.card_id && images[c.card_id]) || nameImages[c.name] ? (
                        <div className="aspect-[63/88] w-full overflow-hidden rounded">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={(c.card_id ? images[c.card_id] : null) ?? nameImages[c.name]!}
                            alt={c.name}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        </div>
                      ) : (
                        <div className="flex aspect-[63/88] items-center justify-center rounded bg-slate-100 p-1 text-center text-[10px] font-medium leading-tight text-slate-500">
                          {c.name}
                        </div>
                      )}
                      <span className="absolute -right-1 -top-1 rounded-full bg-poke-dark px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                        ×{c.quantity}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-center text-[10px] text-slate-500">
                      {c.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
      )}
    </div>
  );
}

/** 🤝 Pokémon Pals — mutual friendships a tier above group sharing.
 *  Being pals unlocks direct messages and pals-only deck sharing. */
function PalsSection() {
  interface PalMsg {
    id: string;
    mine: boolean;
    authorName: string;
    body: string;
    created_at: string;
  }
  interface Pal {
    id: string;
    userId: string;
    name: string;
    since: string;
    messages: PalMsg[];
  }
  interface PalReq {
    id: string;
    userId: string;
    name: string;
  }
  interface PalsData {
    migrated: boolean;
    pals: Pal[];
    incoming: PalReq[];
    outgoing: PalReq[];
    candidates: Array<{ userId: string; name: string }>;
  }

  const [data, setData] = useState<PalsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPick, setAddPick] = useState("");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/friends/requests");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load pals");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load pals");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function call(input: RequestInfo, init: RequestInit) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(input, init);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    }
    setBusy(false);
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!data) return null;

  if (!data.migrated) {
    return (
      <div className="card-panel p-4">
        <h2 className="font-semibold">🤝 Pokémon Pals</h2>
        <p className="mt-1 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          Pals need a one-time database update — ask the admin to run{" "}
          <code>supabase/migrations/020_pals.sql</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="card-panel space-y-3 p-4">
      <div>
        <h2 className="font-semibold">
          🤝 Pokémon Pals ({data.pals.length})
          {data.incoming.length > 0 && (
            <span className="ml-2 chip bg-red-50 text-red-700">
              {data.incoming.length} request{data.incoming.length === 1 ? "" : "s"}
            </span>
          )}
        </h2>
        <p className="text-xs text-slate-500">
          Pals are mutual — they unlock direct messages and &ldquo;pals only&rdquo; deck
          sharing (set per deck on the Decks page).
        </p>
      </div>

      {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{err}</div>}

      {data.incoming.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg bg-poke-blue/5 p-2.5">
          <span className="text-sm">
            <b>{r.name}</b> wants to be pals
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              className="btn-primary text-xs"
              disabled={busy}
              onClick={() => call("/api/friends/requests", jsonInit("PATCH", { id: r.id, action: "accept" }))}
            >
              Accept
            </button>
            <button
              className="btn-secondary text-xs"
              disabled={busy}
              onClick={() => call("/api/friends/requests", jsonInit("PATCH", { id: r.id, action: "decline" }))}
            >
              Decline
            </button>
          </span>
        </div>
      ))}

      {data.pals.length === 0 && data.incoming.length === 0 && (
        <p className="text-sm text-slate-400">No pals yet — send a request below.</p>
      )}

      <ul className="divide-y divide-slate-100">
        {data.pals.map((p) => (
          <li key={p.id} className="py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  className="btn-secondary text-xs"
                  onClick={() => {
                    setOpenThread(openThread === p.id ? null : p.id);
                    setDraft("");
                  }}
                >
                  💬 {p.messages.length > 0 ? p.messages.length : "Message"}
                </button>
                <button
                  aria-label={`Remove ${p.name} as a pal`}
                  className="text-slate-400 hover:text-red-600"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove ${p.name} as a pal?`)) {
                      call("/api/friends/requests", jsonInit("DELETE", { id: p.id }));
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            {openThread === p.id && (
              <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2">
                {p.messages.length === 0 ? (
                  <p className="text-xs text-slate-400">No messages yet — say hi!</p>
                ) : (
                  p.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-lg p-2 text-sm ${
                        m.mine ? "ml-auto bg-poke-blue/10" : "bg-white"
                      }`}
                    >
                      <div className="text-[10px] text-slate-400">
                        {m.authorName} · {new Date(m.created_at).toLocaleString()}
                      </div>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </div>
                  ))
                )}
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!draft.trim()) return;
                    call(`/api/friends/pals/${p.id}/messages`, jsonInit("POST", { body: draft }));
                    setDraft("");
                  }}
                >
                  <input
                    className="input text-sm"
                    placeholder={`Message ${p.name}…`}
                    maxLength={4000}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button className="btn-primary shrink-0 text-sm" disabled={busy || !draft.trim()}>
                    Send
                  </button>
                </form>
              </div>
            )}
          </li>
        ))}
      </ul>

      {data.outgoing.length > 0 && (
        <div className="text-xs text-slate-500">
          Waiting on:{" "}
          {data.outgoing.map((r, i) => (
            <span key={r.id}>
              {i > 0 && " · "}
              {r.name}{" "}
              <button
                className="text-slate-400 hover:underline"
                disabled={busy}
                onClick={() => call("/api/friends/requests", jsonInit("DELETE", { id: r.id }))}
              >
                (cancel)
              </button>
            </span>
          ))}
        </div>
      )}

      {data.candidates.length > 0 && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!addPick) return;
            call("/api/friends/requests", jsonInit("POST", { toUserId: addPick }));
            setAddPick("");
          }}
        >
          <select
            className="input text-sm"
            value={addPick}
            onChange={(e) => setAddPick(e.target.value)}
          >
            <option value="">Send a pal request to…</option>
            {data.candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary shrink-0 text-sm" disabled={busy || !addPick}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
