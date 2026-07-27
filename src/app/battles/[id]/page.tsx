"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type {
  BattleAction,
  BattleCard,
  BattleStack,
  BattleView,
  StatusCondition,
} from "@/lib/battle";

const STATUS_LIST: Array<{ key: StatusCondition; emoji: string; label: string }> = [
  { key: "poisoned", emoji: "☠️", label: "Poison" },
  { key: "burned", emoji: "🔥", label: "Burn" },
  { key: "asleep", emoji: "💤", label: "Asleep" },
  { key: "paralyzed", emoji: "⚡", label: "Paralyzed" },
  { key: "confused", emoji: "😵", label: "Confused" },
];

const STATUS_EMOJI: Record<string, string> = {
  poisoned: "☠️",
  burned: "🔥",
  asleep: "💤",
  paralyzed: "⚡",
  confused: "😵",
};

interface BattleData {
  status: "waiting" | "active" | "finished";
  code: string;
  version: number;
  opponentName?: string;
  myName?: string;
  winnerName?: string | null;
  youWon?: boolean | null;
  view?: BattleView;
}

type Sheet =
  | { kind: "hand"; index: number }
  | { kind: "mystack"; target: "active" | number }
  | { kind: "oppstack"; target: "active" | number }
  | { kind: "deck" }
  | { kind: "prizes" }
  | { kind: "concede" };

function CardTile({ card, className }: { card: BattleCard; className: string }) {
  return card.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.image}
      alt={card.name}
      className={`${className} rounded-md object-cover shadow-sm`}
    />
  ) : (
    <div
      className={`${className} flex items-center justify-center overflow-hidden rounded-md border border-slate-300 bg-slate-100 p-0.5 text-center text-[9px] font-semibold leading-tight text-slate-600 shadow-sm`}
    >
      {card.name}
    </div>
  );
}

function StackTile({
  stack,
  className,
  onClick,
}: {
  stack: BattleStack;
  className: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="relative shrink-0" onClick={onClick}>
      <CardTile card={stack.face} className={className} />
      {stack.damage > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
          {stack.damage}
        </span>
      )}
      {stack.attached.length > 0 && (
        <span className="absolute -bottom-1 -right-1 rounded-full bg-slate-700 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow">
          +{stack.attached.length}
        </span>
      )}
      {(stack.status?.length ?? 0) > 0 && (
        <span className="absolute -left-1 top-0 text-[11px] drop-shadow">
          {(stack.status ?? []).map((s) => STATUS_EMOJI[s] ?? "").join("")}
        </span>
      )}
    </button>
  );
}

function FaceDownPile({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex flex-col items-center gap-0.5"
    >
      <span className="flex aspect-[63/88] w-11 items-center justify-center rounded-md border border-slate-400 bg-gradient-to-b from-poke-red from-50% to-white to-50% text-sm font-bold text-slate-800 shadow-sm">
        {count}
      </span>
      <span className="text-[10px] text-slate-500">{label}</span>
    </button>
  );
}

const DAMAGE_STEPS = [10, 30, 50, -10];

