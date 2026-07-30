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
import { avatarColor, initialsFor } from "@/lib/avatar";
import { formatFriendCode, friendLink, normalizeFriendCode } from "@/lib/friendCode";
import QrCode from "@/components/QrCode";
import { matchesSearch, shortAgo } from "@/lib/text";

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
  const [myCardCount, setMyCardCount] = useState(0);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** Pal user ids, lifted out of PalsSection so the sharers list can badge
   *  them — the artboard marks a pal wherever their name appears. */
  const [palIds, setPalIds] = useState<Set<string>>(new Set());
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
      setMyCardCount(json.myCardCount ?? 0);
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

  const pendingOffers = offers.filter((o) => o.status === "pending");

  return (
    <div className="space-y-4">
      {!friend && (
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-.025em]">Friends</h1>
          <p className="mt-[3px] max-w-[70ch] text-sm leading-[1.6] text-brand-ink3">
            Members who share their collection show up here. Browse their binder, borrow a shared
            deck for a battle, and work trades out card for card with {AI_NAME}.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-brand-line bg-white p-3 text-sm text-brand-negative">
          {error}
        </div>
      )}

      {!migrated && (
        <div className="rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-[17px] py-[15px] text-[13px] leading-[1.6] text-[#7A5A12]">
          Sharing needs a one-time database update — ask the admin to run{" "}
          <code className="font-mono">supabase/migrations/008_sharing.sql</code> in the Supabase SQL
          editor.
        </div>
      )}

      {!friend && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-brand-line bg-white px-5 py-[18px]">
          <button
            role="switch"
            aria-checked={sharing}
            aria-label="Share my collection"
            onClick={toggleSharing}
            className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
              sharing ? "bg-brand-accent" : "bg-brand-line-strong"
            }`}
          >
            <span
              className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
                sharing ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
          <div className="min-w-[280px] flex-1">
            <div className="text-[14.5px] font-medium">Share my collection</div>
            <div className="mt-0.5 text-[13px] leading-[1.5] text-brand-ink3">
              {sharing
                ? "On — other members can see what you own and can propose trades. Turn it off and you disappear from their lists."
                : "Off — nobody can see your cards or propose a trade. Turn it on to appear in other members' lists."}
            </div>
          </div>
          {renaming ? (
            <form
              className="flex shrink-0 gap-2"
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
                  setRenaming(false);
                }
              }}
            >
              <input
                autoFocus
                className="w-[150px] rounded-lg border border-brand-line-strong px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-accent"
                maxLength={30}
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  setNameSaved(false);
                }}
                placeholder="e.g. AshK"
              />
              <button
                className="shrink-0 whitespace-nowrap rounded-full bg-brand-ink px-3.5 py-1.5 text-[12.5px] font-medium text-brand-canvas disabled:opacity-50"
                disabled={!nameDraft.trim() || nameDraft.trim() === myName}
              >
                Save
              </button>
              <button
                type="button"
                className="shrink-0 text-[12.5px] text-brand-ink4 hover:underline"
                onClick={() => {
                  setNameDraft(myName);
                  setRenaming(false);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              className="shrink-0 whitespace-nowrap rounded-md bg-brand-sunken px-2.5 py-[5px] font-mono text-[11px] text-brand-ink3 hover:bg-brand-line"
              onClick={() => setRenaming(true)}
              title="This is the name other members see — click to change it"
            >
              {nameSaved ? "✓ " : ""}You: {myName || "unnamed"} · {myCardCount.toLocaleString()}{" "}
              cards
            </button>
          )}
        </div>
      )}

      {!friend && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_356px]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="overflow-hidden rounded-[18px] border border-brand-line bg-white">
              <div className="flex items-baseline justify-between gap-3 px-[22px] pb-3 pt-[18px]">
                <div className="font-display text-[17px] font-bold">Sharing their collection</div>
                <span className="shrink-0 text-[12.5px] text-brand-ink5">
                  {friends.length} member{friends.length === 1 ? "" : "s"}
                </span>
              </div>
              {friends.length === 0 ? (
                <p className="border-t border-brand-panel-alt px-[22px] py-4 text-sm text-brand-ink4">
                  No one else is sharing their collection yet. Once a friend flips their toggle,
                  they&apos;ll show up here.
                </p>
              ) : (
                friends.map((f) => (
                  <div
                    key={f.id}
                    className="flex flex-wrap items-center gap-[13px] border-t border-brand-panel-alt px-[22px] py-[13px]"
                  >
                    <span
                      className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ background: avatarColor(f.id) }}
                    >
                      {initialsFor(f.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{f.name}</div>
                      <div className="font-mono text-[11.5px] text-brand-ink4">
                        {f.cardCount.toLocaleString()} card{f.cardCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    {palIds.has(f.id) && (
                      <span className="shrink-0 rounded-[5px] bg-brand-accent-tint px-[7px] py-[3px] font-mono text-[10px] text-brand-accent">
                        PAL
                      </span>
                    )}
                    <button
                      className="shrink-0 whitespace-nowrap rounded-full bg-brand-ink px-3.5 py-[7px] text-[12.5px] font-medium text-brand-canvas hover:bg-brand-ink2"
                      onClick={() => openTrade(f)}
                    >
                      Browse &amp; trade
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-[18px] border border-brand-line bg-white p-[22px]">
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <div className="font-display text-[17px] font-bold">Decks shared with you</div>
                <span className="shrink-0 text-[12.5px] text-brand-ink5">
                  borrowable in battles
                </span>
              </div>
              <p className="mb-[14px] text-[13.5px] leading-[1.55] text-brand-ink3">
                Pick one of these when you start a battle and you play it as if it were yours —
                handy when a kid wants a go with a proper deck. Share yours from the Decks page.
              </p>
              {sharedDecks.length === 0 ? (
                <p className="text-sm text-brand-ink4">No shared decks yet.</p>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {sharedDecks.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center gap-3 rounded-[14px] border border-brand-line p-[14px]"
                    >
                      <div className="aspect-[63/88] w-[34px] shrink-0 overflow-hidden rounded bg-brand-sunken">
                        {d.cards?.[0]?.card_id && (
                          <span className="flex h-full w-full items-center justify-center text-[13px]">
                            🎴
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{d.name}</div>
                        <div className="truncate text-xs text-brand-ink4">
                          by {d.ownerName} ·{" "}
                          {(d.cards ?? []).reduce((s, c) => s + c.quantity, 0)} cards
                          {d.share_scope === "friends" && " · pals only"}
                        </div>
                      </div>
                      <button
                        className="shrink-0 whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken"
                        onClick={() => setViewingDeck(d)}
                      >
                        View
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col gap-3">
            <div className="rounded-[18px] border border-brand-line bg-white p-5">
              <div className="mb-[14px] flex items-center justify-between gap-3">
                <span className="font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink5">
                  Trade requests
                </span>
                <span className="shrink-0 rounded-[5px] bg-brand-sunken px-[7px] py-[3px] font-mono text-[10.5px] text-brand-ink3">
                  {pendingOffers.length} pending
                </span>
              </div>

              {offers.length === 0 ? (
                <p className="text-[13px] leading-[1.55] text-brand-ink4">
                  Nothing yet. Open someone&apos;s binder above, pick the cards each way, and send
                  them a request.
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {offers
                    .filter((o, i) => o.status === "pending" || i < 8)
                    .map((o) => (
                      <OfferCard
                        key={o.id}
                        offer={o}
                        chatOpen={offerChatOpen === o.id}
                        chatText={offerChatText}
                        chatBusy={offerChatBusy}
                        onToggleChat={() => {
                          setOfferChatOpen(offerChatOpen === o.id ? null : o.id);
                          setOfferChatText("");
                        }}
                        onChatText={setOfferChatText}
                        onSendChat={() => sendOfferMessage(o)}
                        onRespond={(s) => respondToOffer(o, s)}
                        onClear={() => clearOffer(o)}
                      />
                    ))}
                </div>
              )}

              <p className="mt-3 text-xs leading-[1.5] text-brand-ink5">
                Values are our price estimates, not an appraisal — you two agree the trade, we just
                do the arithmetic.
                {offers.some((o) => o.status !== "pending") && (
                  <>
                    {" "}
                    <button className="underline hover:text-brand-ink3" onClick={clearResolvedOffers}>
                      Clear resolved
                    </button>
                  </>
                )}
              </p>
            </div>

            <PalsSection onPals={setPalIds} />
          </aside>
        </div>
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
            className="card-panel mx-auto my-6 w-full max-w-[min(56rem,94vw)] p-5"
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
    <div>
      <div className="mb-[5px] font-mono text-[9.5px] uppercase tracking-[.08em] text-brand-ink4">
        {label}
      </div>
      {lines.length === 0 ? (
        <div className="text-[12.5px] text-brand-ink5">nothing</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="flex items-center gap-[9px] py-[3px]">
            <div className="aspect-[63/88] w-6 shrink-0 overflow-hidden rounded-[3px] bg-brand-line">
              {l.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image} alt="" className="h-full w-full object-cover" loading="lazy" />
              )}
            </div>
            <span className="min-w-0 flex-1 truncate text-[12.5px]" title={l.label}>
              {l.qty > 1 ? `${l.qty}× ` : ""}
              {l.label}
            </span>
            {l.value != null && (
              <span className="shrink-0 font-mono text-[11.5px] text-brand-positive">
                ${(l.value * l.qty).toFixed(2)}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** Sum a side's priced lines. Unpriced cards contribute nothing rather than
 *  guessing, which is why the fairness note says "on the cards we can price". */
function linesTotal(lines: OfferLine[]): { total: number; unpriced: number } {
  let total = 0;
  let unpriced = 0;
  for (const l of lines) {
    if (l.value == null) unpriced += l.qty;
    else total += l.value * l.qty;
  }
  return { total, unpriced };
}

/** One trade request in the rail, per artboard 13. An incoming request that
 *  still needs an answer wears the accent border; everything else is quiet. */
function OfferCard({
  offer: o,
  chatOpen,
  chatText,
  chatBusy,
  onToggleChat,
  onChatText,
  onSendChat,
  onRespond,
  onClear,
}: {
  offer: TradeOffer;
  chatOpen: boolean;
  chatText: string;
  chatBusy: boolean;
  onToggleChat: () => void;
  onChatText: (v: string) => void;
  onSendChat: () => void;
  onRespond: (s: "accepted" | "declined" | "withdrawn") => void;
  onClear: () => void;
}) {
  const incoming = o.direction === "incoming";
  const live = o.status === "pending";
  // "give"/"get" are stored from the SENDER's point of view, so an incoming
  // request's give side is what lands in your binder.
  const youGet = incoming ? o.give : o.get;
  const youGive = incoming ? o.get : o.give;
  const getSum = linesTotal(youGet);
  const giveSum = linesTotal(youGive);
  const diff = getSum.total - giveSum.total;
  const unpriced = getSum.unpriced + giveSum.unpriced;

  return (
    <div
      className={`rounded-[14px] p-[15px] ${
        incoming && live
          ? "border-[1.5px] border-brand-accent bg-brand-accent-tint"
          : "border border-brand-line"
      }`}
    >
      <div className="mb-[11px] flex items-center gap-[9px]">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ background: avatarColor(o.otherName) }}
        >
          {initialsFor(o.otherName)}
        </span>
        <span className="min-w-0 truncate text-[13.5px] font-medium">{o.otherName}</span>
        <span
          className={`shrink-0 rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] ${
            incoming ? "bg-brand-accent text-white" : "bg-brand-sunken text-brand-ink3"
          }`}
        >
          {incoming ? "INCOMING" : "OUTGOING"}
        </span>
        <span
          className="ml-auto shrink-0 font-mono text-[10.5px] text-brand-ink4"
          title={new Date(o.created_at).toLocaleString()}
        >
          {shortAgo(o.created_at)}
        </span>
        {!live && (
          <button
            aria-label="Clear this trade request"
            title="Clear this trade request (removes it for both sides)"
            className="shrink-0 text-brand-ink5 hover:text-brand-ink"
            onClick={onClear}
          >
            ✕
          </button>
        )}
      </div>

      {!live && (
        <div className="mb-2.5 font-mono text-[10px] uppercase tracking-[.07em] text-brand-ink4">
          {o.status}
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        <OfferSide label="You get" lines={youGet} />
        <OfferSide label="You give" lines={youGive} />
      </div>

      {o.message && (
        <div
          className={`mt-[11px] border-t pt-[11px] text-[12.5px] leading-[1.5] text-brand-ink2 ${
            incoming && live ? "border-[#D8E0FF]" : "border-brand-line-soft"
          }`}
        >
          &ldquo;{o.message}&rdquo;
        </div>
      )}

      <div className="mt-[11px] flex flex-wrap items-center justify-between gap-2">
        <span
          className={`shrink-0 font-mono text-[11px] ${
            Math.abs(diff) <= 3 ? "text-brand-positive" : "text-brand-negative"
          }`}
          title={
            unpriced > 0
              ? `${unpriced} card${unpriced === 1 ? "" : "s"} have no price on file and aren't counted`
              : undefined
          }
        >
          {Math.abs(diff) <= 3
            ? "Within $3 either way"
            : `$${Math.abs(diff).toFixed(2)} ${diff > 0 ? "your way in" : "your way out"}`}
          {unpriced > 0 ? " *" : ""}
        </span>
        <div className="flex shrink-0 gap-1.5">
          {(live || o.messages.length > 0 || o.status === "accepted") && (
            <button
              className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken"
              onClick={onToggleChat}
            >
              Chat{o.messages.length > 0 ? ` ${o.messages.length}` : ""}
            </button>
          )}
          {live &&
            (incoming ? (
              <>
                <button
                  className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium text-brand-negative hover:bg-brand-sunken"
                  onClick={() => onRespond("declined")}
                >
                  Decline
                </button>
                <button
                  className="whitespace-nowrap rounded-full bg-brand-ink px-[13px] py-[7px] text-[12.5px] font-medium text-brand-canvas hover:bg-brand-ink2"
                  onClick={() => onRespond("accepted")}
                >
                  Accept
                </button>
              </>
            ) : (
              <button
                className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken"
                onClick={() => onRespond("withdrawn")}
              >
                Withdraw
              </button>
            ))}
        </div>
      </div>

      {o.status === "accepted" && (
        <p className="mt-2 text-[12px] text-brand-positive">
          Deal! Arrange the hand-off in person — the app doesn&apos;t move cards.
        </p>
      )}

      {chatOpen && (
        <div className="mt-[11px] flex flex-col gap-1.5 border-t border-brand-line-soft pt-[11px]">
          {o.messages.length === 0 && (
            <p className="text-[12px] text-brand-ink5">No messages yet.</p>
          )}
          {o.messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-[10px] p-2 text-[12px] ${
                m.mine ? "ml-auto bg-brand-accent/10" : "bg-brand-panel-alt"
              }`}
            >
              <span className="font-medium">{m.mine ? "You" : m.authorName}:</span>{" "}
              <span className="whitespace-pre-wrap">{m.body}</span>
            </div>
          ))}
          {(o.status === "pending" || o.status === "accepted") && (
            <form
              className="flex gap-1.5 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                onSendChat();
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-full border border-brand-line-strong bg-white px-3 py-1.5 text-[12.5px] outline-none focus:border-brand-accent"
                placeholder={
                  o.status === "accepted"
                    ? "e.g. Saturday at the card shop?"
                    : "e.g. Would you add a reverse holo?"
                }
                maxLength={1000}
                value={chatText}
                onChange={(e) => onChatText(e.target.value)}
              />
              <button
                className="shrink-0 whitespace-nowrap rounded-full bg-brand-ink px-3 py-1.5 text-[12.5px] font-medium text-brand-canvas disabled:opacity-50"
                disabled={chatBusy || !chatText.trim()}
              >
                Send
              </button>
            </form>
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
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
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
function PalsSection({ onPals }: { onPals?: (ids: Set<string>) => void }) {
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
    myCode: string | null;
    allowRequests: boolean;
    codesReady: boolean;
  }

  const [data, setData] = useState<PalsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/friends/requests");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load pals");
      setData(json);
      onPals?.(new Set((json.pals ?? []).map((p: Pal) => p.userId)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load pals");
    }
  }

  useEffect(() => {
    load();
    // A friend link lands here as /friends?add=CODE. Fill the box rather than
    // sending straight away: a link you followed shouldn't fire off a request
    // before you've seen whose it is.
    const add = new URLSearchParams(window.location.search).get("add");
    if (add && normalizeFriendCode(add)) {
      setCodeDraft(formatFriendCode(normalizeFriendCode(add)));
      // Drop it from the URL so a refresh or a shared screenshot of the
      // address bar doesn't keep re-offering someone else's code.
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Resolves true only when the request actually succeeded, so callers can
   *  tell "sent" from "the server said no". */
  async function call(input: RequestInfo, init: RequestInit): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(input, init);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      await load();
      setBusy(false);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
      setBusy(false);
      return false;
    }
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  /** Built in the browser so it always carries the host the user is actually
   *  on — a link baked server-side picks up the proxy's hostname instead. */
  const myLink = (code: string | null) =>
    code ? friendLink(window.location.origin, code) : "";

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr(`Couldn't copy — it's ${text}`);
    }
  }

  if (!data) return null;

  if (!data.migrated) {
    return (
      <div className="rounded-[18px] bg-brand-sunken p-5">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink4">
          Pals
        </div>
        <p className="text-[13px] leading-[1.55] text-brand-ink2">
          Pals need a one-time database update — ask the admin to run{" "}
          <code className="font-mono">supabase/migrations/020_pals.sql</code>.
        </p>
      </div>
    );
  }

  const palPill =
    "whitespace-nowrap rounded-full bg-brand-ink px-[13px] py-[7px] text-[12.5px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-50";
  const palPillQuiet =
    "whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken disabled:opacity-50";

  return (
    <div className="rounded-[18px] bg-brand-sunken p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink4">
          {data.incoming.length > 0 ? "Pal requests" : "Pals"}
        </span>
        {data.incoming.length > 0 && (
          <span className="shrink-0 rounded-[5px] bg-brand-accent px-[7px] py-[3px] font-mono text-[10.5px] text-white">
            {data.incoming.length} new
          </span>
        )}
      </div>

      {err && <div className="mb-2.5 text-[12.5px] text-brand-negative">{err}</div>}

      {data.incoming.map((r) => (
        <div key={r.id} className="mb-3 flex items-center gap-[11px]">
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ background: avatarColor(r.userId) }}
          >
            {initialsFor(r.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium">{r.name}</div>
            <div className="text-xs text-brand-ink3">wants to be pals</div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              className={palPillQuiet}
              disabled={busy}
              onClick={() =>
                call("/api/friends/requests", jsonInit("PATCH", { id: r.id, action: "decline" }))
              }
            >
              Decline
            </button>
            <button
              className={palPill}
              disabled={busy}
              onClick={() =>
                call("/api/friends/requests", jsonInit("PATCH", { id: r.id, action: "accept" }))
              }
            >
              Accept
            </button>
          </div>
        </div>
      ))}

      {data.pals.length === 0 && data.incoming.length === 0 && (
        <p className="text-[13px] leading-[1.55] text-brand-ink3">
          No pals yet — send a request below.
        </p>
      )}

      {data.pals.map((p) => (
        <div key={p.id} className="border-t border-brand-line py-2.5 first:border-t-0">
          <div className="flex items-center gap-[11px]">
            <span
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
              style={{ background: avatarColor(p.userId) }}
            >
              {initialsFor(p.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.name}</span>
            <button
              className={palPillQuiet}
              onClick={() => {
                setOpenThread(openThread === p.id ? null : p.id);
                setDraft("");
              }}
            >
              Chat{p.messages.length > 0 ? ` ${p.messages.length}` : ""}
            </button>
            <button
              aria-label={`Remove ${p.name} as a pal`}
              className="shrink-0 text-brand-ink5 hover:text-brand-negative"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove ${p.name} as a pal?`)) {
                  call("/api/friends/requests", jsonInit("DELETE", { id: p.id }));
                }
              }}
            >
              ✕
            </button>
          </div>
          {openThread === p.id && (
            <div className="mt-2 flex flex-col gap-1.5 rounded-xl bg-white p-2.5">
              {p.messages.length === 0 ? (
                <p className="text-xs text-brand-ink5">No messages yet — say hi!</p>
              ) : (
                p.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[85%] rounded-[10px] p-2 text-[12.5px] ${
                      m.mine ? "ml-auto bg-brand-accent/10" : "bg-brand-panel-alt"
                    }`}
                  >
                    <div className="font-mono text-[10px] text-brand-ink5">
                      {m.authorName} · {shortAgo(m.created_at)}
                    </div>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                ))
              )}
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!draft.trim()) return;
                  call(`/api/friends/pals/${p.id}/messages`, jsonInit("POST", { body: draft }));
                  setDraft("");
                }}
              >
                <input
                  className="min-w-0 flex-1 rounded-full border border-brand-line-strong px-3 py-1.5 text-[12.5px] outline-none focus:border-brand-accent"
                  placeholder={`Message ${p.name}…`}
                  maxLength={4000}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className={palPill} disabled={busy || !draft.trim()}>
                  Send
                </button>
              </form>
            </div>
          )}
        </div>
      ))}

      {data.outgoing.length > 0 && (
        <div className="mt-2.5 text-xs leading-[1.55] text-brand-ink3">
          Waiting on:{" "}
          {data.outgoing.map((r, i) => (
            <span key={r.id}>
              {i > 0 && " · "}
              {r.name}{" "}
              <button
                className="text-brand-ink5 hover:underline"
                disabled={busy}
                onClick={() => call("/api/friends/requests", jsonInit("DELETE", { id: r.id }))}
              >
                (cancel)
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Add someone — by code only. There is no list to pick from any more:
          you reach a person because they gave you their code, not because
          they happen to have an account. */}
      <form
        className="mt-3 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const code = normalizeFriendCode(codeDraft);
          if (!code) {
            setErr("Friend codes are 8 characters, like 7K4Q-M9XZ.");
            return;
          }
          setSent(null);
          call("/api/friends/requests", jsonInit("POST", { code })).then(() => {
            setCodeDraft("");
            setSent("Request sent — they'll see it on their Friends page.");
          });
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-full border border-brand-line-strong bg-white px-3 py-1.5 font-mono text-[12.5px] uppercase tracking-[.08em] outline-none placeholder:font-body placeholder:normal-case placeholder:tracking-normal placeholder:text-brand-ink5 focus:border-brand-accent"
          placeholder="Enter a friend code…"
          value={codeDraft}
          maxLength={12}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setCodeDraft(e.target.value);
            setSent(null);
          }}
        />
        <button className={palPillQuiet} disabled={busy || !normalizeFriendCode(codeDraft)}>
          Add
        </button>
      </form>
      {sent && <p className="mt-1.5 text-[12px] text-brand-positive">{sent}</p>}

      {/* Your own code, to hand out. */}
      <div className="mt-3 rounded-[14px] bg-white p-3.5">
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.1em] text-brand-ink5">
          Your friend code
        </div>
        {data.codesReady && data.myCode ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[19px] font-medium tracking-[.12em]">
                {formatFriendCode(data.myCode)}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 rounded-full border border-brand-line-strong px-2.5 py-1 text-[11.5px] font-medium hover:bg-brand-sunken"
                onClick={() => copy(formatFriendCode(data.myCode), "code")}
              >
                {copied === "code" ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="shrink-0 rounded-full border border-brand-line-strong px-2.5 py-1 text-[11.5px] font-medium hover:bg-brand-sunken"
                onClick={() => copy(myLink(data.myCode), "link")}
              >
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
              <button
                type="button"
                className="shrink-0 rounded-full border border-brand-line-strong px-2.5 py-1 text-[11.5px] font-medium hover:bg-brand-sunken"
                onClick={() => setShowQr(!showQr)}
              >
                {showQr ? "Hide QR" : "QR"}
              </button>
            </div>
            {showQr && (
              <div className="mt-3 flex flex-col items-center gap-1.5">
                <QrCode
                  value={myLink(data.myCode)}
                  size={184}
                  title="Scan to add me as a pal"
                  className="rounded-lg"
                />
                <span className="text-[11.5px] text-brand-ink4">
                  Point a phone camera at this to open the request.
                </span>
              </div>
            )}
            <p className="mb-0 mt-2 text-[11.5px] leading-[1.5] text-brand-ink4">
              Share this with someone you actually know. Anyone holding it can ask to be your pal —
              you still choose whether to accept.
            </p>
          </>
        ) : (
          <p className="mb-0 text-[12.5px] leading-[1.55] text-brand-ink3">
            Friend codes need a one-time database update — ask the admin to run{" "}
            <code className="font-mono">supabase/migrations/028_friend_codes.sql</code>.
          </p>
        )}
      </div>

      {/* The master switch. Reciprocal: off means you can't send either. */}
      <label className="mt-3 flex items-start gap-2.5 text-[12.5px] leading-[1.5] text-brand-ink3">
        <button
          type="button"
          role="switch"
          aria-checked={data.allowRequests}
          disabled={busy || !data.codesReady}
          onClick={() =>
            call("/api/friends/requests", jsonInit("PATCH", { allowRequests: !data.allowRequests }))
          }
          className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            data.allowRequests ? "bg-brand-accent" : "bg-brand-line-strong"
          }`}
        >
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
              data.allowRequests ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
        <span>
          <b className="font-medium text-brand-ink">Let others add me</b> —{" "}
          {data.allowRequests
            ? "on. Someone with your code can send you a request."
            : "off. Your code won't work for anyone, and you can't send requests either."}
        </span>
      </label>

      <p className="mt-3 text-xs leading-[1.55] text-brand-ink3">
        Pals can see decks you&apos;ve shared &ldquo;pals only&rdquo; and unlock direct messages.
      </p>
    </div>
  );
}
