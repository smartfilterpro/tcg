"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Deck } from "@/lib/types";

interface BattleListItem {
  id: string;
  code: string;
  status: "waiting" | "active" | "finished";
  youAreHost: boolean;
  vsBot: boolean;
  opponentName: string | null;
  youWon: boolean | null;
  updatedAt: string;
}

interface SharedDeck extends Deck {
  ownerName: string;
}

function deckSize(d: Deck): number {
  return (d.cards ?? []).reduce((n, c) => n + (c.quantity ?? 0), 0);
}

export default function BattlesPage() {
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [sharedDecks, setSharedDecks] = useState<SharedDeck[]>([]);
  const [battles, setBattles] = useState<BattleListItem[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createDeck, setCreateDeck] = useState("");
  const [allowShared, setAllowShared] = useState(false);
  const [joinDeck, setJoinDeck] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [practiceAllowed, setPracticeAllowed] = useState(false);
  const [practiceDeck, setPracticeDeck] = useState("");
  const [botDeck, setBotDeck] = useState("");

  async function load() {
    try {
      const [dRes, bRes, fRes] = await Promise.all([
        fetch("/api/decks"),
        fetch("/api/battles"),
        fetch("/api/friends"),
      ]);
      const dJson = await dRes.json();
      const bJson = await bRes.json();
      if (!dRes.ok) throw new Error(dJson.error || "Failed to load decks");
      if (!bRes.ok) throw new Error(bJson.error || "Failed to load battles");
      setDecks(dJson.decks ?? []);
      setBattles(bJson.battles ?? []);
      setMigrated(bJson.migrated !== false);
      setIsAdmin(bJson.isAdmin === true);
      setPracticeAllowed(bJson.practiceAllowed === true || bJson.isAdmin === true);
      // Shared decks are a bonus — don't fail the page if friends data errors.
      if (fRes.ok) {
        const fJson = await fRes.json();
        setSharedDecks(fJson.sharedDecks ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Battle invite links: /battles?code=ABCDE pre-fills the join form.
    try {
      const c = new URLSearchParams(window.location.search).get("code");
      if (c) setJoinCode(c.toUpperCase().slice(0, 8));
    } catch {}
  }, []);

  async function createBattle(e: React.FormEvent) {
    e.preventDefault();
    if (!createDeck || busy) return;
    setBusy(true);
    setError(null);
    try {
      const usingSharedDeck = sharedDecks.some((d) => d.id === createDeck);
      const res = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deckId: createDeck,
          allowShared: allowShared || usingSharedDeck,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't create the battle");
      router.push(`/battles/${json.id}`);
      return;
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't create the battle");
    }
    setBusy(false);
  }

  async function createPractice(e: React.FormEvent) {
    e.preventDefault();
    if (!practiceDeck || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deckId: practiceDeck,
          vsBot: true,
          botDeckId: botDeck || practiceDeck,
          allowShared: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't start the practice battle");
      router.push(`/battles/${json.id}`);
      return;
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't start the practice battle");
    }
    setBusy(false);
  }

  async function joinBattle(e: React.FormEvent) {
    e.preventDefault();
    if (!joinDeck || !joinCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/battles/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: joinCode, deckId: joinDeck }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't join the battle");
      router.push(`/battles/${json.id}`);
      return;
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't join the battle");
    }
    setBusy(false);
  }

  async function removeBattle(b: BattleListItem) {
    if (!confirm("Remove this battle?")) return;
    await fetch(`/api/battles/${b.id}`, { method: "DELETE" });
    load();
  }

  if (loading) return <p className="text-slate-500">Loading…</p>;

  const deckOptions = (
    <>
      <optgroup label="My decks">
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({deckSize(d)} cards)
          </option>
        ))}
      </optgroup>
      {sharedDecks.length > 0 && (
        <optgroup label="Shared decks (borrowed)">
          {sharedDecks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {d.ownerName} ({deckSize(d)} cards)
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Battles</h1>
        <p className="text-sm text-slate-500">
          Play your decks against a friend on a live shared board. The app shuffles, deals, and
          keeps the table — you two play by the real rules, just like sitting across from each
          other.
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {!migrated && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          Battles need a one-time database update — ask the admin to run{" "}
          <code>supabase/migrations/017_battles.sql</code>.
        </div>
      )}

      {decks.length === 0 && sharedDecks.length === 0 ? (
        <div className="card-panel p-4 text-sm text-slate-500">
          You need a deck first — build one on the{" "}
          <a href="/decks" className="text-poke-blue hover:underline">
            Decks page
          </a>
          , then come back to battle.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <form onSubmit={createBattle} className="card-panel space-y-3 p-4">
            <h2 className="font-semibold">⚔️ Start a battle</h2>
            <p className="text-xs text-slate-500">
              Pick a deck — you&apos;ll get a code to share with a friend.
            </p>
            <select
              className="input"
              value={createDeck}
              onChange={(e) => setCreateDeck(e.target.value)}
              required
            >
              <option value="">Choose your deck…</option>
              {deckOptions}
            </select>

            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={allowShared || sharedDecks.some((d) => d.id === createDeck)}
                disabled={sharedDecks.some((d) => d.id === createDeck)}
                onChange={(e) => setAllowShared(e.target.checked)}
              />
              <span>
                Allow shared decks — either player can borrow any deck members have shared
                {sharedDecks.some((d) => d.id === createDeck) &&
                  " (on, because you picked a shared deck)"}
              </span>
            </label>
            <button className="btn-primary w-full" disabled={busy || !createDeck}>
              {busy ? "Setting up…" : "Create battle"}
            </button>
          </form>

          <form onSubmit={joinBattle} className="card-panel space-y-3 p-4">
            <h2 className="font-semibold">🎟️ Join a battle</h2>
            <p className="text-xs text-slate-500">Enter the code your friend shared.</p>
            <input
              className="input uppercase tracking-widest"
              placeholder="CODE"
              maxLength={8}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              required
            />
            <select
              className="input"
              value={joinDeck}
              onChange={(e) => setJoinDeck(e.target.value)}
              required
            >
              <option value="">Choose your deck…</option>
              {deckOptions}
            </select>
            <button className="btn-primary w-full" disabled={busy || !joinDeck || !joinCode.trim()}>
              {busy ? "Joining…" : "Join battle"}
            </button>
          </form>
        </div>
      )}

      {/* The "practice battles are a Pro feature" upsell used to sit here.
          It sold something that is no longer for sale: the bot plays too
          poorly to charge for, so it is admin-only again and non-admins are
          shown nothing rather than a locked door to an empty room. Battles
          against other people are, and always were, free for everyone. */}
      {practiceAllowed && (decks.length > 0 || sharedDecks.length > 0) && (
        <form onSubmit={createPractice} className="card-panel space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">🤖 Practice vs Trainer AI</h2>
            <span className="chip bg-brand-sunken text-brand-ink3">Admin only</span>
          </div>
          <p className="text-xs text-slate-500">
            Play a deck against the practice opponent — no code, no waiting. It plays a
            straightforward game: benches Basics, attaches one Energy a turn, evolves what it can,
            and attacks with the hardest hit it can pay for. Card effects aren&apos;t resolved, so
            treat it as a way to see how your deck sets up rather than a real match.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-slate-600">
              Your deck
              <select
                className="input mt-1"
                value={practiceDeck}
                onChange={(e) => setPracticeDeck(e.target.value)}
                required
              >
                <option value="">Choose your deck…</option>
                {deckOptions}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600">
              Trainer AI plays
              <select
                className="input mt-1"
                value={botDeck}
                onChange={(e) => setBotDeck(e.target.value)}
              >
                <option value="">Same deck as yours</option>
                {deckOptions}
              </select>
            </label>
          </div>
          <button className="btn-primary w-full" disabled={busy || !practiceDeck}>
            {busy ? "Shuffling…" : "Start practice battle"}
          </button>
        </form>
      )}

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">My battles</h2>
        {battles.length === 0 ? (
          <p className="text-sm text-slate-400">No battles yet — start one above.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {battles.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {b.status === "waiting"
                      ? `Waiting for an opponent — code ${b.code}`
                      : `${b.vsBot ? "🤖 " : ""}vs ${b.opponentName ?? "Trainer"}`}
                  </div>
                  <div className="text-xs text-slate-400">
                    {new Date(b.updatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`chip ${
                      b.status === "active"
                        ? "bg-green-50 text-green-700"
                        : b.status === "waiting"
                          ? "bg-yellow-50 text-yellow-800"
                          : b.youWon
                            ? "bg-poke-blue/10 text-poke-blue"
                            : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {b.status === "active"
                      ? "In progress"
                      : b.status === "waiting"
                        ? "Open"
                        : b.youWon
                          ? "You won 🏆"
                          : "Finished"}
                  </span>
                  <a href={`/battles/${b.id}`} className="btn-secondary text-sm">
                    Open
                  </a>
                  <button
                    aria-label="Remove battle"
                    className="text-slate-400 hover:text-red-600"
                    onClick={() => removeBattle(b)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