export default function BattleBoardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<BattleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [viewPile, setViewPile] = useState<{ title: string; cards: BattleCard[]; mine?: boolean } | null>(null);
  const [zoomCard, setZoomCard] = useState<BattleCard | null>(null);
  const [deckSearch, setDeckSearch] = useState<BattleCard[] | null>(null);
  const [searchShuffle, setSearchShuffle] = useState(true);
  const [busy, setBusy] = useState(false);
  const dataRef = useRef<BattleData | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/battles/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load the battle");
      // Ignore stale polls that resolve after a newer action response.
      if (dataRef.current && json.version < dataRef.current.version) return;
      dataRef.current = json;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the battle");
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [data?.view?.log?.length]);

  function showNotice(text: string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }

  async function act(action: BattleAction) {
    if (busy) return;
    setBusy(true);
    setSheet(null);
    try {
      const res = await fetch(`/api/battles/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "That move didn't work");
      dataRef.current = json;
      setData(json);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : "That move didn't work");
    }
    setBusy(false);
  }

  async function openDeckSearch() {
    setSheet(null);
    try {
      const res = await fetch(`/api/battles/${id}/deck`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't open your deck");
      setDeckSearch(json.cards ?? []);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : "Couldn't open your deck");
    }
  }

  async function removeBattle() {
    if (!confirm("Remove this battle for both players?")) return;
    await fetch(`/api/battles/${id}`, { method: "DELETE" });
    router.push("/battles");
  }

  if (error && !data) return <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-slate-500">Loading the table…</p>;

  if (data.status === "waiting") {
    const inviteUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/battles?code=${data.code}`;
    const shareInvite = async () => {
      try {
        if (navigator.share) {
          await navigator.share({
            title: "PokéDeck battle",
            text: `⚔️ Battle me in PokéDeck! Join code: ${data.code}`,
            url: inviteUrl,
          });
          return;
        }
      } catch {
        return; // user closed the share sheet
      }
      try {
        await navigator.clipboard.writeText(inviteUrl);
        showNotice("Invite link copied — paste it to your friend!");
      } catch {
        showNotice(inviteUrl);
      }
    };
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-bold">Waiting for an opponent…</h1>
        <p className="text-sm text-slate-500">
          Send a friend the invite link — it opens the join form with this code filled in.
        </p>
        <div className="card-panel py-6 text-4xl font-black tracking-[0.3em] text-poke-blue">
          {data.code}
        </div>
        <div className="flex justify-center gap-2">
          <button className="btn-primary" onClick={shareInvite}>
            📤 Share invite link
          </button>
          <button className="btn-secondary" onClick={removeBattle}>
            Cancel battle
          </button>
        </div>
        {notice && <p className="break-all text-xs text-green-700">{notice}</p>}
        <p className="text-xs text-slate-400">This page updates by itself once they join.</p>
      </div>
    );
  }

  const view = data.view!;
  const me = view.me;
  const opp = view.opp;
  const oppName = data.opponentName ?? "Opponent";
  const finished = data.status === "finished";

  return (
    <div className="mx-auto max-w-2xl space-y-3 pb-4">
      <div className="flex items-center justify-between gap-2">
        <a href="/battles" className="text-sm text-poke-blue hover:underline">
          ← Battles
        </a>
        <span className="text-xs text-slate-400">code {data.code}</span>
      </div>

      {finished && (
        <div
          className={`rounded-xl p-4 text-center font-bold ${
            data.youWon ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          🏆 {data.youWon ? "You won!" : `${data.winnerName ?? oppName} wins!`}
          <div className="mt-2 flex justify-center gap-2 text-sm font-normal">
            <a href="/battles" className="btn-secondary">
              Back to battles
            </a>
            <button className="text-slate-500 hover:underline" onClick={removeBattle}>
              Remove battle
            </button>
          </div>
        </div>
      )}

      {/* ===== Opponent side ===== */}
      <div className="card-panel space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">{oppName}</div>
          {!finished &&
            (view.rules && view.phase === "setup" ? (
              <span className={`chip ${opp.ready ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                {opp.ready ? "ready" : "setting up"}
              </span>
            ) : (
              !view.myTurn && <span className="chip bg-yellow-50 text-yellow-800">their turn</span>
            ))}
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex gap-2">
            <FaceDownPile count={opp.handCount} label="hand" />
            <FaceDownPile count={opp.deckCount} label="deck" />
            <FaceDownPile count={opp.prizeCount} label="prizes" />
            <button
              type="button"
              className="flex flex-col items-center gap-0.5"
              onClick={() => setViewPile({ title: `${oppName}'s discard`, cards: opp.discard })}
            >
              <span className="flex aspect-[63/88] w-11 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm font-bold text-slate-500">
                {opp.discard.length}
              </span>
              <span className="text-[10px] text-slate-500">discard</span>
            </button>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-400">active</span>
            {opp.active ? (
              <StackTile
                stack={opp.active}
                className="w-20"
                onClick={() => setSheet({ kind: "oppstack", target: "active" })}
              />
            ) : (
              <span className="flex aspect-[63/88] w-20 items-center justify-center rounded-md border border-dashed border-slate-300 text-[10px] text-slate-400">
                none
              </span>
            )}
          </div>
        </div>
        {opp.bench.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto">
            {opp.bench.map((s, i) => (
              <StackTile
                key={s.face.uid}
                stack={s}
                className="w-12"
                onClick={() => setSheet({ kind: "oppstack", target: i })}
              />
            ))}
          </div>
        )}
      </div>

      {/* ===== Stadium (shared zone) ===== */}
      {view.stadium && (
        <div className="card-panel flex items-center gap-2 p-2">
          <button type="button" onClick={() => setZoomCard(view.stadium!.card)}>
            <CardTile card={view.stadium.card} className="w-10" />
          </button>
          <div className="min-w-0 flex-1 text-xs">
            <span className="font-semibold">🏟 Stadium: {view.stadium.card.name}</span>{" "}
            <span className="text-slate-400">
              (played by {view.stadium.mine ? "you" : oppName} — tap to read)
            </span>
          </div>
          {!finished && (
            <button
              className="shrink-0 text-xs text-red-500 hover:underline"
              disabled={busy}
              onClick={() => {
                if (confirm("Discard the Stadium?")) act({ type: "discardStadium" });
              }}
            >
              discard
            </button>
          )}
        </div>
      )}

      {/* ===== Log + notices ===== */}
      {notice && <div className="rounded-lg bg-red-50 p-2 text-center text-xs text-red-700">{notice}</div>}
      <div ref={logRef} className="card-panel h-24 overflow-y-auto p-2 text-xs text-slate-600">
        {view.log.map((l, i) => (
          <div key={i} className="py-0.5">
            {l.text}
          </div>
        ))}
      </div>

      {/* ===== My side ===== */}
      <div className="card-panel space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">{data.myName ?? "You"}</div>
          {!finished && view.myTurn && <span className="chip bg-green-50 text-green-700">your turn</span>}
        </div>
        {!finished && view.rules && view.phase === "setup" && (
          <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            {me.ready ? (
              <>
                <b>Ready!</b> Waiting for {oppName} to finish setup…
              </>
            ) : (
              <>
                <b>Setup:</b> play a Basic Pokémon as your Active and bench any others. No
                Basic in hand? Tap your deck pile → Mulligan. When your board is set,{" "}
                <button
                  type="button"
                  className="font-semibold underline"
                  disabled={busy}
                  onClick={() => act({ type: "ready" })}
                >
                  tap Ready
                </button>{" "}
                — prizes are set automatically.
              </>
            )}
          </div>
        )}
        {!finished && !view.rules && me.prizeCount === 0 && (
          <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            <b>Setup:</b> play a Basic Pokémon as your Active and bench any others. No Basic in
            hand? Tap your deck pile → Mulligan (your hand is revealed in the log, and your
            opponent may draw 1 extra card each time). Once your board is ready,{" "}
            <button
              type="button"
              className="font-semibold underline"
              disabled={busy}
              onClick={() => act({ type: "setPrizes" })}
            >
              set your 6 Prize cards
            </button>
            .
          </div>
        )}
        {!finished && view.rules && view.phase === "play" && !me.active && me.bench.length > 0 && (
          <div className="rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-700">
            Choose a new Active — tap a Bench Pokémon, then “Move to Active”.
          </div>
        )}
        {!finished && view.rules && view.phase === "play" && view.myTurn && view.turnCount === 1 && (
          <div className="rounded-lg bg-poke-blue/5 p-2 text-xs text-slate-600">
            <b>Turn 1:</b> you can play Basics, attach 1 energy, evolve nothing, and play
            Items — but no attacking and no Supporters on the game&apos;s very first turn.
          </div>
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-400">active</span>
            {me.active ? (
              <StackTile
                stack={me.active}
                className="w-20"
                onClick={() => setSheet({ kind: "mystack", target: "active" })}
              />
            ) : (
              <span className="flex aspect-[63/88] w-20 items-center justify-center rounded-md border border-dashed border-slate-300 text-[10px] text-slate-400">
                tap a hand card
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <FaceDownPile count={me.deckCount} label="deck" onClick={() => setSheet({ kind: "deck" })} />
            <FaceDownPile
              count={me.prizeCount}
              label="prizes"
              onClick={() => setSheet({ kind: "prizes" })}
            />
            <button
              type="button"
              className="flex flex-col items-center gap-0.5"
              onClick={() => setViewPile({ title: "Your discard", cards: me.discard, mine: true })}
            >
              <span className="flex aspect-[63/88] w-11 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm font-bold text-slate-500">
                {me.discard.length}
              </span>
              <span className="text-[10px] text-slate-500">discard</span>
            </button>
          </div>
        </div>
        {me.bench.length > 0 && (
          <div>
            <span className="text-[10px] uppercase tracking-wide text-slate-400">bench</span>
            <div className="mt-0.5 flex gap-1.5 overflow-x-auto">
              {me.bench.map((s, i) => (
                <StackTile
                  key={s.face.uid}
                  stack={s}
                  className="w-14"
                  onClick={() => setSheet({ kind: "mystack", target: i })}
                />
              ))}
            </div>
          </div>
        )}

        {!finished && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            {view.phase === "setup" ? (
              !me.ready && (
                <button
                  className="btn-primary text-sm"
                  disabled={busy || !me.active}
                  onClick={() => act({ type: "ready" })}
                >
                  ✅ Ready
                </button>
              )
            ) : (
              <>
                <button
                  className="btn-secondary text-sm"
                  disabled={busy}
                  onClick={() => act({ type: "draw" })}
                >
                  🃏 Draw
                </button>
                <button
                  className={`${view.myTurn ? "btn-primary" : "btn-secondary"} text-sm`}
                  disabled={busy}
                  onClick={() => act({ type: "endTurn" })}
                >
                  End turn
                </button>
              </>
            )}
            <button
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => act({ type: "flipCoin" })}
            >
              🪙 Flip coin
            </button>
            {view.phase === "play" && !view.myTurn && (
              <button
                className="text-xs text-slate-400 hover:underline"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Take the turn? Use this when you both agree the table is out of sync (someone forgot End turn) or a card effect passes the turn. It's announced in the log."
                    )
                  ) {
                    act({ type: "claimTurn" });
                  }
                }}
              >
                ⚠️ Take turn
              </button>
            )}
            <button
              className="ml-auto text-xs text-red-500 hover:underline"
              onClick={() => setSheet({ kind: "concede" })}
            >
              Concede
            </button>
          </div>
        )}

        <div>
          <span className="text-[10px] uppercase tracking-wide text-slate-400">
            your hand ({me.hand.length})
          </span>
          {me.hand.length === 0 ? (
            <p className="py-2 text-xs text-slate-400">No cards in hand — draw from your deck.</p>
          ) : (
            <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
              {me.hand.map((c, i) => (
                <button
                  key={c.uid}
                  type="button"
                  className="shrink-0"
                  onClick={() => setSheet({ kind: "hand", index: i })}
                  disabled={finished}
                >
                  <CardTile card={c} className="w-16" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-[11px] text-slate-400">
        {view.rules
          ? "Referee mode: turns, draws, energy limits, knockouts, and prizes are enforced — attacks and card effects are still yours to play. Options marked ✨ bypass a rule when a card allows it."
          : "The app keeps the table — you two enforce the rules, just like playing in person."}
      </p>

      {/* ===== Action sheet ===== */}
      {sheet && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={() => setSheet(null)}
        >
          <div
            className="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SheetContent
              sheet={sheet}
              me={me}
              opp={opp}
              oppName={oppName}
              rules={view.rules}
              phase={view.phase}
              busy={busy}
              act={act}
              close={() => setSheet(null)}
              zoom={setZoomCard}
              openDeckSearch={openDeckSearch}
            />
          </div>
        </div>
      )}

      {/* ===== Pile viewer ===== */}
      {viewPile && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/40"
          onClick={() => setViewPile(null)}
        >
          <div
            className="mx-auto my-6 w-[92%] max-w-md rounded-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">{viewPile.title}</h2>
              <button className="text-slate-400" onClick={() => setViewPile(null)}>
                ✕
              </button>
            </div>
            {viewPile.cards.length === 0 ? (
              <p className="text-sm text-slate-400">Empty.</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-slate-400">
                  Tap a card to read it{viewPile.mine ? " — “↩ hand” recovers it (card effects)" : ""}.
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {viewPile.cards.map((c, i) => (
                    <div key={c.uid}>
                      <button type="button" className="w-full" onClick={() => setZoomCard(c)}>
                        <CardTile card={c} className="w-full" />
                      </button>
                      {viewPile.mine && (
                        <button
                          className="mt-0.5 w-full text-center text-[10px] text-poke-blue hover:underline"
                          disabled={busy}
                          onClick={() => {
                            act({ type: "discardToHand", discardIndex: i });
                            setViewPile(null);
                          }}
                        >
                          ↩ hand
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== Deck search (own deck, alphabetized — order stays secret) ===== */}
      {deckSearch && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/40"
          onClick={() => setDeckSearch(null)}
        >
          <div
            className="mx-auto my-6 w-[92%] max-w-md rounded-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold">🔍 Search your deck ({deckSearch.length})</h2>
              <button className="text-slate-400" onClick={() => setDeckSearch(null)}>
                ✕
              </button>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              Cards are shown A→Z (the real order stays secret). Tap a card to read it, then
              take it to your hand or put it on top. Your opponent only sees that you took 1
              card.
            </p>
            <label className="mb-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={searchShuffle}
                onChange={(e) => setSearchShuffle(e.target.checked)}
              />
              <span>
                Shuffle the rest of the deck afterwards (normal for searches — untick only
                when a card effect says not to shuffle)
              </span>
            </label>
            <div className="grid grid-cols-4 gap-2">
              {deckSearch.map((c) => (
                <div key={c.uid}>
                  <button type="button" className="w-full" onClick={() => setZoomCard(c)}>
                    <CardTile card={c} className="w-full" />
                  </button>
                  <span className="block truncate text-center text-[10px] text-slate-500">
                    {c.name}
                  </span>
                  <div className="mt-0.5 flex justify-center gap-1 text-[10px]">
                    <button
                      className="text-poke-blue hover:underline"
                      disabled={busy}
                      onClick={() => {
                        act({ type: "deckTake", uid: c.uid, to: "hand", noShuffle: !searchShuffle });
                        setDeckSearch(null);
                      }}
                    >
                      → hand
                    </button>
                    <button
                      className="text-slate-500 hover:underline"
                      disabled={busy}
                      onClick={() => {
                        act({ type: "deckTake", uid: c.uid, to: "top", noShuffle: !searchShuffle });
                        setDeckSearch(null);
                      }}
                    >
                      → top
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== Read-the-card zoom ===== */}
      {zoomCard && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoomCard(null)}
        >
          {zoomCard.big || zoomCard.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={zoomCard.big ?? zoomCard.image!}
              alt={zoomCard.name}
              className="max-h-[90vh] w-auto max-w-full rounded-xl shadow-2xl"
            />
          ) : (
            <div className="max-w-sm rounded-xl bg-white p-4 text-sm">
              <h2 className="mb-1 font-semibold">{zoomCard.name}</h2>
              {zoomCard.rules?.length ? (
                zoomCard.rules.map((r, i) => (
                  <p key={i} className="text-slate-600">
                    {r}
                  </p>
                ))
              ) : (
                <p className="text-slate-400">No card text on file.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SheetContent({
  sheet,
  me,
  opp,
  oppName,
  rules,
  phase,
  busy,
  act,
  close,
  zoom,
  openDeckSearch,
}: {
  sheet: Sheet;
  me: BattleView["me"];
  opp: BattleView["opp"];
  oppName: string;
  rules: boolean;
  phase: "setup" | "play";
  busy: boolean;
  act: (a: BattleAction) => void;
  close: () => void;
  zoom: (c: BattleCard) => void;
  openDeckSearch: () => void;
}) {
  const row = "block w-full border-b border-slate-100 py-2.5 text-left text-sm";

  if (sheet.kind === "concede") {
    return (
      <div className="space-y-3 text-center">
        <h2 className="font-semibold">Concede the battle?</h2>
        <p className="text-sm text-slate-500">{oppName} will be declared the winner.</p>
        <div className="flex justify-center gap-2">
          <button className="btn-secondary" onClick={close}>
            Keep playing
          </button>
          <button
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
            disabled={busy}
            onClick={() => act({ type: "concede" })}
          >
            Concede
          </button>
        </div>
      </div>
    );
  }

  if (sheet.kind === "deck") {
    return (
      <div>
        <h2 className="mb-1 font-semibold">Your deck ({me.deckCount})</h2>
        <button className={row} disabled={busy} onClick={() => act({ type: "draw" })}>
          🃏 Draw a card
        </button>
        <button className={row} disabled={busy} onClick={() => act({ type: "shuffleDeck" })}>
          🔀 Shuffle deck
        </button>
        <div className="flex items-center gap-2 border-b border-slate-100 py-2.5 text-sm">
          <span>🔀 Shuffle all but the top:</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-700"
              disabled={busy}
              onClick={() => act({ type: "shuffleDeck", keepTop: n })}
            >
              {n}
            </button>
          ))}
        </div>
        {(!rules || phase === "play") && (
          <>
            <button className={row} disabled={busy} onClick={openDeckSearch}>
              🔍 Search your deck — take a card, then shuffle
            </button>
            <div className="flex items-center gap-2 border-b border-slate-100 py-2.5 text-sm">
              <span>⛏ Discard from the top:</span>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-700"
                  disabled={busy}
                  onClick={() => act({ type: "millDeck", n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </>
        )}
        {(!rules || phase === "setup") && (
          <button className={row} disabled={busy} onClick={() => act({ type: "mulligan" })}>
            ♻️ Mulligan — no Basic Pokémon? Reveal, reshuffle, draw 7
          </button>
        )}
        {!rules && me.prizeCount === 0 && (
          <button className={row} disabled={busy} onClick={() => act({ type: "setPrizes" })}>
            🏆 Set your 6 Prize cards (once mulligans are done)
          </button>
        )}
        {rules && phase === "play" && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "draw", override: true })}
          >
            ✨ Draw (card effect / ability)
          </button>
        )}
        <button className="w-full py-2.5 text-sm text-slate-400" onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  if (sheet.kind === "prizes") {
    return (
      <div>
        <h2 className="mb-1 font-semibold">Your Prize cards ({me.prizeCount})</h2>
        <p className="mb-1 text-xs text-slate-500">
          Take one after you knock out an opposing Pokémon.
        </p>
        <button className={row} disabled={busy} onClick={() => act({ type: "takePrize" })}>
          🏆 Take a Prize card into your hand
        </button>
        <button className="w-full py-2.5 text-sm text-slate-400" onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  if (sheet.kind === "hand") {
    const card = me.hand[sheet.index];
    if (!card) return null;
    // Only offer moves that make sense for what this card IS. Unknown
    // categories (custom cards) keep every option.
    const cat = card.cat ?? null;
    const isPoke = cat === "pokemon" || cat === null;
    const canBoard = isPoke && card.basic !== false; // Basics (or unknown) hit the board
    const canEvolve = isPoke && card.basic !== true; // evolutions (or unknown) go on top
    const canAttach = cat === "energy" || cat === "trainer" || cat === null; // energy + tools
    const inPlay = !rules || phase === "play";
    const catLabel =
      cat === "energy" ? "Energy" : cat === "trainer" ? "Trainer" : cat === "pokemon" ? "Pokémon" : null;
    return (
      <div>
        <div className="mb-2 flex items-center gap-3">
          <button type="button" onClick={() => zoom(card)}>
            <CardTile card={card} className="w-14" />
          </button>
          <div>
            <h2 className="font-semibold">{card.name}</h2>
            {catLabel && (
              <p className="text-xs text-slate-500">
                {catLabel}
                {cat === "pokemon" && card.basic != null && (card.basic ? " · Basic" : " · Evolution")}
              </p>
            )}
            <p className="text-[10px] text-slate-400">tap the picture to read the card</p>
          </div>
        </div>
        {(card.abilities?.length || card.rules?.length) && (
          <div className="mb-2 space-y-1 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
            {card.abilities?.map((a) => (
              <p key={a.name}>
                <b>{a.name}:</b> {a.text}
              </p>
            ))}
            {card.rules?.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        )}
        {rules && phase === "setup" && cat === "energy" && (
          <p className="border-b border-slate-100 py-2.5 text-sm text-slate-500">
            Energy attaches to your Pokémon once the battle starts — keep it in hand for now.
          </p>
        )}
        {rules && phase === "play" && cat === "trainer" && !card.stad && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "playCard", handIndex: sheet.index })}
          >
            ▶️ Play {card.name} (then to your discard)
          </button>
        )}
        {inPlay && cat === "trainer" && (
          <button
            className={`${row}${card.stad ? "" : " text-slate-500"}`}
            disabled={busy}
            onClick={() => act({ type: "playStadium", handIndex: sheet.index })}
          >
            🏟 Play as Stadium — stays in play{card.stad ? "" : " (if this is a Stadium card)"}
          </button>
        )}
        {!me.active && canBoard && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "handToActive", handIndex: sheet.index, mode: "new" })}
          >
            ⭐ Play as your Active Pokémon
          </button>
        )}
        {me.active && inPlay && canAttach && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "handToActive", handIndex: sheet.index, mode: "attach" })}
          >
            ⚡ Attach to {me.active.face.name}
          </button>
        )}
        {me.active && inPlay && canEvolve && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "handToActive", handIndex: sheet.index, mode: "evolve" })}
          >
            ⬆️ Evolve {me.active.face.name}
          </button>
        )}
        {me.bench.length < 5 && canBoard && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "handToBench", handIndex: sheet.index, mode: "new" })}
          >
            🪑 Play to your Bench
          </button>
        )}
        {inPlay &&
          (canAttach || canEvolve) &&
          me.bench.map((s, i) => (
            <div key={s.face.uid} className="flex items-center gap-2 border-b border-slate-100">
              <span className="min-w-0 flex-1 truncate py-2.5 text-sm text-slate-500">
                Bench: {s.face.name}
              </span>
              {canAttach && (
                <button
                  className="text-sm text-poke-blue"
                  disabled={busy}
                  onClick={() =>
                    act({ type: "handToBench", handIndex: sheet.index, benchIndex: i, mode: "attach" })
                  }
                >
                  attach
                </button>
              )}
              {canEvolve && (
                <button
                  className="text-sm text-poke-blue"
                  disabled={busy}
                  onClick={() =>
                    act({ type: "handToBench", handIndex: sheet.index, benchIndex: i, mode: "evolve" })
                  }
                >
                  evolve
                </button>
              )}
            </div>
          ))}
        {rules && phase === "play" && cat === "energy" && me.active && (
          <button
            className={`${row} text-slate-500`}
            disabled={busy}
            onClick={() =>
              act({ type: "handToActive", handIndex: sheet.index, mode: "attach", override: true })
            }
          >
            ✨ Attach to {me.active.face.name} as a card effect (skips one-per-turn)
          </button>
        )}
        <button
          className={row}
          disabled={busy}
          onClick={() => act({ type: "reveal", handIndex: sheet.index })}
        >
          📤 Reveal to {oppName} (shows the name in the log)
        </button>
        <div className="flex items-center gap-2 border-b border-slate-100 py-2.5 text-sm">
          <span>🂠 To your deck:</span>
          {(["top", "bottom", "shuffle"] as const).map((where) => (
            <button
              key={where}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
              disabled={busy}
              onClick={() => act({ type: "handToDeck", handIndex: sheet.index, where })}
            >
              {where}
            </button>
          ))}
        </div>
        <button
          className={`${row} text-red-600`}
          disabled={busy}
          onClick={() => act({ type: "handToDiscard", handIndex: sheet.index })}
        >
          🗑 Discard
        </button>
        <button className="w-full py-2.5 text-sm text-slate-400" onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  // My stack or opponent's stack
  const mine = sheet.kind === "mystack";
  const side = mine ? me : opp;
  const stack = sheet.target === "active" ? side.active : side.bench[sheet.target];
  if (!stack) return null;

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <button type="button" onClick={() => zoom(stack.face)}>
          <CardTile card={stack.face} className="w-14" />
        </button>
        <div>
          <h2 className="font-semibold">
            {mine ? "" : `${oppName}'s `}
            {stack.face.name}
          </h2>
          <p className="text-xs text-slate-500">
            {stack.damage} damage{stack.face.hp ? ` / ${stack.face.hp} HP` : ""}
          </p>
          {(stack.face.weak || stack.face.resist || stack.face.retreat != null) && (
            <p className="text-[11px] text-slate-400">
              {stack.face.weak && `Weak: ${stack.face.weak} ×2`}
              {stack.face.resist && ` · Resist: ${stack.face.resist} −30`}
              {stack.face.retreat != null && ` · Retreat: ${stack.face.retreat}⚡`}
            </p>
          )}
          <p className="text-[10px] text-slate-400">tap the picture to read the card</p>
        </div>
      </div>
      {(stack.face.abilities?.length ?? 0) > 0 && (
        <div className="mb-2 space-y-1 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
          {stack.face.abilities!.map((a, ai) => (
            <p key={a.name}>
              <b>Ability — {a.name}:</b> {a.text}
              {mine && (
                <button
                  className="ml-1 text-poke-blue hover:underline"
                  disabled={busy}
                  onClick={() => act({ type: "useAbility", target: sheet.target, abilityIndex: ai })}
                >
                  announce use
                </button>
              )}
            </p>
          ))}
        </div>
      )}

      {mine && sheet.target === "active" && rules && phase === "play" && (stack.face.atk?.length ?? 0) > 0 && (
        <div className="mb-2">
          <span className="text-xs font-semibold text-slate-500">Attacks (ends your turn):</span>
          {stack.face.atk!.map((a, i) => (
            <button
              key={i}
              className="block w-full border-b border-slate-100 py-2.5 text-left"
              disabled={busy}
              onClick={() => act({ type: "attack", attackIndex: i })}
            >
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold">⚔️ {a.name}</span>
                <span className="shrink-0 text-slate-500">
                  {a.cost.filter((c) => c.toLowerCase() !== "free").length}⚡ · {a.damage || "—"}
                </span>
              </span>
              {a.text && <span className="block text-xs text-slate-400">{a.text}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Damage:</span>
        {DAMAGE_STEPS.map((d) => (
          <button
            key={d}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700"
            disabled={busy}
            onClick={() =>
              act({ type: "damage", side: mine ? "me" : "opp", target: sheet.target, delta: d })
            }
          >
            {d > 0 ? `+${d}` : d}
          </button>
        ))}
      </div>

      {sheet.target === "active" && rules && phase === "play" && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Status:</span>
          {STATUS_LIST.map(({ key, emoji, label }) => {
            const on = (stack.status ?? []).includes(key);
            return (
              <button
                key={key}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  on ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-500"
                }`}
                disabled={busy}
                onClick={() =>
                  act({
                    type: "setStatus",
                    side: mine ? "me" : "opp",
                    target: "active",
                    status: key,
                    on: !on,
                  })
                }
              >
                {emoji} {label}
              </button>
            );
          })}
        </div>
      )}

      {stack.attached.length > 0 && (
        <div className="mb-1">
          <span className="text-xs font-semibold text-slate-500">Attached / under:</span>
          {stack.attached.map((c, i) => (
            <div key={c.uid} className="flex items-center gap-2 border-b border-slate-100 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              {mine && (
                <>
                  <button
                    className="text-xs text-red-600"
                    disabled={busy}
                    onClick={() =>
                      act({ type: "detach", target: sheet.target, attachedIndex: i, to: "discard" })
                    }
                  >
                    discard
                  </button>
                  <button
                    className="text-xs text-poke-blue"
                    disabled={busy}
                    onClick={() =>
                      act({ type: "detach", target: sheet.target, attachedIndex: i, to: "hand" })
                    }
                  >
                    to hand
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {mine && (
        <>
          {sheet.target !== "active" && (
            <button
              className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
              disabled={busy}
              onClick={() => act({ type: "promote", benchIndex: sheet.target as number })}
            >
              ⭐ Move to Active{" "}
              {me.active
                ? `(retreat ${me.active.face.name}${
                    rules && phase === "play" && (me.active.face.retreat ?? 0) > 0
                      ? ` — discards ${me.active.face.retreat} energy`
                      : ""
                  })`
                : ""}
            </button>
          )}
          {sheet.target === "active" &&
            me.bench.map((b, bi) => (
              <button
                key={b.face.uid}
                className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
                disabled={busy}
                onClick={() => act({ type: "promote", benchIndex: bi })}
              >
                🔁 Retreat — switch with {b.face.name}
                {rules && phase === "play" && (stack.face.retreat ?? 0) > 0
                  ? ` (discards ${stack.face.retreat} energy)`
                  : ""}
              </button>
            ))}
          {stack.attached.some((c) => c.cat === "pokemon" || c.cat == null) && (
            <div className="flex items-center gap-2 border-b border-slate-100 py-2.5 text-sm">
              <span>⬇️ Devolve {stack.face.name} to:</span>
              <button
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
                disabled={busy}
                onClick={() => act({ type: "devolve", target: sheet.target, to: "hand" })}
              >
                hand
              </button>
              <button
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
                disabled={busy}
                onClick={() => act({ type: "devolve", target: sheet.target, to: "discard" })}
              >
                discard
              </button>
            </div>
          )}
          <button
            className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
            disabled={busy}
            onClick={() => act({ type: "stackToHand", target: sheet.target })}
          >
            ✋ Pick up into your hand
          </button>
          <button
            className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
            disabled={busy}
            onClick={() => act({ type: "stackToDeck", target: sheet.target })}
          >
            🔀 Shuffle into your deck (with everything attached)
          </button>
          <button
            className="block w-full border-b border-slate-100 py-2.5 text-left text-sm text-red-600"
            disabled={busy}
            onClick={() => act({ type: "knockout", target: sheet.target })}
          >
            ☠️ Knocked Out — send to discard
          </button>
        </>
      )}
      {!mine && sheet.target !== "active" && (
        <button
          className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
          disabled={busy}
          onClick={() => act({ type: "promoteOpp", benchIndex: sheet.target as number })}
        >
          ⭐ Switch this to {oppName}&apos;s Active — gust card effect (Boss&apos;s Orders
          etc.)
        </button>
      )}
      <button className="w-full py-2.5 text-sm text-slate-400" onClick={close}>
        Close
      </button>
    </div>
  );
}
