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
import { FanMark } from "@/components/Logo";
import { APP_NAME } from "@/lib/branding";
import { avatarColor, initialsFor } from "@/lib/avatar";

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

/** The small-caps label above a zone, per artboard 15. */
function ZoneLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[.08em] text-brand-ink5">
      {children}
    </span>
  );
}

function CardTile({ card, className }: { card: BattleCard; className: string }) {
  return card.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.image}
      alt={card.name}
      className={`${className} rounded-[6px] object-cover shadow-sm`}
    />
  ) : (
    <div
      className={`${className} flex items-end justify-center overflow-hidden rounded-[6px] border border-brand-line-strong bg-brand-panel-alt p-1 pb-1 text-center text-[8.5px] font-medium leading-[1.25] text-brand-ink2 shadow-sm`}
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
        <span className="absolute -right-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-brand-negative px-[5px] text-[10.5px] font-bold text-white shadow">
          {stack.damage}
        </span>
      )}
      {stack.attached.length > 0 && (
        <span className="absolute -bottom-[5px] -right-[5px] rounded-full bg-brand-ink2 px-[7px] py-0.5 font-mono text-[9px] font-medium text-white shadow">
          +{stack.attached.length}
        </span>
      )}
      {(stack.status?.length ?? 0) > 0 && (
        <span className="absolute -left-[5px] -top-1 text-xs drop-shadow">
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
      className="flex flex-col items-center gap-[3px]"
    >
      {/* A face-down card back. The mark sits behind the count rather than
          beside it, so the pile keeps the same footprint and the number stays
          the thing you read. */}
      <span className="relative flex aspect-[63/88] w-11 items-center justify-center overflow-hidden rounded-[6px] border border-brand-ink/50 bg-brand-ink font-display text-sm font-bold text-white shadow-sm">
        <FanMark size={28} reversed className="absolute opacity-30" />
        <span className="relative">{count}</span>
      </span>
      <span className="text-[10px] text-brand-ink4">{label}</span>
    </button>
  );
}

/** Turn/state chip. The artboard's three tints: waiting, ready, neutral. */
function StateChip({
  tone,
  children,
}: {
  tone: "warm" | "good" | "quiet";
  children: React.ReactNode;
}) {
  const tint =
    tone === "warm"
      ? "bg-[#FFF8E1] text-[#7A5A12]"
      : tone === "good"
        ? "bg-[#E8F7EC] text-brand-positive"
        : "bg-brand-sunken text-brand-ink3";
  return (
    <span
      className={`whitespace-nowrap rounded-full px-[11px] py-[5px] font-mono text-[11px] ${tint}`}
    >
      {children}
    </span>
  );
}

/** Panel chrome for the two player halves, the stadium and the log. */
const SIDE_PANEL = "rounded-2xl border border-brand-line bg-white p-4";
const STRIP_PANEL = "rounded-[14px] border border-brand-line bg-white";

/** The hand-wide actions under your hand. */
const HAND_CHIP =
  "whitespace-nowrap rounded-full bg-brand-sunken px-3 py-1.5 font-mono text-[11px] text-brand-ink3 hover:bg-brand-line disabled:opacity-50";

