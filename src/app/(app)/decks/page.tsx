"use client";

import { useEffect, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import { askDeckAI } from "@/components/TrainerChat";
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
import DeckEditCard, { type DeckEditProposal } from "@/components/DeckEditCard";
import { isBasicLand } from "@/lib/mtgDeckLegality";
import { resilientFetch } from "@/lib/clientLoop";
import CardText from "@/components/CardText";
import CardZoom from "@/components/CardZoom";

type UpgradeSuggestion = DeckSuggestion;

/** A card in the manual builder's pick list: your collection aggregated by
 *  card name (finishes combined — a deck list doesn't care about holos). */
interface OwnedCard {
  name: string;
  owned: number;
  category: "pokemon" | "trainer" | "energy" | "creature" | "spell" | "land";
  game: "pokemon" | "mtg";
  cardId: string | null;
  image: string | null;
  setName: string;
}

function categoryOf(
  supertype: string | null | undefined,
  game: "pokemon" | "mtg"
): OwnedCard["category"] {
  if (game === "mtg") {
    // The supertype column holds the type line's core for Magic rows —
    // "Creature", "Artifact Creature", "Instant", "Land"…
    if (/land/i.test(supertype ?? "")) return "land";
    if (/creature/i.test(supertype ?? "")) return "creature";
    return "spell";
  }
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
  // Which game's cards the builder shows, and — for Magic — which format's
  // rules cap the copies. Both are locked while editing: a deck's game is
  // decided the day it's made.
  const [mGame, setMGame] = useState<"pokemon" | "mtg">("pokemon");
  const [mFormat, setMFormat] = useState<"commander" | "standard">("commander");
  const deckTarget = mGame === "mtg" && mFormat === "commander" ? 100 : 60;

  async function fetchOwned(): Promise<OwnedCard[]> {
    try {
      const res = await fetch("/api/collection");
      const json = await res.json();
      const byName = new Map<string, OwnedCard>();
      for (const it of (json.items ?? []) as CollectionItem[]) {
        if (!it.card) continue;
        const game: OwnedCard["game"] =
          it.card.game === "mtg" || it.card.id.startsWith("scry-") ? "mtg" : "pokemon";
        const prev = byName.get(`${game}|${it.card.name}`);
        if (prev) {
          prev.owned += it.quantity;
          if (!prev.image && it.card.image_small) {
            prev.image = artSrc(it.card.id, it.card.image_small);
          }
        } else {
          byName.set(`${game}|${it.card.name}`, {
            name: it.card.name,
            owned: it.quantity,
            category: categoryOf(it.card.supertype, game),
            game,
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
      // The deck's game decides which half of the collection the builder
      // shows. Older rows predate the column, so scry- card ids are the
      // fallback tell; format falls back on the one thing a Commander deck
      // can't hide, its size.
      const isMtgDeck =
        (editDeck as { game?: string }).game === "mtg" ||
        (editDeck.cards ?? []).some((e) => e.card_id?.startsWith("scry-"));
      const deckGame: OwnedCard["game"] = isMtgDeck ? "mtg" : "pokemon";
      setMGame(deckGame);
      if (isMtgDeck) {
        const fmt = (editDeck as { format?: string }).format;
        const size = (editDeck.cards ?? []).reduce((s, e) => s + (e.quantity ?? 0), 0);
        setMFormat(fmt === "standard" || fmt === "commander" ? fmt : size > 60 ? "commander" : "standard");
      }
      const list = owned ?? (await fetchOwned());
      // Deck entries missing from the collection list (basic energy or
      // basic lands the player never scanned, etc.) get merged in so they
      // stay editable.
      const have = new Set(list.filter((c) => c.game === deckGame).map((c) => c.name));
      const merged = [...list];
      for (const e of editDeck.cards ?? []) {
        if (!have.has(e.name)) {
          const freebie = deckGame === "mtg" ? isBasicLand(e.name) : e.category === "energy";
          merged.push({
            name: e.name,
            owned: freebie ? 99 : e.quantity,
            category:
              (e.category as OwnedCard["category"]) ?? (deckGame === "mtg" ? "spell" : "trainer"),
            game: deckGame,
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
    if (c.game === "mtg") {
      // Basic lands are the one universal exemption; otherwise Commander is
      // singleton and Standard is 4-of, both capped at what you own.
      if (isBasicLand(c.name)) return 99;
      const ruleMax = mFormat === "commander" ? 1 : 4;
      return Math.min(ruleMax, c.owned);
    }
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
      .filter((c) => c.game === mGame && (deck[c.name] ?? 0) > 0)
      .map((c) => ({
        name: c.name,
        quantity: deck[c.name],
        category: c.category,
        card_id: c.cardId,
        reason: null,
      }));
  }

  const total = Object.values(deck).reduce((s, q) => s + q, 0);
  const entries = (owned ?? []).filter((c) => c.game === mGame && (deck[c.name] ?? 0) > 0);
  const countOf = (cat: OwnedCard["category"]) =>
    entries.filter((c) => c.category === cat).reduce((s, c) => s + deck[c.name], 0);
  const countsLine =
    mGame === "mtg"
      ? `${countOf("creature")} creatures · ${countOf("spell")} spells · ${countOf("land")} lands`
      : `${countOf("pokemon")} Pokémon · ${countOf("trainer")} Trainer · ${countOf("energy")} Energy`;

  async function askReview() {
    if (total === 0 || reviewing) return;
    setReviewing(true);
    setReview(null);
    setError(null);
    try {
      const res = await fetch("/api/decks/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          cards: toEntries(),
          question,
          game: mGame,
          ...(mGame === "mtg" ? { format: mFormat } : {}),
        }),
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
          body: JSON.stringify({
            name: name.trim(),
            strategy: notes.trim() || null,
            cards,
            ...(mGame === "mtg" ? { game: "mtg", format: mFormat } : {}),
          }),
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
    .filter((c) => c.game === mGame && matchesSearch(search, c.name, c.setName))
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
          {/* Which game, and for Magic which format's rules cap the copies.
              Locked during an edit — a deck's game is decided the day it's
              made, and switching would empty the list anyway. */}
          {!editBase && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input w-auto"
                value={mGame}
                onChange={(e) => {
                  const g = e.target.value === "mtg" ? "mtg" : "pokemon";
                  if (g !== mGame) setDeck({});
                  setMGame(g);
                }}
              >
                <option value="pokemon">⚡ Pokémon</option>
                <option value="mtg">🪄 Magic</option>
              </select>
              {mGame === "mtg" && (
                <select
                  className="input w-auto"
                  value={mFormat}
                  onChange={(e) => {
                    setMFormat(e.target.value === "standard" ? "standard" : "commander");
                  }}
                >
                  <option value="commander">Commander — 100 cards, singleton</option>
                  <option value="standard">Standard — 60 cards, 4-of</option>
                </select>
              )}
            </div>
          )}
          <input
            className="input"
            placeholder={mGame === "mtg" ? "Deck name (e.g. Goblin Commander)" : "Deck name (e.g. My Fire Deck)"}
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
                    Then remove what they replace so the deck stays at {deckTarget}.
                  </p>
                </div>
              );
            })()}

          {/* Current deck */}
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="mb-1 flex items-center justify-between text-sm font-semibold">
              <span>
                Deck: {total}/{deckTarget}{" "}
                {total === deckTarget ? "✅" : total > deckTarget ? `⚠️ over ${deckTarget}` : ""}
              </span>
              <span className="text-xs font-normal text-slate-500">{countsLine}</span>
            </div>
            {entries.length === 0 ? (
              <p className="text-xs text-slate-400">Tap cards below to add them.</p>
            ) : (
              <ul className="space-y-1">
                {(["commander", "pokemon", "creature", "trainer", "spell", "energy", "land"] as const).map((cat) =>
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
                          {c.category === "energy"
                            ? " (energy is unlimited)"
                            : c.game === "mtg" && isBasicLand(c.name)
                              ? " (basic lands are unlimited)"
                              : ""}
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
              {mGame === "mtg"
                ? mFormat === "commander"
                  ? "Singleton: one copy of everything except basic lands. Aim for 100 cards including your commander."
                  : "Max 4 copies per card (except basic lands). Aim for 60 cards."
                : "Max 4 copies per card (except Energy). Aim for 60 cards."}
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
            {total !== deckTarget && total > 0 && (
              <span className="self-center text-xs text-slate-400">
                (you can save at any size — {deckTarget} is tournament-legal)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** How long the client will wait for a coach job before giving up.
 *
 *  The server treats a job as dead after six minutes, so this sits just
 *  inside that: the poll should end with a real answer or a real error from
 *  the server, and this is only the backstop for the server never replying
 *  at all. Whatever happens, the spinner ends. */
const POLL_LIMIT_MS = 5 * 60 * 1000;

function CoachBox({
  deck,
  deckId,
  onEdited,
}: {
  deck: {
    name: string;
    strategy: string | null;
    cards: DeckCardEntry[];
    suggestions?: UpgradeSuggestion[];
  };
  /** A saved deck's id. Absent for the deck that has just been built and not
   *  saved: there is no row to change, so no edits are offered. */
  deckId?: string | null;
  onEdited?: () => void;
}) {
  const credits = useCredits();
  const [question, setQuestion] = useState("");
  /** The conversation, oldest first. A saved deck's thread is loaded from
   *  the server (it survives closing the deck and switching devices); an
   *  unsaved build keeps its thread here and sends it along with each
   *  question so the coach still remembers the exchange. */
  const [thread, setThread] = useState<Array<{ role: "user" | "assistant"; content: string }>>(
    []
  );
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<DeckEditProposal | null>(null);
  const [asking, setAsking] = useState(false);
  const [waited, setWaited] = useState(0);
  /** A server-side caveat worth reading alongside the answer — currently
   *  only "the background-job migration has not been run". */
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!deckId) return;
    let live = true;
    fetch(`/api/decks/coach?thread=${encodeURIComponent(deckId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && Array.isArray(j?.messages)) setThread(j.messages);
      })
      .catch(() => {
        // An unloadable history is an empty one, not a broken coach.
      });
    return () => {
      live = false;
    };
  }, [deckId]);

  async function clearChat() {
    setThread([]);
    setEdit(null);
    setError(null);
    if (deckId) {
      await fetch(`/api/decks/coach?thread=${encodeURIComponent(deckId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }

  /** Read one JSON body, saying what happened when it isn't JSON.
   *
   *  A route that times out or crashes at the gateway replies with an HTML
   *  error page, and res.json() throws on the first '<'. That used to come
   *  back as "Something went wrong — try again", which is no use to the
   *  person reading it and no use to whoever has to fix it. */
  async function readJson<T>(res: Response): Promise<{ json: T | null; failure: string | null }> {
    const body = await res.text();
    try {
      return { json: JSON.parse(body) as T, failure: null };
    } catch {
      return {
        json: null,
        failure:
          res.status === 504 || res.status === 502
            ? `The connection gave up waiting (HTTP ${res.status}).`
            : `The server answered with something unreadable (HTTP ${res.status}).`,
      };
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    setEdit(null);
    setNote(null);
    setWaited(0);
    // The question joins the thread immediately and the box empties — the
    // conversation is the record, the input is just the doorway.
    const priorThread = thread;
    setThread((t) => [...t, { role: "user", content: q }]);
    setQuestion("");
    const startedAt = Date.now();
    try {
      // Starting the answer and collecting it are two separate requests.
      //
      // A question that ends in a proposed deck edit is two sequential model
      // calls on top of a collection read, and the browser is the one
      // participant guaranteed to leave — a locked phone kills the fetch and
      // the gateway gives up before the work does. So the POST only starts
      // the job and returns; the answer is polled for. Lock the screen
      // mid-answer now and it is waiting when you come back.
      const res = await resilientFetch("/api/decks/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A saved deck's history lives server-side; only the unsaved
        // build's thread travels with the request. Wishlist rows are
        // slimmed to what the server reads — the stored ones carry whole
        // card records and images.
        body: JSON.stringify({
          deck: {
            name: deck.name,
            strategy: deck.strategy,
            cards: deck.cards,
            suggestions: (deck.suggestions ?? []).map((s) => ({
              name: s.name,
              quantity: s.quantity,
              reason: s.reason,
            })),
          },
          question: q,
          deckId: deckId ?? null,
          ...(deckId ? {} : { history: priorThread.slice(-12) }),
        }),
      });
      const { json, failure } = await readJson<{
        jobId?: string;
        answer?: string;
        edit?: DeckEditProposal | null;
        error?: string;
        note?: string;
      }>(res);
      if (!json) {
        setError(`${failure} Try again — if it keeps happening, this is worth reporting.`);
        return;
      }
      if (!res.ok) {
        setError(json.error || `The request failed (HTTP ${res.status}).`);
        return;
      }

      // Answered inline: migration 049 hasn't run, so the route did the work
      // inside the request. Still a valid answer, just a fragile delivery —
      // and the note is SHOWN rather than swallowed, because a background job
      // that silently isn't running is the same bug wearing a disguise.
      if (!json.jobId) {
        setThread((t) => [...t, { role: "assistant", content: json.answer ?? "No answer came back." }]);
        setNote(json.note ?? null);
        if (json.edit) setEdit(json.edit);
        return;
      }

      // Poll. resilientFetch waits for the tab to come back rather than
      // treating a sleeping phone as a failure.
      const jobId = json.jobId;
      const deadline = startedAt + POLL_LIMIT_MS;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        setWaited(Math.round((Date.now() - startedAt) / 1000));
        // A bounded loop, because an unbounded one is how "thinking…" becomes
        // permanent. Whatever went wrong server-side, the person watching a
        // spinner is owed an ending — and the job id makes the difference
        // between a shrug and something reportable.
        if (Date.now() > deadline) {
          setError(
            `That answer has been running for ${Math.round(
              POLL_LIMIT_MS / 60000
            )} minutes, which is far longer than it should take, so I've stopped waiting. ` +
              `Nothing was changed. (job ${jobId.slice(0, 8)})`
          );
          return;
        }
        const poll = await resilientFetch(`/api/decks/coach?job=${encodeURIComponent(jobId)}`);
        const { json: state, failure: pollFailure } = await readJson<{
          job?: {
            status: "running" | "done" | "error";
            result?: { answer?: string; edit?: DeckEditProposal | null } | null;
            error?: string | null;
          } | null;
          error?: string;
        }>(poll);
        if (!state) {
          setError(`${pollFailure} The answer may still be running — ask again in a moment.`);
          return;
        }
        if (state.error) {
          setError(state.error);
          return;
        }
        const job = state.job;
        // A job that vanished is not a job still running. Saying so beats
        // polling an id nothing will ever answer for.
        if (!job) {
          setError("That answer went missing before it finished — ask again.");
          return;
        }
        if (job.status === "error") {
          setError(job.error || "The coach failed.");
          return;
        }
        if (job.status === "done") {
          setThread((t) => [
            ...t,
            { role: "assistant", content: job.result?.answer ?? "No answer came back." },
          ]);
          if (job.result?.edit) setEdit(job.result.edit);
          return;
        }
      }
    } catch (err) {
      // resilientFetch gives up only after several attempts across a wake-up,
      // so reaching here means the connection is genuinely gone.
      setError(
        `Couldn't reach the server — ${
          err instanceof Error ? err.message : "the connection dropped"
        }. Nothing was changed.`
      );
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="m-0 text-xs font-semibold text-slate-500">
          🎓 Chat with {AI_NAME} about this deck — piloting, rules, matchups
          {deckId ? ", or ask for a change" : ""}
        </p>
        {thread.length > 0 && (
          <button
            className="shrink-0 text-[11px] text-slate-400 hover:text-slate-600 hover:underline"
            title="Start the conversation over"
            onClick={clearChat}
          >
            clear chat
          </button>
        )}
      </div>

      {thread.length > 0 && (
        <div className="mb-2 flex max-h-96 flex-col gap-2 overflow-y-auto">
          {thread.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="ml-8 self-end rounded-lg bg-poke-blue/10 px-3 py-2 text-sm text-slate-800"
              >
                {m.content}
              </div>
            ) : (
              <div
                key={i}
                className="mr-4 self-start rounded-lg bg-white px-3 py-2 text-sm leading-[1.6] text-slate-700 shadow-sm"
              >
                <Markdown text={m.content} />
                {/* A proposed change belongs to the latest reply — earlier
                    proposals were either approved or superseded. */}
                {edit && i === thread.length - 1 && (
                  <DeckEditCard
                    proposal={edit}
                    // The deck is on screen above this box, so a change that
                    // isn't reflected there reads as one that didn't happen.
                    onApplied={() => onEdited?.()}
                  />
                )}
              </div>
            )
          )}
        </div>
      )}

      {asking && (
        <p className="mb-2 text-xs text-slate-400">
          <span className="animate-pulse">{AI_NAME} is thinking about your deck…</span>
          {/* The elapsed count and the reassurance appear only once the wait
              is long enough to worry about. A question that answers in eight
              seconds doesn't need to be told it's safe to leave. */}
          {waited >= 12 && (
            <>
              {" "}
              <span className="text-slate-400">
                ({waited}s — this one&apos;s taking a while. You can lock your phone; the answer
                carries on without you.)
              </span>
            </>
          )}
        </p>
      )}
      {/* Explains why the answer took as long as it did — a background job
          that is quietly not running is the original bug wearing a
          disguise. */}
      {note && (
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11.5px] leading-snug text-amber-900">
          ⚠︎ {note}
        </p>
      )}
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <input
          className="input text-sm"
          placeholder={
            thread.length > 0
              ? "Ask a follow-up…"
              : deckId
                ? 'e.g. "What do I search for first turn?" or "Swap the Poké Pad for a Nest Ball"'
                : 'e.g. "What do I search for first turn?" or "How do I beat water decks?"'
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
        />
        {credits.empty ? (
          <CreditLock plan={credits.credits?.plan} label="Out of credits" />
        ) : (
          <button className="btn-secondary shrink-0 text-sm" onClick={ask} disabled={asking}>
            {asking ? "Thinking…" : thread.length > 0 ? "Send" : "Ask"}
          </button>
        )}
      </div>
    </div>
  );
}

interface BuiltDeck {
  name: string;
  strategy: string;
  cards: DeckCardEntry[];
  missing_suggestions: UpgradeSuggestion[];
  /** Stamped by the server on Magic builds, so saving and exporting know. */
  game?: "pokemon" | "mtg";
  format?: string | null;
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

  // Where a row's Buy goes. Newly built decks carry a server-built link
  // (affiliate-wrapped once the program key is set); decks saved before
  // that existed still deserve a destination, so they fall back to a plain
  // TCGplayer search for the name.
  const buyHref = (u: UpgradeSuggestion) =>
    u.buyUrl ??
    `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(u.name)}`;

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
                {u.card && (
                  <span className="ml-1 font-normal text-amber-600">· {u.card.setName}</span>
                )}
              </div>
              <div className="mt-0.5 text-amber-800">{u.reason}</div>
              {/* The number and the door match: this is TCGplayer's market
                  price, and the Buy button below goes to TCGplayer. Quoting
                  one marketplace's price next to another marketplace's
                  door was just confusing. */}
              {u.card?.marketPrice != null && (
                <div className="mt-1 text-amber-800">
                  TCGplayer market:{" "}
                  <span className="font-semibold">${u.card.marketPrice.toFixed(2)}</span> each
                  {u.quantity > 1 && (
                    <> · ${(u.card.marketPrice * u.quantity).toFixed(2)} for {u.quantity}</>
                  )}
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
              <a
                href={buyHref(u)}
                target="_blank"
                // "sponsored" is the rel search engines and the FTC expect
                // on a paid link; harmless while the links are plain.
                rel="noreferrer sponsored"
                className="mt-1 inline-block rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-700"
              >
                Buy on TCGplayer ↗
              </a>
            </div>
          </li>
          );
        })}
      </ul>
      {suggestions.some((u) => u.buyUrl && !u.buyUrl.startsWith("https://www.tcgplayer.com")) && (
        <p className="mb-0 mt-2 text-[11px] text-amber-700">
          TCGdeck earns a small commission on TCGplayer purchases made through these links —
          at no extra cost to you.
        </p>
      )}
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

const MTG_FORMAT_NOTES: Record<string, string> = {
  commander:
    "🪄 Commander: 100 cards, one of everything (basic lands excepted), led by a legendary creature whose colors set the deck's — the way most kitchen-table Magic is played.",
  standard:
    "🏆 Standard: 60 cards, up to 4 copies each, recent sets only — what official Magic tournaments play.",
};

/** The in-flight build's ticket, persisted so a page refresh (or Safari
 *  reloading a backgrounded tab) can resume watching the same build. */
const JOB_STORAGE_KEY = "pokedeck-build-job";

/** Last loaded deck lists, module scope — same stale-while-revalidate as
 *  the collection page: a revisited tab paints its decks instantly while
 *  the fetch refreshes them, instead of several blank seconds. */
let decksCache: { decks: Deck[]; family: Deck[] } | null = null;

export default function DecksPage() {
  const credits = useCredits();
  const [decks, setDecks] = useState<Deck[]>(decksCache?.decks ?? []);
  // The rest of the household's, read-only. Kept apart from `decks` rather
  // than flagged inside it: every action on this page — edit, delete, share,
  // the free-tier deck count — means "mine", and one merged list would have
  // to remember that in a dozen places.
  const [familyDecks, setFamilyDecks] = useState<Deck[]>(decksCache?.family ?? []);
  const [styleNotes, setStyleNotes] = useState("");
  const [styleSaved, setStyleSaved] = useState(false);
  const [prompt, setPrompt] = useState("");
  // Which game the AI builder is building for. The manual builder below
  // stays Pokémon-shaped for now; Magic decks come from this builder.
  const [buildGame, setBuildGame] = useState<"pokemon" | "mtg">("pokemon");
  const [format, setFormat] = useState("any");
  // "collection" builds from the binder; "family" from the whole
  // household's combined cards; "all" is the dream deck — any real card,
  // with a computed buy list for the gap.
  const [poolMode, setPoolMode] = useState<"collection" | "family" | "all">("collection");
  // Set when arriving from the Meta page's "Build this deck" button — the
  // server grounds the build in that archetype's tournament list.
  const [archetypeSeed, setArchetypeSeed] = useState<string | null>(null);

  // Read the hand-off from the Meta page once, then clean the URL so a
  // reload doesn't re-arm it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const archetype = params.get("archetype");
    if (params.get("pool") === "all" || archetype) {
      setPoolMode("all");
      // A Magic archetype hands over its game and format too — the same
      // builder serves both, and a Commander archetype built under
      // Pokémon rules would be nonsense.
      const handedGame = params.get("game") === "mtg" ? "mtg" : "pokemon";
      setBuildGame(handedGame);
      if (archetype) {
        setArchetypeSeed(archetype);
        setPrompt(`Build the trending "${archetype}" deck`);
        setFormat(
          handedGame === "mtg"
            ? params.get("format") === "standard"
              ? "standard"
              : "commander"
            : "standard"
        );
      }
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const [editRequest, setEditRequest] = useState<Deck | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
  /** The running build's job ticket — what the Stop button aims at. */
  const [buildJobId, setBuildJobId] = useState<string | null>(null);
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
  /** The card picture being looked at full-screen, if any. */
  const [zoomed, setZoomed] = useState<string | null>(null);

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
        setFamilyDecks(j.family ?? []);
        decksCache = { decks: j.decks ?? [], family: j.family ?? [] };
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
    setBuildJobId(jobId);
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
        // Stopped at the player's own request — settle quietly, no error.
        if (status.status === "cancelled") return;
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
      setBuildJobId(null);
      try {
        localStorage.removeItem(JOB_STORAGE_KEY);
      } catch {}
    }
  }

  /** Stop the running build. The job flips to "cancelled" server-side and
   *  the poll above settles on its next pass — nothing else to unwind. */
  async function stopBuild() {
    if (!buildJobId) return;
    try {
      await fetch(`/api/decks/build?job=${encodeURIComponent(buildJobId)}`, { method: "DELETE" });
    } catch {
      // The poll's deadline still bounds the wait if the stop didn't land.
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
        body: JSON.stringify({
          prompt,
          format,
          pool: poolMode,
          game: buildGame,
          ...(archetypeSeed ? { archetype: archetypeSeed } : {}),
        }),
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

  /** Which "Copy for TCG Live" button just fired, and how it went:
   *  "<key>:ok", "<key>:warn:<n>" (copied, n lines without a set code) or
   *  "<key>:err". Cleared after a moment so the label returns. */
  const [liveCopied, setLiveCopied] = useState<string | null>(null);

  /** True when a deck (saved or just built) is a Magic deck. */
  const isMtgDeck = (d: { game?: string | null; cards?: DeckCardEntry[] | null }) =>
    d.game === "mtg" || (d.cards ?? []).some((c) => c.card_id?.startsWith("scry-"));

  /** Which game's saved decks are listed. "all" by default, so nothing
   *  anyone saved ever seems to vanish behind a filter they didn't set. */
  const [deckFilter, setDeckFilter] = useState<"all" | "pokemon" | "mtg">("all");
  const shownDecks = decks.filter(
    (d) => deckFilter === "all" || (isMtgDeck(d) ? "mtg" : "pokemon") === deckFilter
  );

  async function copyForLive(
    cards: DeckCardEntry[],
    key: string,
    opts?: { game?: "pokemon" | "mtg"; format?: string | null }
  ) {
    try {
      const res = await fetch("/api/decks/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards,
          ...(opts?.game ? { game: opts.game } : {}),
          ...(opts?.format ? { format: opts.format } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Export failed");
      await navigator.clipboard.writeText(json.text as string);
      const warned = (json.warnings as string[] | undefined)?.length ?? 0;
      setLiveCopied(warned > 0 ? `${key}:warn:${warned}` : `${key}:ok`);
    } catch {
      setLiveCopied(`${key}:err`);
    }
    setTimeout(() => setLiveCopied(null), 4000);
  }

  const liveLabel = (key: string, mtg = false) =>
    liveCopied === `${key}:ok`
      ? `Copied ✓ — paste in ${mtg ? "MTG Arena" : "TCG Live"}`
      : liveCopied?.startsWith(`${key}:warn:`)
        ? `Copied ✓ — ${liveCopied.split(":")[2]} card(s) may need picking by hand`
        : liveCopied === `${key}:err`
          ? "Couldn't copy — try again"
          : `📋 Copy for ${mtg ? "MTG Arena" : "TCG Live"}`;

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
        ...(isMtgDeck(built)
          ? { game: "mtg", format: built.format ?? "commander" }
          : built.format
            ? { format: built.format }
            : {}),
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

  /** Re-read one deck from the server after something changed it.
   *
   *  Used after DeckAI's edit is approved. Reading it back rather than
   *  patching from the proposal is the point: the server validates the edit
   *  again on the way in, so the screen should show what the deck IS, not
   *  what the change asked for. */
  async function reloadDeck(id: string) {
    const res = await fetch("/api/decks").catch(() => null);
    if (!res?.ok) return;
    const json = await res.json().catch(() => null);
    const fresh = ((json?.decks ?? []) as Deck[]).find((d) => d.id === id);
    if (!fresh) return;
    setDecks((prev) => prev.map((d) => (d.id === id ? fresh : d)));
    setViewing((v) => (v && v.id === id ? fresh : v));
  }

  // Both games' section buckets — a deck only ever fills one game's three
  // (or four). Sections render only when non-empty, so the same DeckList
  // serves Pokémon and Magic decks without knowing which it holds.
  const groupCards = (cards: DeckCardEntry[]) => ({
    commander: cards.filter((c) => c.category === "commander"),
    pokemon: cards.filter((c) => c.category === "pokemon"),
    creature: cards.filter((c) => c.category === "creature"),
    trainer: cards.filter((c) => c.category === "trainer"),
    spell: cards.filter((c) => c.category === "spell"),
    energy: cards.filter((c) => c.category === "energy"),
    land: cards.filter((c) => c.category === "land"),
  });

  // Someone else's deck opens in the same viewer, minus everything that
  // would change it. Identity by list membership rather than by comparing
  // user ids, because the page never needed to know its own id before and
  // this is not a good reason to start.
  const viewingIsFamily = !!viewing && familyDecks.some((d) => d.id === viewing.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Decks</h1>
          <p className="text-sm text-slate-500">
            Build tournament-ready decks from the cards you actually own.
          </p>
        </div>
        {/* Meta lost its nav tab on purpose — trending decks are deck
            inspiration, and their "Build this deck" button lands back
            here anyway. */}
        <a href="/meta" className="btn-secondary shrink-0 text-sm">
          📈 Trending decks
        </a>
      </div>

      {/* Play style profile */}
      <div className="card-panel p-4">
        <h2 className="font-semibold">🎮 Your play style</h2>
        <p className="mb-2 mt-0.5 text-xs text-slate-500">
          Tell {AI_NAME} how you like to play — aggressive, defensive, favorite Pokémon or
          commanders, combos you love, your experience level. It uses this to tailor every deck
          it builds for you.
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
          {buildGame === "mtg"
            ? `${AI_NAME} looks at your Magic collection and builds a legal ${format === "standard" ? "60-card Standard" : "100-card Commander"} deck. Basic lands are assumed — no need to scan them. Can take a minute.`
            : `${AI_NAME} looks at your whole collection and builds a legal 60-card deck. Basic energy is assumed — no need to scan energy cards. Can take a minute.`}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder='e.g. "an aggressive fire deck" or leave blank for the best deck possible'
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !building && build()}
          />
          {/* Wraps: three selects and a button never fit one phone-width
              row, and a row that can't wrap clips the format picker off
              the screen edge entirely. */}
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <select
              className="input w-auto text-sm"
              title="Which game to build a deck for"
              value={buildGame}
              onChange={(e) => {
                const g = e.target.value === "mtg" ? "mtg" : "pokemon";
                // The two games share no formats — swap to each game's
                // default, and drop an archetype seed on a real switch: it
                // named a deck in the game being left behind.
                if (g !== buildGame) setArchetypeSeed(null);
                setBuildGame(g);
                setFormat(g === "mtg" ? "commander" : "any");
              }}
            >
              <option value="pokemon">⚡ Pokémon</option>
              <option value="mtg">🪄 Magic</option>
            </select>
            <select
              className="input w-auto text-sm"
              title="Card pool — your binder, your whole family's cards, or every card ever printed (with a buy list)"
              value={poolMode}
              onChange={(e) => {
                const v = e.target.value;
                setPoolMode(v === "all" ? "all" : v === "family" ? "family" : "collection");
                if (v !== "all") setArchetypeSeed(null);
              }}
            >
              <option value="collection">🎒 My collection</option>
              <option value="family">👨‍👩‍👧 Family cards</option>
              <option value="all">🌟 Any cards</option>
            </select>
            <select
              className="input w-auto text-sm"
              title="Tournament format — filters which of your cards are allowed"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              {buildGame === "mtg" ? (
                <>
                  <option value="commander">🪄 Commander</option>
                  <option value="standard">🏆 Standard</option>
                </>
              ) : (
                <>
                  <option value="any">🃏 Anything goes</option>
                  <option value="standard">🏆 Standard</option>
                  <option value="expanded">📚 Expanded</option>
                </>
              )}
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
        <p className="mb-0 mt-1.5 text-xs text-slate-500">
          {poolMode === "all" && (
            <>
              🌟 Dream deck: builds with any real card
              {buildGame === "mtg"
                ? " — the result includes a priced buy list for everything you don't own"
                : ", grounded in current tournament results — the result includes a priced buy list for everything you don't own"}
              {archetypeSeed ? `, aimed at ${archetypeSeed}` : ""}.{" "}
            </>
          )}
          {poolMode === "family" && (
            <>
              👨‍👩‍👧 Builds from your whole family&apos;s combined cards — the deck may lean on
              another member&apos;s copies, and the strategy says when it does.{" "}
            </>
          )}
          {(buildGame === "mtg" ? MTG_FORMAT_NOTES[format] : FORMAT_NOTES[format]) ?? ""}
        </p>
        {building && (
          <div className="mt-2 flex items-center gap-2">
            <FanMark size={16} className="animate-spin-slow shrink-0" />
            <p className="animate-pulse text-sm text-slate-500">{BUILD_STEPS[buildStep]}</p>
            {buildJobId && (
              <button
                type="button"
                className="shrink-0 rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-400 hover:text-slate-800"
                onClick={stopBuild}
              >
                ⏹ Stop
              </button>
            )}
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
                <button
                  className="btn-secondary text-sm"
                  title="Copy this list in the official client's import format"
                  onClick={() =>
                    copyForLive(built.cards, "built", {
                      game: isMtgDeck(built) ? "mtg" : "pokemon",
                      format: built.format ?? null,
                    })
                  }
                >
                  {liveLabel("built", isMtgDeck(built))}
                </button>
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
            <CoachBox
              deck={{
                name: built.name,
                strategy: built.strategy,
                cards: built.cards,
                suggestions: built.missing_suggestions ?? [],
              }}
            />
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Saved decks</h2>
          {/* The filter appears once there's anything to filter. "All" is
              the default so nothing anyone saved ever seems to vanish. */}
          {decks.length > 0 && (
            <div className="flex gap-1">
              {(
                [
                  ["all", "All"],
                  ["pokemon", "⚡ Pokémon"],
                  ["mtg", "🪄 Magic"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setDeckFilter(key)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    deckFilter === key
                      ? "border-brand-accent bg-brand-accent text-white"
                      : "border-brand-line-strong text-brand-ink2 hover:border-brand-accent"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
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
        ) : shownDecks.length === 0 ? (
          <p className="text-sm text-slate-400">
            No {deckFilter === "mtg" ? "Magic" : "Pokémon"} decks yet — build one above!
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {shownDecks.map((deck) => (
              <button
                key={deck.id}
                className="card-panel p-4 text-left hover:shadow-md"
                onClick={() => setViewing(deck)}
              >
                <div className="font-bold">
                  {deck.name}
                  {/* Both games wear a chip — Magic-only tagging read as
                      Pokémon decks missing theirs, not as a default. */}
                  {isMtgDeck(deck) ? (
                    <span className="ml-2 chip bg-purple-100 text-purple-700">
                      🪄 {deck.format === "standard" ? "Magic · Standard" : "Magic · Commander"}
                    </span>
                  ) : (
                    <span className="ml-2 chip bg-amber-100 text-amber-700">
                      ⚡ Pokémon
                      {deck.format === "standard"
                        ? " · Standard"
                        : deck.format === "expanded"
                          ? " · Expanded"
                          : ""}
                    </span>
                  )}
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

      {/* The rest of the house. Only rendered when there is one, so a solo
          account never sees an empty heading asking what it's for. */}
      {familyDecks.length > 0 && (
        <div className="card-panel p-4">
          <h2 className="mb-2 font-semibold">Family decks</h2>
          <p className="mb-2 text-xs text-slate-500">
            Everyone on your family plan can see each other&apos;s decks. You can look and
            borrow ideas; only the person who built one can change it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {familyDecks.map((deck) => (
              <button
                key={deck.id}
                className="card-panel p-4 text-left hover:shadow-md"
                onClick={() => setViewing(deck)}
              >
                <div className="font-bold">
                  {deck.name}
                  {isMtgDeck(deck) ? (
                    <span className="ml-2 chip bg-purple-100 text-purple-700">🪄 Magic</span>
                  ) : (
                    <span className="ml-2 chip bg-amber-100 text-amber-700">⚡ Pokémon</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {deck.owner_name} · {(deck.cards ?? []).reduce((s, c) => s + c.quantity, 0)} cards
                  · {new Date(deck.created_at).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

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
            {viewingIsFamily ? (
              <div className="mt-2">
                <p className="text-sm text-brand-ink3">
                  Built by {viewing.owner_name ?? "someone in your family"} — you can read it and
                  try the opening hand, but only they can change it.
                </p>
                <button
                  className="btn mt-1.5 text-sm text-poke-blue hover:bg-poke-blue/10"
                  title="Copy this list in the official client's import format"
                  onClick={() =>
                    copyForLive(viewing.cards ?? [], viewing.id, {
                      game: isMtgDeck(viewing) ? "mtg" : "pokemon",
                      format: viewing.format ?? null,
                    })
                  }
                >
                  {liveLabel(viewing.id, isMtgDeck(viewing))}
                </button>
              </div>
            ) : (
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
                className="btn text-sm text-poke-blue hover:bg-poke-blue/10"
                title="Copy this list in the official client's import format"
                onClick={() =>
                  copyForLive(viewing.cards ?? [], viewing.id, {
                    game: isMtgDeck(viewing) ? "mtg" : "pokemon",
                    format: viewing.format ?? null,
                  })
                }
              >
                {liveLabel(viewing.id, isMtgDeck(viewing))}
              </button>
              <button
                className="btn text-sm text-red-600 hover:bg-red-50"
                onClick={() => deleteDeck(viewing.id)}
              >
                Delete
              </button>
            </div>
            )}
            {!viewingIsFamily && !credits.freeTier && <DeckDirectShares deckId={viewing.id} />}

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
                {/* No coaching on someone else's deck: it would spend the
                    household's credits to produce edits that can't be
                    applied, since the write policies are still owner-only. */}
                {!viewingIsFamily && (
                  <CoachBox
                    deck={{
                      name: viewing.name,
                      strategy: viewing.strategy,
                      cards: viewing.cards ?? [],
                      // The saved wishlist rides along so the coach can
                      // notice when a suggested card has since been acquired
                      // and propose actually putting it in.
                      suggestions: viewing.suggestions ?? [],
                    }}
                    deckId={viewing.id}
                    onEdited={() => reloadDeck(viewing.id)}
                  />
                )}
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
        {(["commander", "pokemon", "creature", "trainer", "spell", "energy", "land"] as const).map(
          (cat) =>
            groups[cat].length > 0 && (
              <div key={cat}>
                <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                  {cat} ({groups[cat].reduce((s, c) => s + c.quantity, 0)})
                </h4>
                {/* Sized by MINIMUM TILE, not by column count. Fixed columns
                    made the tile whatever was left over — seven across a
                    modal panel that also holds the strategy text came to
                    ~85px on a desktop, unreadable next to the collection
                    page's ~170px tiles. auto-fill keeps every tile at least
                    8rem and lets the panel decide how many fit. */}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">

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
              // 96px wide is a thumbnail, not a card. Tapping it gives the
              // card — same behaviour as the collection's panel, since it is
              // the same question being asked.
              <button
                type="button"
                className="shrink-0 cursor-zoom-in"
                onClick={() => setZoomed(image)}
                aria-label={`See ${reading.name} larger`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image} alt={reading.name} className="w-24 rounded-lg shadow-sm" />
              </button>
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

          {/* Shared with the collection's card panel — see components/CardText. */}
          <CardText detail={d ?? null} loading={readingBusy} />

          {/* Same quick-asks as the collection sheet: reading a card in a
              deck is exactly when "how do I actually play this" comes up. */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(() => {
              const who = `${reading.name}${d?.setName ? ` (${d.setName}${d.number ? ` #${d.number}` : ""})` : ""}`;
              const asks: Array<[string, string]> = [
                ["💬 How do I play it?", `How do I play ${who} well? Walk me through when and why.`],
                [
                  "💬 Explain it simply",
                  `Explain what ${who} does in simple terms — assume I'm still learning the game.`,
                ],
                ["💬 Why is it in this deck?", `In my deck this card sits in, what job does ${who} do and when should I use it?`],
              ];
              return asks.map(([label, q]) => (
                <button
                  key={label}
                  type="button"
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-brand-accent hover:text-brand-accent"
                  onClick={() => askDeckAI(q)}
                >
                  {label}
                </button>
              ));
            })()}
          </div>
        </div>
        {zoomed && (
          <CardZoom src={zoomed} alt={reading.name} onClose={() => setZoomed(null)} />
        )}
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
