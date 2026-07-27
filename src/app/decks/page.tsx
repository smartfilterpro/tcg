"use client";

import { useEffect, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import { matchesSearch } from "@/lib/text";
import type { CollectionItem, Deck, DeckCardEntry, DeckSuggestion } from "@/lib/types";

type UpgradeSuggestion = DeckSuggestion;

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

function ManualBuilder({ onSaved }: { onSaved: (deck: Deck) => void }) {
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

  async function openBuilder() {
    setOpen(true);
    if (owned !== null) return;
    try {
      const res = await fetch("/api/collection");
      const json = await res.json();
      const byName = new Map<string, OwnedCard>();
      for (const it of (json.items ?? []) as CollectionItem[]) {
        if (!it.card) continue;
        const prev = byName.get(it.card.name);
        if (prev) {
          prev.owned += it.quantity;
          if (!prev.image && it.card.image_small) prev.image = it.card.image_small;
        } else {
          byName.set(it.card.name, {
            name: it.card.name,
            owned: it.quantity,
            category: categoryOf(it.card.supertype),
            cardId: it.card.id,
            image: it.card.image_small,
            setName: it.card.set_name,
          });
        }
      }
      setOwned([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setOwned([]);
    }
  }

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
      const res = await fetch("/api/decks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          strategy: notes.trim() || null,
          cards: toEntries(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't save the deck");
      onSaved(json.deck);
      setDeck({});
      setName("");
      setNotes("");
      setReview(null);
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
    <div className="card-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">🛠 Build your own deck</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Pick cards from your collection yourself — with optional {AI_NAME} review while
            you build.
          </p>
        </div>
        <button
          className="btn-secondary shrink-0 text-sm"
          onClick={() => (open ? setOpen(false) : openBuilder())}
        >
          {open ? "Close" : "Open builder"}
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
              <button
                className="btn-secondary shrink-0 text-sm"
                disabled={reviewing || total === 0}
                onClick={askReview}
              >
                {reviewing ? "Reviewing…" : `🤖 Review`}
              </button>
            </div>
            {review && (
              <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-sm text-slate-700">
                {review}
              </p>
            )}
          </div>

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
        <button className="btn-secondary shrink-0 text-sm" onClick={ask} disabled={asking}>
          {asking ? "Thinking…" : "Ask"}
        </button>
      </div>
      {asking && (
        <p className="mt-2 animate-pulse text-xs text-slate-400">
          {AI_NAME} is thinking about your deck…
        </p>
      )}
      {answer && (
        <div className="mt-2 whitespace-pre-wrap rounded bg-white p-3 text-sm text-slate-700 shadow-sm">
          {answer}
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
function UpgradeList({ suggestions }: { suggestions: UpgradeSuggestion[] }) {
  const total = suggestions.reduce(
    (s, u) => s + (u.card?.marketPrice ?? 0) * u.quantity,
    0
  );
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
        {suggestions.map((u, i) => (
          <li key={i} className="flex gap-2">
            {u.card?.imageSmall ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={u.card.imageSmall} alt={u.name} className="w-12 shrink-0 self-start rounded" />
            ) : (
              <div className="flex aspect-[63/88] w-12 shrink-0 items-center justify-center self-start rounded bg-amber-100 text-[9px] text-amber-400">
                ?
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
            </div>
          </li>
        ))}
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

/** The in-flight build's ticket, persisted so a page refresh (or Safari
 *  reloading a backgrounded tab) can resume watching the same build. */
const JOB_STORAGE_KEY = "pokedeck-build-job";

export default function DecksPage() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [styleNotes, setStyleNotes] = useState("");
  const [styleSaved, setStyleSaved] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
  const [built, setBuilt] = useState<BuiltDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Deck | null>(null);
  // card_id → image url, for showing real card pictures in deck lists
  const [cardImages, setCardImages] = useState<Record<string, string | null>>({});

  async function ensureImages(cards: DeckCardEntry[]) {
    const wanted = [
      ...new Set(
        cards
          .map((c) => c.card_id)
          .filter((id): id is string => !!id && !(id in cardImages))
      ),
    ];
    if (wanted.length === 0) return;
    try {
      const res = await fetch(`/api/cards/images?ids=${encodeURIComponent(wanted.join(","))}`);
      const json = await res.json();
      if (res.ok) setCardImages((prev) => ({ ...prev, ...json.images }));
    } catch {}
  }

  useEffect(() => {
    if (built) ensureImages(built.cards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built]);

  useEffect(() => {
    if (viewing) ensureImages(viewing.cards ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  useEffect(() => {
    fetch("/api/decks")
      .then((r) => r.json())
      .then((j) => setDecks(j.decks ?? []));
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
        body: JSON.stringify({ prompt }),
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

  async function toggleShareDeck(deck: Deck) {
    const next = !deck.shared;
    const res = await fetch(`/api/decks/${deck.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared: next }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Couldn't update sharing");
      return;
    }
    setDecks((prev) => prev.map((d) => (d.id === deck.id ? { ...d, shared: next } : d)));
    setViewing((v) => (v && v.id === deck.id ? { ...v, shared: next } : v));
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
        <div className="flex gap-2">
          <input
            className="input"
            placeholder='e.g. "an aggressive fire deck" or leave blank for the best deck possible'
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !building && build()}
          />
          <button className="btn-primary shrink-0" onClick={build} disabled={building}>
            {building ? "Building…" : "Build deck"}
          </button>
        </div>
        {building && (
          <div className="mt-2 flex items-center gap-2">
            <span className="animate-spin-slow inline-block h-4 w-4 shrink-0 rounded-full border-2 border-poke-dark bg-gradient-to-b from-poke-red from-50% to-white to-50%" />
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
                <button className="btn-primary text-sm" onClick={saveDeck}>
                  Save deck
                </button>
                <button className="btn-secondary text-sm" onClick={() => setBuilt(null)}>
                  Discard
                </button>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{built.strategy}</p>
            <DeckList cards={built.cards} />
            {built.missing_suggestions?.length > 0 && (
              <UpgradeList suggestions={built.missing_suggestions} />
            )}
            <CoachBox deck={{ name: built.name, strategy: built.strategy, cards: built.cards }} />
          </div>
        )}
      </div>

      {/* Manual builder */}
      <ManualBuilder onSaved={(d) => setDecks((prev) => [d, ...prev])} />

      {/* Saved decks */}
      <div>
        <h2 className="mb-2 font-semibold">Saved decks</h2>
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
                    <span className="ml-2 chip bg-green-100 text-green-700">Shared</span>
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setViewing(null)}
        >
          <div
            className="card-panel max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-xl font-bold">{viewing.name}</h2>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className={`btn text-sm ${
                    viewing.shared
                      ? "text-green-700 hover:bg-green-50"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                  title={
                    viewing.shared
                      ? "Visible to other members — click to make private"
                      : "Share this deck with other members (they'll see it on the Friends page)"
                  }
                  onClick={() => toggleShareDeck(viewing)}
                >
                  {viewing.shared ? "✓ Shared" : "Share"}
                </button>
                <button
                  className="btn text-sm text-red-600 hover:bg-red-50"
                  onClick={() => deleteDeck(viewing.id)}
                >
                  Delete
                </button>
                <button
                  aria-label="Close"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
                  onClick={() => setViewing(null)}
                >
                  ✕
                </button>
              </div>
            </div>
            {viewing.strategy && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{viewing.strategy}</p>
            )}
            <DeckList cards={viewing.cards ?? []} />
            {(viewing.suggestions?.length ?? 0) > 0 && (
              <UpgradeList suggestions={viewing.suggestions!} />
            )}
            <CoachBox
              deck={{ name: viewing.name, strategy: viewing.strategy, cards: viewing.cards ?? [] }}
            />
          </div>
        </div>
      )}
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
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {groups[cat].map((c, i) => (
                    <div key={i} title={c.reason ?? c.name}>
                      <div className="relative">
                        {c.card_id && cardImages[c.card_id] ? (
                          <div className="aspect-[63/88] w-full overflow-hidden rounded">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={cardImages[c.card_id]!}
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
}
