"use client";

import { useEffect, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import { artSrc } from "@/lib/art";
import { matchesSearch } from "@/lib/text";
import type { CollectionItem, Deck, DeckCardEntry, DeckSuggestion } from "@/lib/types";
import type { CardDetail } from "@/app/api/cards/details/route";
import { FanMark } from "@/components/Logo";
import Modal, { ModalClose, PROSE } from "@/components/Modal";
import Markdown from "@/components/Markdown";
import { CreditLock } from "@/components/CreditLock";
import { useCredits } from "@/components/useCredits";
import { FREE_DECK_LIMIT } from "@/lib/limits";

type UpgradeSuggestion = DeckSuggestion;

/** Asking price for one card, from /api/prices/listings. Mirrors
 *  ListingPrice in lib/ebayListings — kept structural rather than imported
 *  so the client bundle doesn't pull the server-side eBay module in. */
interface EbayAsk {
  low: number;
  median: number;
  count: number;
  currency: string;
  url: string;
}

/** A card in the manual builder's pick list: your collection aggregated by
 *  card name (finishes combined — a deck list doesn't care about holos). */
interface OwnedCard {
  name: string;
  owned: number;
  category: "pokemon" | "trainer" | "energy";
  cardId: string | null;
  image: string | null;
  setName: string;
}

function categoryOf(supertype: string | null | undefined): OwnedCard["category"] {
  if (supertype === "Pokémon" || supertype === "Pokemon") return "pokemon";
  if (supertype === "Energy") return "energy";
  return "trainer";
}

function ManualBuilder({
  onSaved,
  editDeck,
  onEditStarted,
}: {
  onSaved: (deck: Deck) => void;
  editDeck?: Deck | null;
  onEditStarted?: () => void;
}) {
  const credits = useCredits();
  const [open, setOpen] = useState(false);
  const [owned, setOwned] = useState<OwnedCard[] | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [deck, setDeck] = useState<Record<string, number>>({}); // card name → qty
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Editing an existing deck: its id + original record (for suggestions and
  // rebuilding the updated Deck object after a save).
  const [editBase, setEditBase] = useState<Deck | null>(null);

  async function fetchOwned(): Promise<OwnedCard[]> {
    try {
      const res = await fetch("/api/collection");
      const json = await res.json();
      const byName = new Map<string, OwnedCard>();
      for (const it of (json.items ?? []) as CollectionItem[]) {
        if (!it.card) continue;
        const prev = byName.get(it.card.name);
        if (prev) {
          prev.owned += it.quantity;
          if (!prev.image && it.card.image_small) {
            prev.image = artSrc(it.card.id, it.card.image_small);
          }
        } else {
          byName.set(it.card.name, {
            name: it.card.name,
            owned: it.quantity,
            category: categoryOf(it.card.supertype),
            cardId: it.card.id,
            image: artSrc(it.card.id, it.card.image_small),
            setName: it.card.set_name,
          });
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async function openBuilder() {
    setOpen(true);
    if (owned !== null) return;
    setOwned(await fetchOwned());
  }

  // Load a saved deck into the builder for editing.
  useEffect(() => {
    if (!editDeck) return;
    onEditStarted?.();
    void (async () => {
      setOpen(true);
      const list = owned ?? (await fetchOwned());
      // Deck entries missing from the collection list (basic energy the
      // player never scanned, etc.) get merged in so they stay editable.
      const have = new Set(list.map((c) => c.name));
      const merged = [...list];
      for (const e of editDeck.cards ?? []) {
        if (!have.has(e.name)) {
          merged.push({
            name: e.name,
            owned: e.category === "energy" ? 60 : e.quantity,
            category: (e.category as OwnedCard["category"]) ?? "trainer",
            cardId: e.card_id,
            image: null,
            setName: "",
          });
        }
      }
      merged.sort((a, b) => a.name.localeCompare(b.name));
      setOwned(merged);
      setDeck(Object.fromEntries((editDeck.cards ?? []).map((e) => [e.name, e.quantity])));
      setName(editDeck.name);
      setNotes(editDeck.strategy ?? "");
      setEditBase(editDeck);
      setReview(null);
      setError(null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDeck]);

  function maxFor(c: OwnedCard): number {
    // TCG rules: max 4 copies of a card, except basic Energy. We also cap at
    // what you own — except Energy, which the app assumes you have plenty of.
    return c.category === "energy" ? 60 : Math.min(4, c.owned);
  }

  function adjust(c: OwnedCard, delta: number) {
    setDeck((prev) => {
      const next = Math.max(0, Math.min(maxFor(c), (prev[c.name] ?? 0) + delta));
      const copy = { ...prev };
      if (next === 0) delete copy[c.name];
      else copy[c.name] = next;
      return copy;
    });
  }

  function toEntries(): DeckCardEntry[] {
    return (owned ?? [])
      .filter((c) => (deck[c.name] ?? 0) > 0)
      .map((c) => ({
        name: c.name,
        quantity: deck[c.name],
        category: c.category,
        card_id: c.cardId,
        reason: null,
      }));
  }

  const total = Object.values(deck).reduce((s, q) => s + q, 0);
  const entries = (owned ?? []).filter((c) => (deck[c.name] ?? 0) > 0);
  const counts = {
    pokemon: entries.filter((c) => c.category === "pokemon").reduce((s, c) => s + deck[c.name], 0),
    trainer: entries.filter((c) => c.category === "trainer").reduce((s, c) => s + deck[c.name], 0),
    energy: entries.filter((c) => c.category === "energy").reduce((s, c) => s + deck[c.name], 0),
  };

  async function askReview() {
    if (total === 0 || reviewing) return;
    setReviewing(true);
    setReview(null);
    setError(null);
    try {
      const res = await fetch("/api/decks/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cards: toEntries(), question }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Review failed");
      setReview(json.answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed");
    }
    setReviewing(false);
  }

  async function save() {
    if (!name.trim() || total === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const cards = toEntries();
      if (editBase) {
        // Update the existing deck in place.
        const res = await fetch(`/api/decks/${editBase.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), strategy: notes.trim() || null, cards }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Couldn't save the deck");
        const inDeck = new Set(cards.map((c) => c.name.toLowerCase()));
        onSaved({
          ...editBase,
          name: name.trim(),
          strategy: notes.trim() || null,
          cards,
          suggestions: (editBase.suggestions ?? []).filter(
            (s) => !inDeck.has(s.name.toLowerCase())
          ),
        });
      } else {
        const res = await fetch("/api/decks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), strategy: notes.trim() || null, cards }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Couldn't save the deck");
        onSaved(json.deck);
      }
      setDeck({});
      setName("");
      setNotes("");
      setReview(null);
      setEditBase(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the deck");
    }
    setSaving(false);
  }

  const filtered = (owned ?? [])
    .filter((c) => matchesSearch(search, c.name, c.setName))
    .slice(0, 60);

  return (
    <div className="card-panel p-4" id="manual-builder">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">
            {editBase ? `✏️ Editing “${editBase.name}”` : "🛠 Build your own deck"}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {editBase
              ? "Swap cards in and out, then Save — the deck updates in place."
              : `Pick cards from your collection yourself — with optional ${AI_NAME} review while you build.`}
          </p>
        </div>
        <button
          className="btn-secondary shrink-0 text-sm"
          onClick={() => {
            if (open) {
              setOpen(false);
              if (editBase) {
                setEditBase(null);
                setDeck({});
                setName("");
                setNotes("");
              }
            } else {
              openBuilder();
            }
          }}
        >
          {open ? (editBase ? "Cancel edit" : "Close") : "Open builder"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <input
            className="input"
            placeholder="Deck name (e.g. My Fire Deck)"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          {editBase &&
            (editBase.suggestions?.length ?? 0) > 0 &&
            owned &&
            (() => {
              // Wishlist cards the player has since acquired: one tap to swap in.
              const swappable = editBase.suggestions!.filter((s) => {
                const c = owned.find((o) => o.name.toLowerCase() === s.name.toLowerCase());
                return c && c.owned > 0 && (deck[c.name] ?? 0) < maxFor(c);
              });
              if (swappable.length === 0) return null;
              return (
                <div className="rounded-lg bg-green-50 p-2 text-xs text-green-800">
                  <b>✅ Wishlist cards you now own — tap to add:</b>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {swappable.map((s) => {
                      const c = owned.find(
                        (o) => o.name.toLowerCase() === s.name.toLowerCase()
                      )!;
                      const addable = Math.min(
                        s.quantity,
                        maxFor(c) - (deck[c.name] ?? 0)
                      );
                      return (
                        <button
                          key={s.name}
                          className="chip bg-white text-green-800 hover:bg-green-100"
                          onClick={() => adjust(c, addable)}
                        >
                          + {c.name} ×{addable}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-green-700">
                    Then remove what they replace so the deck stays at 60.
                  </p>
                </div>
              );
            })()}

          {/* Current deck */}
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="mb-1 flex items-center justify-between text-sm font-semibold">
              <span>
                Deck: {total}/60{" "}
                {total === 60 ? "✅" : total > 60 ? "⚠️ over 60" : ""}
              </span>
              <span className="text-xs font-normal text-slate-500">
                {counts.pokemon} Pokémon · {counts.trainer} Trainer · {counts.energy} Energy
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="text-xs text-slate-400">Tap cards below to add them.</p>
            ) : (
              <ul className="space-y-1">
                {(["pokemon", "trainer", "energy"] as const).map((cat) =>
                  entries
                    .filter((c) => c.category === cat)
                    .map((c) => (
                      <li key={c.name} className="flex items-center gap-2 text-sm">
                        <button
                          aria-label={`Remove one ${c.name}`}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 hover:bg-red-100"
                          onClick={() => adjust(c, -1)}
                        >
                          −
                        </button>
                        <button
                          aria-label={`Add one ${c.name}`}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-40"
                          disabled={deck[c.name] >= maxFor(c)}
                          onClick={() => adjust(c, 1)}
                        >
                          +
                        </button>
                        <span className="truncate">
                          {deck[c.name]}x {c.name}
                        </span>
                      </li>
                    ))
                )}
              </ul>
            )}
          </div>

          {/* Picker */}
          <div>
            <input
              className="input mb-2"
              placeholder="🔍 Search your collection…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {owned === null ? (
              <p className="text-sm text-slate-400">Loading your collection…</p>
            ) : (
              <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
                {filtered.map((c) => {
                  const inDeck = deck[c.name] ?? 0;
                  return (
                    <li key={c.name} className="flex items-center gap-2 p-1.5">
                      <div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-slate-100">
                        {c.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{c.name}</div>
                        <div className="text-[11px] text-slate-400">
                          {c.category} · you own x{c.owned}
                          {c.category === "energy" ? " (energy is unlimited)" : ""}
                        </div>
                      </div>
                      <button
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                          inDeck > 0
                            ? "bg-green-100 text-green-700"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                        disabled={inDeck >= maxFor(c)}
                        onClick={() => adjust(c, 1)}
                      >
                        {inDeck > 0 ? `${inDeck} in deck` : "+ Add"}
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="p-2 text-xs text-slate-400">No cards match.</li>
                )}
              </ul>
            )}
            <p className="mt-1 text-[11px] text-slate-400">
              Max 4 copies per card (except Energy). Aim for 60 cards.
            </p>
          </div>

          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            placeholder="Notes / strategy (optional — saved with the deck)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {/* AI review */}
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex gap-2">
              <input
                className="input text-sm"
                placeholder={`Optional question for ${AI_NAME} (e.g. "what should I add next?")`}
                maxLength={2000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              {credits.empty ? (
                <CreditLock plan={credits.credits?.plan} label="Out of credits" />
              ) : (
                <button
                  className="btn-secondary shrink-0 text-sm"
                  disabled={reviewing || total === 0}
                  onClick={askReview}
                >
                  {reviewing ? "Reviewing…" : `🤖 Review`}
                </button>
              )}
            </div>
            {review && (
              <div className="mt-2 rounded bg-slate-50 p-2 text-sm leading-[1.6] text-slate-700">
                <Markdown text={review} />
              </div>
            )}
          </div>

          {total >= 7 && <HandSimulator getCards={toEntries} />}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              className="btn-primary"
              disabled={saving || !name.trim() || total === 0}
              onClick={save}
            >
              {saving ? "Saving…" : "Save deck"}
            </button>
            {total !== 60 && total > 0 && (
              <span className="self-center text-xs text-slate-400">
                (you can save at any size — 60 is tournament-legal)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CoachBox({ deck }: { deck: { name: string; strategy: string | null; cards: DeckCardEntry[] } }) {
  const credits = useCredits();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await fetch("/api/decks/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck, question }),
      });
      const json = await res.json();
      setAnswer(res.ok ? json.answer : json.error || "Something went wrong");
    } catch {
      setAnswer("Something went wrong — try again.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-semibold text-slate-500">
        🎓 Ask {AI_NAME} about this deck — how to pilot it, opening plays, rules, matchups
      </p>
      <div className="flex gap-2">
        <input
          className="input text-sm"
          placeholder='e.g. "What do I search for first turn?" or "How do I beat water decks?"'
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
        />
        {credits.empty ? (
          <CreditLock plan={credits.credits?.plan} label="Out of credits" />
        ) : (
          <button className="btn-secondary shrink-0 text-sm" onClick={ask} disabled={asking}>
            {asking ? "Thinking…" : "Ask"}
          </button>
        )}
      </div>
      {asking && (
        <p className="mt-2 animate-pulse text-xs text-slate-400">
          {AI_NAME} is thinking about your deck…
        </p>
      )}
      {answer && (
        <div className="mt-2 rounded bg-white p-3 text-sm leading-[1.6] text-slate-700 shadow-sm">
          <Markdown text={answer} />
        </div>
      )}
    </div>
  );
}

interface BuiltDeck {
  name: string;
  strategy: string;
  cards: DeckCardEntry[];
  missing_suggestions: UpgradeSuggestion[];
}

/** Wishlist of unowned cards that would strengthen the deck. */
/** Turn suggestions into the shape ensureImages looks cards up by, so the
 *  "cards to buy" pictures come from the same cache the deck list uses. */
function suggestionLookups(suggestions: UpgradeSuggestion[]): DeckCardEntry[] {
  return suggestions.map((u) => ({
    name: u.name,
    quantity: u.quantity,
    category: "trainer" as const,
    card_id: u.card?.id ?? null,
    reason: null,
  }));
}

function UpgradeList({
  suggestions,
  cardImages,
  nameImages,
}: {
  suggestions: UpgradeSuggestion[];
  /** The same maps the deck list uses. A suggestion only carries a resolved
   *  `card` when the AI's name matched a card record at save time; without
   *  these it fell back to a "?" tile forever, even for cards sitting in the
   *  database under a slightly different name. */
  cardImages?: Record<string, string | null>;
  nameImages?: Record<string, string | null>;
}) {
  const total = suggestions.reduce(
    (s, u) => s + (u.card?.marketPrice ?? 0) * u.quantity,
    0
  );

  // Live eBay asking prices for the cards being recommended. An ask is the
  // wrong number for "what is my card worth" and the right one for "what
  // will this cost me", which is the only question this panel asks.
  const [asks, setAsks] = useState<Record<string, EbayAsk | null>>({});
  useEffect(() => {
    if (suggestions.length === 0) return;
    let live = true;
    fetch("/api/prices/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cards: suggestions.slice(0, 12).map((u) => ({
          name: u.name,
          number: u.card?.number ?? null,
          setName: u.card?.setName ?? null,
        })),
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j?.prices) setAsks(j.prices);
      })
      // Silent: a missing price line is invisible, a broken buy-list is not.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [suggestions]);

  const imageFor = (u: UpgradeSuggestion) =>
    u.card?.imageSmall ??
    (u.card?.id ? cardImages?.[u.card.id] : null) ??
    nameImages?.[u.name] ??
    null;
  return (
    <div className="mt-3 rounded-lg bg-amber-50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-bold text-amber-900">💪 Cards to buy for a stronger deck</span>
        {total > 0 && (
          <span className="text-xs font-semibold text-amber-800">
            upgrade cost: ~${total.toFixed(2)}
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {suggestions.map((u, i) => {
          const image = imageFor(u);
          return (
          <li key={i} className="flex gap-2">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt={u.name}
                loading="lazy"
                className="aspect-[63/88] w-12 shrink-0 self-start rounded object-cover"
              />
            ) : (
              // Still nothing: say which card is missing a picture rather
              // than showing an anonymous "?" — it reads as broken.
              <div
                className="flex aspect-[63/88] w-12 shrink-0 items-center justify-center self-start rounded bg-amber-100 p-1 text-center text-[8px] leading-tight text-amber-700"
                title={`No picture on file for ${u.name}`}
              >
                {u.name}
              </div>
            )}
            <div className="min-w-0 text-xs text-amber-900">
              <div className="font-semibold">
                {u.quantity}× {u.name}
                {u.card?.marketPrice != null && (
                  <span className="ml-1 font-normal text-amber-700">
                    (~${(u.card.marketPrice * u.quantity).toFixed(2)})
                  </span>
                )}
                {u.card && (
                  <span className="ml-1 font-normal text-amber-600">· {u.card.setName}</span>
                )}
              </div>
              <div className="mt-0.5 text-amber-800">{u.reason}</div>
              {asks[u.name] && (
                <div className="mt-1 text-amber-800">
                  eBay: from{" "}
                  <span className="font-semibold">${asks[u.name]!.low.toFixed(2)}</span>
                  {asks[u.name]!.count >= 3 && (
                    <> · typically ${asks[u.name]!.median.toFixed(2)}</>
                  )}{" "}
                  <a
                    href={asks[u.name]!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {asks[u.name]!.count} listed
                  </a>
                  {/* Said once per card rather than once per panel: someone
                      scanning a single row shouldn't have to find a footnote
                      to know this is an ask, not a sale. */}
                  <span className="text-amber-600"> (asking, incl. shipping)</span>
                </div>
              )}
              {(u.owners?.length ?? 0) > 0 && (
                <div className="mt-1 rounded bg-white/60 px-1.5 py-1 font-medium text-green-800">
                  🤝 Trade before you buy:{" "}
                  {u.owners!.map((o) => `${o.name} has ${o.qty}`).join(" · ")} —{" "}
                  <a href="/friends" className="underline">
                    propose a trade
                  </a>
                </div>
              )}
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Parse a response body defensively — an empty/cut-off reply becomes a
 *  friendly error instead of "Unexpected end of JSON input". */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      res.ok
        ? "The server sent an incomplete reply — please try again."
        : `Request failed (${res.status}) — please try again.`
    );
  }
}

const BUILD_STEPS = [
  `${AI_NAME} is reading your collection…`,
  "Choosing a win condition…",
  "Picking attackers and support…",
  "Balancing trainers and energy…",
  "Writing up the strategy…",
  "Still working — big collections take a few minutes…",
];

/** What each format actually means, shown under the picker. "Standard" and
 *  "Expanded" are tournament jargon a newer player has no reason to know,
 *  and the native <select> can't explain its own options. */
const FORMAT_NOTES: Record<string, string> = {
  any: "🃏 Anything goes: every card you own is allowed. The format for playing with friends at home.",
  standard:
    "🏆 Standard: only cards from recent sets — what official tournaments play. Older cards rotate out each year, so some of your collection may be excluded.",
  expanded:
    "📚 Expanded: the bigger official format — recent sets plus older ones going back to Black & White (2011). More of your collection is legal here.",
};

/** The in-flight build's ticket, persisted so a page refresh (or Safari
 *  reloading a backgrounded tab) can resume watching the same build. */
const JOB_STORAGE_KEY = "pokedeck-build-job";

export default function DecksPage() {
  const credits = useCredits();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [styleNotes, setStyleNotes] = useState("");
  const [styleSaved, setStyleSaved] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("any");
  const [editRequest, setEditRequest] = useState<Deck | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
  const [built, setBuilt] = useState<BuiltDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Deck | null>(null);
  // card_id → image url, for showing real card pictures in deck lists
  const [cardImages, setCardImages] = useState<Record<string, string | null>>({});
  // name → image url, fallback for entries that never matched a card id
  // (e.g. "Basic Fighting Energy" while the card record says "Fighting Energy")
  const [nameImages, setNameImages] = useState<Record<string, string | null>>({});
  // The card whose text is open, and the text we've fetched so far.
  const [reading, setReading] = useState<DeckCardEntry | null>(null);
  const [details, setDetails] = useState<Record<string, CardDetail>>({});
  const [readingBusy, setReadingBusy] = useState(false);

  /** Key a card's text by its id when it has one, and by name otherwise —
   *  the same split the images lookup uses for deck entries that never
   *  matched a card record. */
  const detailKey = (c: DeckCardEntry) => c.card_id ?? `name:${c.name}`;

  async function openCard(card: DeckCardEntry) {
    setReading(card);
    if (details[detailKey(card)]) return;
    setReadingBusy(true);
    try {
      const params = new URLSearchParams();
      if (card.card_id) params.set("ids", card.card_id);
      else params.set("names", card.name);
      const res = await fetch(`/api/cards/details?${params.toString()}`);
      const json = await res.json();
      if (res.ok) {
        const found: CardDetail | undefined = card.card_id
          ? json.byId?.[card.card_id]
          : json.byName?.[card.name];
        if (found) setDetails((prev) => ({ ...prev, [detailKey(card)]: found }));
      }
    } catch {
      // Leave it unresolved; the sheet says so rather than pretending.
    }
    setReadingBusy(false);
  }

  async function ensureImages(cards: DeckCardEntry[]) {
    const wanted = [
      ...new Set(
        cards
          .map((c) => c.card_id)
          .filter((id): id is string => !!id && !(id in cardImages))
      ),
    ];
    const wantedNames = [
      ...new Set(cards.filter((c) => !c.card_id && !(c.name in nameImages)).map((c) => c.name)),
    ];
    if (wanted.length === 0 && wantedNames.length === 0) return;
    try {
      const params = new URLSearchParams();
      if (wanted.length > 0) params.set("ids", wanted.join(","));
      if (wantedNames.length > 0) params.set("names", wantedNames.join(","));
      const res = await fetch(`/api/cards/images?${params.toString()}`);
      const json = await res.json();
      if (res.ok) {
        setCardImages((prev) => ({ ...prev, ...json.images }));
        setNameImages((prev) => ({ ...prev, ...(json.imagesByName ?? {}) }));
      }
    } catch {}
  }

  useEffect(() => {
    // Suggestions as well as the deck itself: "cards to buy" are by
    // definition cards you don't own, so they were never in the lookup and
    // every one of them rendered as a placeholder.
    if (built) {
      ensureImages([...built.cards, ...suggestionLookups(built.missing_suggestions ?? [])]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built]);

  useEffect(() => {
    if (viewing) {
      ensureImages([...(viewing.cards ?? []), ...suggestionLookups(viewing.suggestions ?? [])]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  useEffect(() => {
    // Surface load failures loudly — a failed fetch must never look like an
    // empty (or wiped) deck collection.
    fetch("/api/decks")
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || "load failed");
        setDecks(j.decks ?? []);
      })
      .catch((e) => {
        const detail = e instanceof Error ? e.message : "load failed";
        setError(
          /recursion/i.test(detail)
            ? "Your decks are NOT gone — the database needs a one-time fix. Ask the admin to run supabase/migrations/022_fix_deck_recursion.sql."
            : `Couldn't load your decks just now — they are NOT gone. (${detail}) Refresh in a moment.`
        );
      });
    fetch("/api/profile")
      .then((r) => r.json())
      .then((j) => setStyleNotes(j.styleNotes ?? ""));

    // Resume watching an in-flight build after a refresh / tab reload.
    try {
      const raw = localStorage.getItem(JOB_STORAGE_KEY);
      if (raw) {
        const { jobId, started } = JSON.parse(raw) as { jobId: string; started: number };
        if (jobId && Date.now() - started < 20 * 60_000) {
          pollUntilDone(jobId);
        } else {
          localStorage.removeItem(JOB_STORAGE_KEY);
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveStyle() {
    await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styleNotes }),
    });
    setStyleSaved(true);
    setTimeout(() => setStyleSaved(false), 2000);
  }

  /** Watch a build job until it finishes (works for fresh builds and for
   *  builds resumed after a page refresh). */
  async function pollUntilDone(jobId: string) {
    setBuilding(true);
    setBuildStep(0);
    setError(null);
    const stepTimer = setInterval(
      () => setBuildStep((s) => Math.min(s + 1, BUILD_STEPS.length - 1)),
      15000
    );
    try {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const poll = await fetch(`/api/decks/build?job=${encodeURIComponent(jobId)}`);
        const status = await safeJson(poll);
        if (!poll.ok) throw new Error((status.error as string) || "Deck build failed");
        if (status.status === "done") {
          setBuilt(status.deck as unknown as BuiltDeck);
          return;
        }
        if (status.status === "error") {
          throw new Error((status.error as string) || "Deck build failed");
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("The build is taking unusually long — please try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deck build failed");
    } finally {
      clearInterval(stepTimer);
      setBuilding(false);
      try {
        localStorage.removeItem(JOB_STORAGE_KEY);
      } catch {}
    }
  }

  async function build() {
    setError(null);
    setBuilt(null);
    setBuilding(true);
    try {
      // Start the build as a background job (deck builds can outlast proxy
      // request timeouts), remember the ticket, then poll until done.
      const res = await fetch("/api/decks/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, format }),
      });
      const start = await safeJson(res);
      if (!res.ok) throw new Error((start.error as string) || "Deck build failed");
      const jobId = start.jobId as string;
      try {
        localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify({ jobId, started: Date.now() }));
      } catch {}
      await pollUntilDone(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deck build failed");
      setBuilding(false);
    }
  }

  async function saveDeck() {
    if (!built) return;
    const res = await fetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: built.name,
        strategy: built.strategy,
        cards: built.cards,
        suggestions: built.missing_suggestions ?? [],
      }),
    });
    const json = await res.json();
    if (res.ok) {
      setDecks((prev) => [json.deck, ...prev]);
      setBuilt(null);
      setPrompt("");
    }
  }

  async function deleteDeck(id: string) {
    if (!confirm("Delete this deck?")) return;
    await fetch(`/api/decks/${id}`, { method: "DELETE" });
    setDecks((prev) => prev.filter((d) => d.id !== id));
    setViewing(null);
  }

  async function setDeckSharing(deck: Deck, mode: "off" | "everyone" | "friends") {
    const body =
      mode === "off"
        ? { shared: false }
        : { shared: true, shareScope: mode };
    const res = await fetch(`/api/decks/${deck.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Couldn't update sharing");
      return;
    }
    const patch: Partial<Deck> = {
      shared: mode !== "off",
      share_scope: mode === "friends" ? "friends" : "everyone",
    };
    setDecks((prev) => prev.map((d) => (d.id === deck.id ? { ...d, ...patch } : d)));
    setViewing((v) => (v && v.id === deck.id ? { ...v, ...patch } : v));
  }

  const groupCards = (cards: DeckCardEntry[]) => ({
    pokemon: cards.filter((c) => c.category === "pokemon"),
    trainer: cards.filter((c) => c.category === "trainer"),
    energy: cards.filter((c) => c.category === "energy"),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Decks</h1>
        <p className="text-sm text-slate-500">
          Build battle-ready decks from the cards you actually own.
        </p>
      </div>

      {/* Play style profile */}
      <div className="card-panel p-4">
        <h2 className="font-semibold">🎮 Your play style</h2>
        <p className="mb-2 mt-0.5 text-xs text-slate-500">
          Tell {AI_NAME} how you like to play — aggressive, defensive, favorite Pokémon, combos you
          love, your experience level. It uses this to tailor every deck it builds for you.
        </p>
        <textarea
          className="input min-h-24"
          placeholder="e.g. I like fast aggressive decks that hit hard early. Fire types are my favorite. I'm still learning, so keep combos simple."
          value={styleNotes}
          onChange={(e) => setStyleNotes(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-3">
          <button className="btn-secondary text-sm" onClick={saveStyle}>
            Save profile
          </button>
          {styleSaved && <span className="text-sm text-green-600">Saved ✓</span>}
        </div>
      </div>

      {/* Builder */}
      <div className="card-panel p-4">
        <h2 className="font-semibold">🤖 Build a deck with {AI_NAME}</h2>
        <p className="mb-2 mt-0.5 text-xs text-slate-500">
          {AI_NAME} looks at your whole collection and builds a legal 60-card deck. Basic energy
          is assumed — no need to scan energy cards. Can take a minute.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder='e.g. "an aggressive fire deck" or leave blank for the best deck possible'
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !building && build()}
          />
          <div className="flex shrink-0 gap-2">
            <select
              className="input w-auto text-sm"
              title="Tournament format — filters which of your cards are allowed"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="any">🃏 Anything goes</option>
              <option value="standard">🏆 Standard</option>
              <option value="expanded">📚 Expanded</option>
            </select>
            {credits.empty ? (
              <CreditLock plan={credits.credits?.plan} label="Out of credits to build" />
            ) : (
              <button className="btn-primary shrink-0" onClick={build} disabled={building}>
                {building ? "Building…" : "Build deck"}
              </button>
            )}
          </div>
        </div>
        {/* Spell the chosen format out — "Standard" and "Expanded" are
            tournament jargon, and a native <select> can't carry
            descriptions on its options. */}
        <p className="mb-0 mt-1.5 text-xs text-slate-500">{FORMAT_NOTES[format] ?? ""}</p>
        {building && (
          <div className="mt-2 flex items-center gap-2">
            <FanMark size={16} className="animate-spin-slow shrink-0" />
            <p className="animate-pulse text-sm text-slate-500">{BUILD_STEPS[buildStep]}</p>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        {built && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">{built.name}</h3>
                <p className="text-xs text-slate-500">
                  {built.cards.reduce((s, c) => s + c.quantity, 0)} cards
                </p>
              </div>
              <div className="flex gap-2">
                {credits.freeTier && decks.length >= FREE_DECK_LIMIT ? (
                  <a
                    className="btn-secondary text-sm"
                    href="/pricing"
                    title={`Free accounts keep up to ${FREE_DECK_LIMIT} saved decks — upgrade for unlimited`}
                  >
                    🔒 Deck limit — upgrade
                  </a>
                ) : (
                  <button className="btn-primary text-sm" onClick={saveDeck}>
                    Save deck
                  </button>
                )}
                <button className="btn-secondary text-sm" onClick={() => setBuilt(null)}>
                  Discard
                </button>
              </div>
            </div>
            <Markdown
              text={built.strategy}
              className="mt-2 text-sm leading-[1.6] text-slate-700"
            />
            <DeckList cards={built.cards} />
            {built.missing_suggestions?.length > 0 && (
              <UpgradeList
                suggestions={built.missing_suggestions}
                cardImages={cardImages}
                nameImages={nameImages}
              />
            )}
            <CoachBox deck={{ name: built.name, strategy: built.strategy, cards: built.cards }} />
          </div>
        )}
      </div>

      {/* Manual builder (also used to edit any saved deck) */}
      <ManualBuilder
        onSaved={(d) =>
          setDecks((prev) =>
            prev.some((x) => x.id === d.id) ? prev.map((x) => (x.id === d.id ? d : x)) : [d, ...prev]
          )
        }
        editDeck={editRequest}
        onEditStarted={() => setEditRequest(null)}
      />

      {/* Saved decks */}
      <div>
        <h2 className="mb-2 font-semibold">Saved decks</h2>
        {credits.freeTier && (
          <p className="mb-2 text-xs text-slate-500">
            Free accounts keep up to {FREE_DECK_LIMIT} saved decks (
            {Math.min(decks.length, FREE_DECK_LIMIT)} of {FREE_DECK_LIMIT} used).{" "}
            <a className="underline" href="/pricing">
              Upgrade
            </a>{" "}
            for unlimited decks and deck sharing.
          </p>
        )}
        {decks.length === 0 ? (
          <p className="text-sm text-slate-400">No decks yet — build one above!</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {decks.map((deck) => (
              <button
                key={deck.id}
                className="card-panel p-4 text-left hover:shadow-md"
                onClick={() => setViewing(deck)}
              >
                <div className="font-bold">
                  {deck.name}
                  {deck.shared && (
                    <span className="ml-2 chip bg-green-100 text-green-700">
                      {deck.share_scope === "friends" ? "🤝 Pals only" : "Shared"}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {(deck.cards ?? []).reduce((s, c) => s + c.quantity, 0)} cards ·{" "}
                  {new Date(deck.created_at).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {viewing && (
        <Modal onClose={() => setViewing(null)} size="xl" labelledBy="deck-modal-title">
          <>
            {/* Title row always fits; actions wrap onto their own line on phones */}
            <div className="flex items-start justify-between gap-2">
              <h2
                id="deck-modal-title"
                className="min-w-0 break-words font-display text-xl font-bold"
              >
                {viewing.name}
              </h2>
              <ModalClose onClose={() => setViewing(null)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                className="btn text-sm text-poke-blue hover:bg-poke-blue/10"
                title="Swap cards in and out of this deck"
                onClick={() => {
                  setEditRequest(viewing);
                  setViewing(null);
                  setTimeout(
                    () => document.getElementById("manual-builder")?.scrollIntoView({ behavior: "smooth" }),
                    50
                  );
                }}
              >
                ✏️ Edit
              </button>
              {credits.freeTier ? (
                <a
                  className="self-center whitespace-nowrap text-xs text-slate-500 underline"
                  href="/pricing"
                  title="Deck sharing is part of the paid plans"
                >
                  🔒 Sharing: paid plans
                </a>
              ) : (
                <select
                  className="input w-auto py-1.5 text-sm"
                  title="Who can see this deck on the Friends page"
                  value={viewing.shared ? (viewing.share_scope === "friends" ? "friends" : "everyone") : "off"}
                  onChange={(e) =>
                    setDeckSharing(viewing, e.target.value as "off" | "everyone" | "friends")
                  }
                >
                  <option value="off">🔒 Not shared</option>
                  <option value="everyone">🌍 Everyone</option>
                  <option value="friends">🤝 Pals only</option>
                </select>
              )}
              <button
                className="btn text-sm text-red-600 hover:bg-red-50"
                onClick={() => deleteDeck(viewing.id)}
              >
                Delete
              </button>
            </div>
            {!credits.freeTier && <DeckDirectShares deckId={viewing.id} />}

            {/* Two columns once there's room for them. Everything used to be
                one stack, so on a wide screen the write-up ran as a narrow
                ribbon and the card list sat a full screen below it. The cards
                are the deck, so they take the wider column; the write-up and
                the tools sit beside them, and the prose keeps a readable
                measure instead of stretching to fill. */}
            <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <DeckList cards={viewing.cards ?? []} />
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                {viewing.strategy && (
                  <Markdown
                    text={viewing.strategy}
                    className={`${PROSE} text-sm leading-[1.6] text-brand-ink2`}
                  />
                )}
                {(viewing.suggestions?.length ?? 0) > 0 && (
                  <UpgradeList
                    suggestions={viewing.suggestions!}
                    cardImages={cardImages}
                    nameImages={nameImages}
                  />
                )}
                <HandSimulator getCards={() => viewing.cards ?? []} />
                <CoachBox
                  deck={{
                    name: viewing.name,
                    strategy: viewing.strategy,
                    cards: viewing.cards ?? [],
                  }}
                />
              </div>
            </div>
          </>
        </Modal>
      )}

      <CardReader />
    </div>
  );

  function DeckList({ cards }: { cards: DeckCardEntry[] }) {
    const groups = groupCards(cards);
    return (
      <div className="mt-3 space-y-4">
        {(["pokemon", "trainer", "energy"] as const).map(
          (cat) =>
            groups[cat].length > 0 && (
              <div key={cat}>
                <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                  {cat} ({groups[cat].reduce((s, c) => s + c.quantity, 0)})
                </h4>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-7">
                  {groups[cat].map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className="text-left"
                      title={c.reason ?? `Read what ${c.name} does`}
                      onClick={() => openCard(c)}
                    >
                      <div className="relative">
                        {(c.card_id && cardImages[c.card_id]) || nameImages[c.name] ? (
                          <div className="aspect-[63/88] w-full overflow-hidden rounded">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={(c.card_id ? cardImages[c.card_id] : null) ?? nameImages[c.name]!}
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
                    </button>
                  ))}
                </div>
              </div>
            )
        )}
      </div>
    );
  }

  /** Reading a card from a deck list. Scrolls the whole overlay rather than
   *  a fixed panel, which is what keeps it on screen on a phone. */
  function CardReader() {
    if (!reading) return null;
    const d = details[detailKey(reading)];
    const image = (reading.card_id ? cardImages[reading.card_id] : null) ?? nameImages[reading.name] ?? d?.image;
    const kind = [d?.stage, d?.trainerType, d?.supertype].find(Boolean) ?? reading.category;
    const nothing = d && d.attacks.length === 0 && d.abilities.length === 0 && d.rules.length === 0;
    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4"
        onClick={() => setReading(null)}
      >
        <div
          className="mx-auto my-4 w-full max-w-[min(46rem,94vw)] rounded-xl bg-white p-4 shadow-xl sm:p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex items-start gap-3">
            {image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt={reading.name} className="w-24 shrink-0 rounded-lg shadow-sm" />
            )}
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-lg font-bold">{d?.name ?? reading.name}</h2>
              <p className="text-xs text-slate-500">
                {[kind, d?.hp ? `${d.hp} HP` : null, (d?.types ?? []).join("/") || null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {d?.setName && (
                <p className="text-[11px] text-slate-400">
                  {d.setName}
                  {d.number ? ` · #${d.number}` : ""}
                  {d.rarity ? ` · ${d.rarity}` : ""}
                </p>
              )}
              <p className="mt-0.5 text-[11px] text-slate-400">×{reading.quantity} in this deck</p>
            </div>
            <button
              className="shrink-0 text-xl leading-none text-slate-400 hover:text-slate-700"
              onClick={() => setReading(null)}
            >
              ✕
            </button>
          </div>

          {reading.reason && (
            <p className="mb-3 rounded-lg bg-poke-blue/5 p-2 text-xs text-slate-600">
              <b>Why it&apos;s here:</b> {reading.reason}
            </p>
          )}

          {readingBusy && !d && <p className="text-sm text-slate-400">Looking up the card…</p>}

          {d && (
            <div className="space-y-3">
              {d.abilities.map((a) => (
                <div key={a.name}>
                  <p className="text-sm font-semibold">
                    <span className="mr-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">
                      Ability
                    </span>
                    {a.name}
                  </p>
                  <p className="text-sm leading-relaxed text-slate-700">{a.text}</p>
                </div>
              ))}
              {d.attacks.map((a, i) => (
                <div key={i}>
                  <p className="flex items-baseline justify-between gap-2 text-sm font-semibold">
                    <span>
                      {a.cost.filter((c) => c.toLowerCase() !== "free").length > 0 && (
                        <span className="mr-1 text-slate-400">
                          {"⚡".repeat(a.cost.filter((c) => c.toLowerCase() !== "free").length)}
                        </span>
                      )}
                      {a.name}
                    </span>
                    <span className="shrink-0 text-slate-500">{a.damage || "—"}</span>
                  </p>
                  {a.text && <p className="text-sm leading-relaxed text-slate-700">{a.text}</p>}
                </div>
              ))}
              {d.rules.map((r, i) => (
                <p key={i} className="text-sm leading-relaxed text-slate-700">
                  {r}
                </p>
              ))}
              {nothing && (
                <p className="text-sm text-slate-500">
                  No printed text on file for this one yet. Basic Energy has none; for anything
                  else it fills in the first time the card is used in a battle or picked up by the
                  nightly refresh.
                </p>
              )}
            </div>
          )}

          {!readingBusy && !d && (
            <p className="text-sm text-slate-500">
              Couldn&apos;t find this card in the database, so there&apos;s no text to show.
            </p>
          )}
        </div>
      </div>
    );
  }
}

/** Owner-side controls for sharing a deck with one specific pal, on top of
 *  the Not-shared / Everyone / Pals-only scope. */
function DeckDirectShares({ deckId }: { deckId: string }) {
  const [shares, setShares] = useState<Array<{ userId: string; name: string }>>([]);
  const [pals, setPals] = useState<Array<{ userId: string; name: string }>>([]);
  const [available, setAvailable] = useState(true);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/decks/${deckId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setShares(j.shares ?? []);
        if (j.migrated === false) setAvailable(false);
      })
      .catch(() => {});
    fetch("/api/friends/requests")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        if (j.migrated === false) setAvailable(false);
        setPals((j.pals ?? []).map((p: { userId: string; name: string }) => ({ userId: p.userId, name: p.name })));
      })
      .catch(() => {});
  }, [deckId]);

  async function update(body: Record<string, string>) {
    setBusy(true);
    await fetch(`/api/decks/${deckId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
    const res = await fetch(`/api/decks/${deckId}`).catch(() => null);
    if (res?.ok) {
      const j = await res.json();
      setShares(j.shares ?? []);
    }
    setBusy(false);
  }

  if (!available || (pals.length === 0 && shares.length === 0)) return null;
  const options = pals.filter((p) => !shares.some((s) => s.userId === p.userId));

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <span>Also shared with:</span>
      {shares.length === 0 && <span className="text-slate-400">nobody specific</span>}
      {shares.map((s) => (
        <span key={s.userId} className="chip flex items-center gap-1 bg-poke-blue/10 text-poke-blue">
          {s.name}
          <button
            aria-label={`Stop sharing with ${s.name}`}
            disabled={busy}
            onClick={() => update({ removeShareUserId: s.userId })}
          >
            ✕
          </button>
        </span>
      ))}
      {options.length > 0 && (
        <select
          className="input w-auto py-1 text-xs"
          value={pick}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            setPick("");
            if (v) update({ addShareUserId: v });
          }}
        >
          <option value="">+ share with a pal…</option>
          {options.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** 🎲 Deal thousands of simulated opening hands from a deck list — instant,
 *  free, and brutally honest about how the deck actually starts. */
function HandSimulator({ getCards }: { getCards: () => DeckCardEntry[] }) {
  interface SimResult {
    trials: number;
    mulliganPct: number;
    withDrawPct: number;
    withEnergyPct: number;
    dreamStartPct: number;
    issues: string[];
  }
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/decks/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: getCards() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Simulation failed");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    }
    setBusy(false);
  }

  const pct = (n: number) => `${n.toFixed(0)}%`;
  const grade = (n: number, goodBelow: number, badAbove: number, invert = false) => {
    const v = invert ? 100 - n : n;
    return v <= goodBelow ? "text-green-700" : v >= badAbove ? "text-red-600" : "text-amber-700";
  };

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">🎲 Opening hands</span>
        <button className="btn-secondary text-xs" disabled={busy} onClick={run}>
          {busy ? "Dealing…" : result ? "Deal again" : "Test 2,000 opening hands"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {result && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded bg-slate-50 p-2 text-center">
              <div className={`text-lg font-bold ${grade(result.mulliganPct, 12, 20)}`}>
                {pct(result.mulliganPct)}
              </div>
              <div className="text-[10px] text-slate-500">mulligans</div>
            </div>
            <div className="rounded bg-slate-50 p-2 text-center">
              <div className={`text-lg font-bold ${grade(result.withDrawPct, 40, 65, true)}`}>
                {pct(result.withDrawPct)}
              </div>
              <div className="text-[10px] text-slate-500">start with draw/search</div>
            </div>
            <div className="rounded bg-slate-50 p-2 text-center">
              <div className={`text-lg font-bold ${grade(result.withEnergyPct, 30, 60, true)}`}>
                {pct(result.withEnergyPct)}
              </div>
              <div className="text-[10px] text-slate-500">start with energy</div>
            </div>
            <div className="rounded bg-slate-50 p-2 text-center">
              <div className={`text-lg font-bold ${grade(result.dreamStartPct, 55, 75, true)}`}>
                {pct(result.dreamStartPct)}
              </div>
              <div className="text-[10px] text-slate-500">dream start (all three)</div>
            </div>
          </div>
          {result.issues.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-amber-800">
              {result.issues.map((issue, i) => (
                <li key={i}>⚠️ {issue}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-slate-400">
            {result.trials.toLocaleString()} simulated hands — swap cards and deal again to
            compare.
          </p>
        </>
      )}
    </div>
  );
}