// One damage counter is 10 damage, so these are 1, 2, 3, 5 and 10 counters.
// Cards count counters, not totals ("30 more damage for each damage counter"),
// which is why the sheet shows the count alongside the number.
const DAMAGE_STEPS = [10, 20, 30, 50, 100, -10];

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

  async function rematch() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/battles/${id}/rematch`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't start the rematch");
      router.push(`/battles/${json.id}`);
      return;
    } catch (e) {
      showNotice(e instanceof Error ? e.message : "Couldn't start the rematch");
    }
    setBusy(false);
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
            title: `${APP_NAME} battle`,
            text: `⚔️ Battle me in ${APP_NAME}! Join code: ${data.code}`,
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
    <div className="mx-auto max-w-[900px] space-y-3 pb-4">
      <div className="flex items-center justify-between gap-2">
        <a href="/battles" className="text-sm text-brand-accent hover:underline">
          ← Battles
        </a>
        <span className="font-mono text-[11.5px] text-brand-ink4">code {data.code}</span>
      </div>

      {finished && (
        <div
          className={`rounded-2xl p-4 text-center font-display font-bold ${
            data.youWon ? "bg-[#E8F7EC] text-brand-positive" : "bg-brand-sunken text-brand-ink3"
          }`}
        >
          🏆 {data.youWon ? "You won!" : `${data.winnerName ?? oppName} wins!`}
          <div className="mt-2.5 flex flex-wrap justify-center gap-2 font-body text-[13.5px] font-normal">
            <button
              className="whitespace-nowrap rounded-full bg-brand-ink px-[18px] py-2.5 font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-50"
              disabled={busy}
              onClick={rematch}
            >
              {busy ? "Shuffling…" : "🔁 Rematch"}
            </button>
            <a
              href="/battles"
              className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[18px] py-2.5 font-medium hover:bg-brand-sunken"
            >
              Back to battles
            </a>
            <button className="text-[12.5px] text-brand-ink4 hover:underline" onClick={removeBattle}>
              Remove battle
            </button>
          </div>
        </div>
      )}

      {/* ===== Opponent side ===== */}
      <div className={SIDE_PANEL}>
        <div className="mb-[14px] flex items-center justify-between gap-3">
          <div className="flex items-center gap-[11px]">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
              style={{ background: avatarColor(oppName) }}
            >
              {initialsFor(oppName)}
            </span>
            <span className="text-[14.5px] font-medium">{oppName}</span>
          </div>
          {!finished && !view.myTurn && <StateChip tone="warm">their turn</StateChip>}
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-[9px]">
            <FaceDownPile count={opp.handCount} label="hand" />
            <FaceDownPile count={opp.deckCount} label="deck" />
            <FaceDownPile count={opp.prizeCount} label="prizes" />
            <button
              type="button"
              className="flex flex-col items-center gap-[3px]"
              onClick={() => setViewPile({ title: `${oppName}'s discard`, cards: opp.discard })}
            >
              <span className="flex aspect-[63/88] w-11 items-center justify-center rounded-[6px] border border-dashed border-brand-line-strong font-display text-sm font-bold text-brand-ink4">
                {opp.discard.length}
              </span>
              <span className="text-[10px] text-brand-ink4">discard</span>
            </button>
          </div>
          <div className="flex flex-col items-end gap-1">
            <ZoneLabel>active</ZoneLabel>
            {opp.active ? (
              <StackTile
                stack={opp.active}
                className="w-20"
                onClick={() => setSheet({ kind: "oppstack", target: "active" })}
              />
            ) : (
              <span className="flex aspect-[63/88] w-20 items-center justify-center rounded-[7px] border border-dashed border-brand-line-strong text-[10px] text-brand-ink5">
                none
              </span>
            )}
          </div>
        </div>
        {opp.bench.length > 0 && (
          <div className="mt-[14px]">
            <ZoneLabel>bench</ZoneLabel>
            <div className="mt-[5px] flex gap-[7px] overflow-x-auto">
              {opp.bench.map((s, i) => (
                <StackTile
                  key={s.face.uid}
                  stack={s}
                  className="w-12"
                  onClick={() => setSheet({ kind: "oppstack", target: i })}
                />
              ))}
            </div>
          </div>
        )}
        {opp.played.length > 0 && (
          <div className="mt-[14px]">
            <ZoneLabel>played this turn (tap to read)</ZoneLabel>
            <div className="mt-[5px] flex gap-[7px] overflow-x-auto">
              {opp.played.map((c) => (
                <button key={c.uid} type="button" className="shrink-0" onClick={() => setZoomCard(c)}>
                  <CardTile card={c} className="w-12" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ===== Stadium (shared zone) ===== */}
      {view.stadium && (
        <div className={`${STRIP_PANEL} flex items-center gap-3 px-[14px] py-[11px]`}>
          <button type="button" onClick={() => setZoomCard(view.stadium!.card)}>
            <CardTile card={view.stadium.card} className="w-[34px]" />
          </button>
          <div className="min-w-0 flex-1 text-[13px]">
            <b className="font-medium">🏟 Stadium: {view.stadium.card.name}</b>{" "}
            <span className="text-brand-ink5">
              (played by {view.stadium.mine ? "you" : oppName} — tap to read)
            </span>
          </div>
          {!finished && (
            <button
              className="shrink-0 whitespace-nowrap text-[12.5px] text-brand-accent hover:underline"
              disabled={busy}
              onClick={() => act({ type: "useStadium" })}
            >
              ⚡ used it
            </button>
          )}
          {!finished && (
            <button
              className="shrink-0 whitespace-nowrap text-[12.5px] text-brand-negative hover:underline"
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
      {notice && (
        <div className="rounded-[14px] border border-brand-line bg-white p-2.5 text-center text-[12.5px] text-brand-negative">
          {notice}
        </div>
      )}
      <div className={`${STRIP_PANEL} p-[14px]`}>
        <div
          ref={logRef}
          className="flex max-h-[108px] flex-col gap-[5px] overflow-y-auto text-[12.5px] leading-[1.5] text-brand-ink3"
        >
          {view.log.map((l, i) => (
            <div key={i}>{l.text}</div>
          ))}
        </div>
        <div className="mt-[11px] flex items-center justify-between gap-3 border-t border-brand-line-soft pt-2.5">
          {view.undo ? (
            <button
              className="max-w-[70%] shrink truncate whitespace-nowrap rounded-full bg-[#FFF8E1] px-[11px] py-[5px] font-mono text-[11px] text-[#7A5A12]"
              disabled={busy}
              onClick={() => act({ type: "undo" })}
              title={`Take back your last move: ${view.undo}`}
            >
              ↩️ Undo <span className="opacity-70">{view.undo}</span>
            </button>
          ) : (
            <span />
          )}
          <a
            href={`/api/battles/${id}/log`}
            download
            className="shrink-0 whitespace-nowrap text-[11.5px] text-brand-ink5 hover:text-brand-accent hover:underline"
            title="Download the whole game log as a text file — including the early turns that have scrolled out of view here"
          >
            ⬇ Export log
          </a>
        </div>
      </div>

      {/* ===== My side ===== */}
      <div className={SIDE_PANEL}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-[11px]">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-accent text-[11px] font-bold text-white"
            >
              {initialsFor(data.myName ?? "You")}
            </span>
            <span className="text-[14.5px] font-medium">{data.myName ?? "You"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {!finished && view.myTurn && (
              <StateChip tone={view.energyUsed ? "quiet" : "warm"}>
                {view.energyUsed ? "⚡ energy used" : "⚡ energy available"}
              </StateChip>
            )}
            {!finished && view.myTurn && <StateChip tone="good">your turn</StateChip>}
          </div>
        </div>

        {!finished && !me.active && me.bench.length === 0 && (
          <div className="mb-3 rounded-[10px] bg-[#FFF8E1] px-[13px] py-[11px] text-[12.5px] leading-[1.55] text-[#7A5A12]">
            <b>Setup:</b> play a Basic Pokémon as your Active and bench any others. No Basic in
            hand? Use <b>Redraw 7</b> below your hand — your Prize cards are already set.
          </div>
        )}
        {!finished && !me.active && me.bench.length > 0 && (
          <div className="mb-3 rounded-[10px] bg-[#FDF0EE] px-[13px] py-[11px] text-[12.5px] font-medium leading-[1.55] text-brand-negative">
            Choose a new Active — tap a Bench Pokémon, then “Move to Active”.
          </div>
        )}
        {!finished && view.myTurn && view.turnCount === 1 && (
          <div className="mb-3 rounded-[10px] bg-brand-accent-tint px-[13px] py-[11px] text-[12.5px] leading-[1.55] text-brand-ink2">
            <b>Turn 1:</b> whoever goes first can&apos;t attack or play a Supporter — the app
            won&apos;t stop you, it just keeps score.
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <ZoneLabel>active</ZoneLabel>
            {me.active ? (
              <StackTile
                stack={me.active}
                className="w-20 ring-[1.5px] ring-brand-accent"
                onClick={() => setSheet({ kind: "mystack", target: "active" })}
              />
            ) : (
              <span className="flex aspect-[63/88] w-20 items-center justify-center rounded-[7px] border border-dashed border-brand-line-strong p-1 text-center text-[10px] text-brand-ink5">
                tap a hand card
              </span>
            )}
          </div>
          <div className="flex gap-[9px]">
            <FaceDownPile count={me.deckCount} label="deck" onClick={() => setSheet({ kind: "deck" })} />
            <FaceDownPile
              count={me.prizeCount}
              label="prizes"
              onClick={() => setSheet({ kind: "prizes" })}
            />
            <button
              type="button"
              className="flex flex-col items-center gap-[3px]"
              onClick={() => setViewPile({ title: "Your discard", cards: me.discard, mine: true })}
            >
              <span className="flex aspect-[63/88] w-11 items-center justify-center rounded-[6px] border border-dashed border-brand-line-strong font-display text-sm font-bold text-brand-ink4">
                {me.discard.length}
              </span>
              <span className="text-[10px] text-brand-ink4">discard</span>
            </button>
          </div>
        </div>

        {me.bench.length > 0 && (
          <div className="mt-[14px]">
            <ZoneLabel>bench · {me.bench.length} of 5</ZoneLabel>
            <div className="mt-[5px] flex gap-[7px] overflow-x-auto">
              {me.bench.map((s, i) => (
                <StackTile
                  key={s.face.uid}
                  stack={s}
                  className="w-[54px]"
                  onClick={() => setSheet({ kind: "mystack", target: i })}
                />
              ))}
            </div>
          </div>
        )}
        {me.played.length > 0 && (
          <div className="mt-[14px]">
            <ZoneLabel>played this turn (discards when your turn ends)</ZoneLabel>
            <div className="mt-[5px] flex gap-[7px] overflow-x-auto">
              {me.played.map((c) => (
                <button key={c.uid} type="button" className="shrink-0" onClick={() => setZoomCard(c)}>
                  <CardTile card={c} className="w-12" />
                </button>
              ))}
            </div>
          </div>
        )}

        {!finished && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-brand-line-soft pt-[14px]">
            <button
              className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[18px] py-2.5 text-[13.5px] font-medium hover:bg-brand-sunken disabled:opacity-50"
              disabled={busy}
              onClick={() => act({ type: "draw" })}
            >
              🃏 Draw
            </button>
            <button
              className={`whitespace-nowrap rounded-full px-[18px] py-2.5 text-[13.5px] font-medium disabled:opacity-50 ${
                view.myTurn
                  ? "bg-brand-ink text-brand-canvas hover:bg-brand-ink2"
                  : "border border-brand-line-strong bg-white hover:bg-brand-sunken"
              }`}
              disabled={busy}
              onClick={() => act({ type: "endTurn" })}
            >
              End turn
            </button>
            <button
              className="whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[18px] py-2.5 text-[13.5px] font-medium hover:bg-brand-sunken disabled:opacity-50"
              disabled={busy}
              onClick={() => act({ type: "flipCoin" })}
            >
              🪙 Flip coin
            </button>
            {view.phase === "play" && !view.myTurn && (
              <button
                className="text-[12.5px] text-brand-ink4 hover:underline"
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
              className="ml-auto whitespace-nowrap text-[12.5px] text-brand-negative hover:underline"
              onClick={() => setSheet({ kind: "concede" })}
            >
              Concede
            </button>
          </div>
        )}

        <div className="mt-[14px]">
          <ZoneLabel>your hand ({me.hand.length})</ZoneLabel>
          {me.hand.length === 0 ? (
            <p className="py-2 text-[12.5px] text-brand-ink5">
              No cards in hand — draw from your deck.
            </p>
          ) : (
            <div className="mt-1.5 flex gap-[7px] overflow-x-auto pb-1">
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
          {!finished && (
            <div className="mt-2.5 flex flex-wrap gap-[7px]">
              <button
                className={HAND_CHIP}
                disabled={busy}
                onClick={() => act({ type: "redrawSeven" })}
                title="Shuffle your hand and Prize cards back, draw 7, set 6 prizes again"
              >
                🔄 Redraw 7
              </button>
              <button
                className={HAND_CHIP}
                disabled={busy || me.hand.length === 0}
                onClick={() => act({ type: "handToDeckAll" })}
              >
                🂠 Hand into deck
              </button>
              <button
                className={HAND_CHIP}
                disabled={busy || me.hand.length === 0}
                onClick={() => act({ type: "handToDeckAll", where: "bottom" })}
                title="Shuffle your hand and put it on the bottom of your deck, leaving the rest of the deck in order (Vivillon's Grand Wing, Roxanne-style effects)"
              >
                ⬇️ Hand to bottom
              </button>
              <button
                className={HAND_CHIP}
                disabled={busy || me.hand.length === 0}
                onClick={() => {
                  if (confirm(`Discard all ${me.hand.length} cards in your hand?`)) {
                    act({ type: "discardHand" });
                  }
                }}
              >
                🗑 Discard hand
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="mt-[14px] text-center text-[11.5px] leading-[1.6] text-brand-ink5">
        The app keeps score — Prize cards, the draw each turn, knockouts, poison and burn, and
        the win — and never blocks a play. Calling the rules is yours, just like across a table.
      </p>

      {/* ===== Action sheet ===== */}
      {sheet && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={() => setSheet(null)}
        >
          <div
            className="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-t-[20px] bg-brand-canvas p-[18px] sm:rounded-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <SheetContent
              sheet={sheet}
              me={me}
              opp={opp}
              oppName={oppName}
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
            className="mx-auto my-6 w-[92%] max-w-[min(56rem,94vw)] rounded-2xl bg-white p-4 sm:p-5"
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
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
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
            className="mx-auto my-6 w-[92%] max-w-[min(56rem,94vw)] rounded-2xl bg-white p-4 sm:p-5"
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
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
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
                    {!me.active && (
                      <button
                        className="text-green-700 hover:underline"
                        disabled={busy}
                        onClick={() => {
                          act({ type: "deckTake", uid: c.uid, to: "active", noShuffle: !searchShuffle });
                          setDeckSearch(null);
                        }}
                      >
                        → active
                      </button>
                    )}
                    {me.bench.length < 5 && (
                      <button
                        className="text-green-700 hover:underline"
                        disabled={busy}
                        onClick={() => {
                          act({ type: "deckTake", uid: c.uid, to: "bench", noShuffle: !searchShuffle });
                          setDeckSearch(null);
                        }}
                      >
                        → bench
                      </button>
                    )}
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
  busy: boolean;
  act: (a: BattleAction) => void;
  close: () => void;
  zoom: (c: BattleCard) => void;
  openDeckSearch: () => void;
}) {
  // Per artboard 15b: 13px of vertical room a thumb can actually hit, hairline
  // separators, and body-sized text — these are the game's real controls, not
  // a menu to squint at.
  const row =
    "block w-full border-b border-brand-line-soft py-[13px] text-left text-sm leading-[1.45] disabled:opacity-50";
  const rowGroup = "flex items-center gap-[9px] border-b border-brand-line-soft py-[13px] text-sm";
  const numChip =
    "rounded-full bg-brand-sunken px-3 py-[5px] font-mono text-[11.5px] font-medium text-brand-ink2 hover:bg-brand-line disabled:opacity-50";

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
        <div className={rowGroup}>
          <span>🔀 Shuffle all but the top:</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className={numChip}
              disabled={busy}
              onClick={() => act({ type: "shuffleDeck", keepTop: n })}
            >
              {n}
            </button>
          ))}
        </div>
        {(
          <>
            <button className={row} disabled={busy} onClick={openDeckSearch}>
              🔍 Search your deck — take a card, then shuffle
            </button>
            <div className={rowGroup}>
              <span>⛏ Discard from the top:</span>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  className={numChip}
                  disabled={busy}
                  onClick={() => act({ type: "millDeck", n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </>
        )}
        <button className={row} disabled={busy} onClick={() => act({ type: "mulligan" })}>
          ♻️ Mulligan — reveal your hand, reshuffle and draw 7 (opponent draws 1)
        </button>
        {(
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "draw", override: true })}
          >
            ✨ Draw (card effect / ability)
          </button>
        )}
        <button className="w-full pt-2.5 text-center text-sm text-brand-ink5" onClick={close}>
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
        <button className="w-full pt-2.5 text-center text-sm text-brand-ink5" onClick={close}>
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
        {(cat === "trainer" || cat === null) && !card.stad && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "playCard", handIndex: sheet.index })}
          >
            ▶️ Play {card.sup ? "Supporter" : "Trainer"}: {card.name} — onto the table, then
            discarded when your turn ends
          </button>
        )}
        {cat === "trainer" && (
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
        {me.active && canAttach && (
          <button
            className={row}
            disabled={busy}
            onClick={() => act({ type: "handToActive", handIndex: sheet.index, mode: "attach" })}
          >
            ⚡ Attach to {me.active.face.name}
          </button>
        )}
        {me.active && canEvolve && (
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
        {(canAttach || canEvolve) &&
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
        {cat === "energy" && me.active && (
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
        <div className={rowGroup}>
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
        <button className="w-full pt-2.5 text-center text-sm text-brand-ink5" onClick={close}>
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

      {mine &&
        sheet.target === "active" &&
        stack.face.cat === "pokemon" &&
        (stack.face.atk?.length ?? 0) === 0 && (
          <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
            No attack data found for this card yet — battles started after today&apos;s update
            fetch it automatically. Meanwhile, use the damage buttons on your opponent&apos;s
            Pokémon.
          </p>
        )}
      {mine && sheet.target === "active" && (stack.face.atk?.length ?? 0) > 0 && (
        <div className="mb-2">
          <span className="text-xs font-semibold text-slate-500">Attacks (ends your turn):</span>
          {stack.face.atk!.map((a, i) => (
            <button
              key={i}
              className="block w-full border-b border-slate-100 py-2.5 text-left"
              disabled={busy}
              onClick={() => {
                // Attacks the card gates on a coin get the coin FIRST.
                //
                // The engine can't roll it — a rules engine that calls
                // Math.random inside itself can't be replayed or tested —
                // and it won't read an unanswered flip as tails. So the
                // answer is collected here, before the attack is sent,
                // which is also the order it happens at a real table.
                const gated = stack.face.eff?.attacks?.[i]?.gate?.if === "coinFlip";
                if (!gated) return act({ type: "attack", attackIndex: i });
                const heads = Math.random() < 0.5;
                if (
                  !confirm(
                    `${a.name} needs a coin flip.\n\nFlipping… ${heads ? "HEADS" : "TAILS"}!\n\n${
                      heads ? "The attack hits." : "The attack does nothing."
                    }\n\nOK to continue.`
                  )
                ) {
                  return;
                }
                return act({ type: "attack", attackIndex: i, flip: heads });
              }}
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

      <div className="mb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            Damage:{" "}
            <span className="font-semibold text-slate-700">
              {stack.damage}
              {stack.face.hp ? ` / ${stack.face.hp}` : ""}
            </span>
            <span className="ml-1 text-slate-400">
              ({stack.damage / 10} counter{stack.damage === 10 ? "" : "s"})
            </span>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
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
          <button
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700"
            disabled={busy}
            onClick={() => {
              // Counters, not damage: "put 7 damage counters on" is how the
              // cards are worded, and 7 is easier to read off a card than 70.
              const raw = prompt("How many damage counters? (each is 10 damage)");
              if (raw == null) return;
              const n = Math.round(Number(raw.trim()));
              if (!Number.isFinite(n) || n === 0) return;
              act({
                type: "damage",
                side: mine ? "me" : "opp",
                target: sheet.target,
                delta: n * 10,
              });
            }}
          >
            +N…
          </button>
          {stack.damage > 0 && (
            <button
              className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700"
              disabled={busy}
              onClick={() =>
                act({
                  type: "damage",
                  side: mine ? "me" : "opp",
                  target: sheet.target,
                  delta: -stack.damage,
                })
              }
            >
              clear
            </button>
          )}
        </div>
      </div>

      {sheet.target === "active" && (
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
          <span className="text-xs font-semibold text-slate-500">
            Attached / under (tap a picture to read it):
          </span>
          {stack.attached.map((c, i) => (
            <div key={c.uid} className="flex items-center gap-2 border-b border-slate-100 py-1.5">
              <button type="button" className="shrink-0" onClick={() => zoom(c)}>
                <CardTile card={c} className="w-8" />
              </button>
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <button
                className="text-xs text-red-600"
                disabled={busy}
                onClick={() =>
                  act({
                    type: "detach",
                    target: sheet.target,
                    attachedIndex: i,
                    to: "discard",
                    side: mine ? "me" : "opp",
                  })
                }
              >
                discard
              </button>
              <button
                className="text-xs text-poke-blue"
                disabled={busy}
                onClick={() =>
                  act({
                    type: "detach",
                    target: sheet.target,
                    attachedIndex: i,
                    to: "hand",
                    side: mine ? "me" : "opp",
                  })
                }
              >
                to hand
              </button>
            </div>
          ))}
          {!mine && (
            <p className="pt-1 text-[10px] text-slate-400">
              Removing cards from {oppName}&apos;s Pokémon is for attack/card effects — it&apos;s
              announced in the log.
            </p>
          )}
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
                    (me.active.face.retreat ?? 0) > 0
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
                {(stack.face.retreat ?? 0) > 0
                  ? ` (discards ${stack.face.retreat} energy)`
                  : ""}
              </button>
            ))}
          {sheet.target === "active" && me.bench.length < 5 && (
            <button
              className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
              disabled={busy}
              onClick={() => act({ type: "benchActive" })}
            >
              🪑 Move to your Bench — leave Active empty (card effect)
            </button>
          )}
          {stack.attached.some((c) => c.cat === "pokemon" || c.cat == null) && (
            <div className={rowGroup}>
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
      {!mine && (
        <>
          <button
            className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
            disabled={busy}
            onClick={() => act({ type: "stackToDeck", target: sheet.target, side: "opp" })}
          >
            🔀 Shuffle into {oppName}&apos;s deck (with everything attached)
          </button>
          <button
            className="block w-full border-b border-slate-100 py-2.5 text-left text-sm"
            disabled={busy}
            onClick={() => act({ type: "stackToHand", target: sheet.target, side: "opp" })}
          >
            ✋ Return to {oppName}&apos;s hand (with everything attached)
          </button>
        </>
      )}
      <button className="w-full pt-2.5 text-center text-sm text-brand-ink5" onClick={close}>
        Close
      </button>
    </div>
  );
}
