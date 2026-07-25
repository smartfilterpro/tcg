"use client";

import { useEffect, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import type { Deck, DeckCardEntry } from "@/lib/types";

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
  missing_suggestions: string[];
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
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [showCowork, setShowCowork] = useState(false);

  useEffect(() => {
    fetch("/api/decks")
      .then((r) => r.json())
      .then((j) => setDecks(j.decks ?? []));
    fetch("/api/profile")
      .then((r) => r.json())
      .then((j) => setStyleNotes(j.styleNotes ?? ""));
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

  async function build() {
    setBuilding(true);
    setBuildStep(0);
    setError(null);
    setBuilt(null);
    const stepTimer = setInterval(
      () => setBuildStep((s) => Math.min(s + 1, BUILD_STEPS.length - 1)),
      15000
    );
    try {
      // Start the build as a background job (deck builds can outlast proxy
      // request timeouts), then poll until it's done.
      const res = await fetch("/api/decks/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const start = await safeJson(res);
      if (!res.ok) throw new Error((start.error as string) || "Deck build failed");
      const jobId = start.jobId as string;

      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
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
      }
      throw new Error("The build is taking unusually long — please try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deck build failed");
    } finally {
      clearInterval(stepTimer);
      setBuilding(false);
    }
  }

  async function saveDeck() {
    if (!built) return;
    const res = await fetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: built.name, strategy: built.strategy, cards: built.cards }),
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

  async function loadExportUrl() {
    const res = await fetch("/api/export/token");
    const json = await res.json();
    if (res.ok) {
      setExportUrl(`${window.location.origin}/api/export?token=${json.token}`);
    }
    setShowCowork(true);
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
              <div className="mt-3 rounded bg-amber-50 p-3 text-xs text-amber-800">
                <strong>Wishlist upgrades:</strong> {built.missing_suggestions.join(", ")}
              </div>
            )}
            <CoachBox deck={{ name: built.name, strategy: built.strategy, cards: built.cards }} />
          </div>
        )}
      </div>

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
                <div className="font-bold">{deck.name}</div>
                <div className="text-xs text-slate-500">
                  {(deck.cards ?? []).reduce((s, c) => s + c.quantity, 0)} cards ·{" "}
                  {new Date(deck.created_at).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Claude Cowork integration */}
      <div className="card-panel p-4">
        <h2 className="font-semibold">🔗 Build decks in Claude Cowork</h2>
        <p className="mb-2 mt-0.5 text-xs text-slate-500">
          Prefer chatting with Claude directly? Get your personal collection link and paste it into
          Claude Cowork (there&apos;s a ready-made deck-builder skill in the repo under{" "}
          <code className="rounded bg-slate-100 px-1">.claude/skills/</code>).
        </p>
        {!showCowork ? (
          <button className="btn-secondary text-sm" onClick={loadExportUrl}>
            Show my collection link
          </button>
        ) : (
          <div className="space-y-2">
            <input readOnly className="input font-mono text-xs" value={exportUrl ?? "…"} onFocus={(e) => e.target.select()} />
            <p className="text-xs text-slate-400">
              Anyone with this link can read your collection list. Keep it private — you can
              rotate it any time by asking the admin.
            </p>
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
            <div className="flex items-start justify-between">
              <h2 className="text-xl font-bold">{viewing.name}</h2>
              <button
                className="btn text-sm text-red-600 hover:bg-red-50"
                onClick={() => deleteDeck(viewing.id)}
              >
                Delete
              </button>
            </div>
            {viewing.strategy && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{viewing.strategy}</p>
            )}
            <DeckList cards={viewing.cards ?? []} />
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
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {(["pokemon", "trainer", "energy"] as const).map((cat) => (
          <div key={cat}>
            <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">
              {cat} ({groups[cat].reduce((s, c) => s + c.quantity, 0)})
            </h4>
            <ul className="space-y-0.5 text-sm">
              {groups[cat].map((c, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate" title={c.reason ?? undefined}>
                    {c.name}
                  </span>
                  <span className="shrink-0 font-semibold text-slate-500">×{c.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
}
