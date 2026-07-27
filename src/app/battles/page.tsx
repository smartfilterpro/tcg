"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Deck } from "@/lib/types";

interface BattleListItem {
  id: string;
  code: string;
  status: "waiting" | "active" | "finished";
  youAreHost: boolean;
  opponentName: string | null;
  youWon: boolean | null;
  updatedAt: string;
}

function deckSize(d: Deck): number {
  return (d.cards ?? []).reduce((n, c) => n + (c.quantity ?? 0), 0);
}

export default function BattlesPage() {
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [battles, setBattles] = useState<BattleListItem[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createDeck, setCreateDeck] = useState("");
  const [joinDeck, setJoinDeck] = useState("");
  const [joinCode, setJoinCode] = useState("");

  async function load() {
    try {
      const [dRes, bRes] = await Promise.all([fetch("/api/decks"), fetch("/api/battles")]);
      const dJson = await dRes.json();
      const bJson = await bRes.json();
      if (!dRes.ok) throw new Error(dJson.error || "Failed to load decks");
      if (!bRes.ok) throw new Error(bJson.error || "Failed to load battles");
      setDecks(dJson.decks ?? []);
      setBattles(bJson.battles ?? []);
      setMigrated(bJson.migrated !== false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function createBattle(e: React.FormEvent) {
    e.preventDefault();
    if (!createDeck || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId: createDeck }),
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

  const deckOptions = decks.map((d) => (
    <option key={d.id} value={d.id}>
      {d.name} ({deckSize(d)} cards)
    </option>
  ));

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

      {decks.length === 0 ? (
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
                      : `vs ${b.opponentName ?? "Trainer"}`}
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
