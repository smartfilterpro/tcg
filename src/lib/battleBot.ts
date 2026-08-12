// A practice opponent.
//
// Two pieces, deliberately separate. `legalMoves` enumerates what a side can
// actually do right now; `chooseMove` picks one by simple priorities. The
// enumerator is the valuable half: the battle engine stopped refusing moves
// when refereeing was dropped (players call their own game), which is right
// for humans and useless for a bot — it would happily attach a second energy
// or attack for damage it can't pay. Enumerating first means a bot, of any
// kind, can only choose from moves that make sense.
//
// It is also what any smarter opponent would need. Handing a model a short
// list to pick from is cheaper and safer than letting it invent actions.

import type { BattleAction, BattleCard, BattleState, SideState } from "@/lib/battle";
import { payCost } from "@/lib/energy";

/** The opponent's user id in a practice battle. Not a real profile row —
 *  battles against the bot leave guest_user null and key the second side by
 *  this instead. */
export const BOT_ID = "bot";

export interface Move {
  action: BattleAction;
  /** Shown in the log and, later, offered to a model to choose between. */
  label: string;
}

function isPokemon(card: BattleCard): boolean {
  return card.cat === "pokemon" || card.cat == null;
}

/** Attacks this Pokémon can pay for right now.
 *
 *  By colour, not by count. Counting is what let the bot swing a Fire attack
 *  off two Psychic energy — legal-looking to the enumerator and nonsense at
 *  the table. */
export function affordableAttacks(stack: {
  face: BattleCard;
  attached: BattleCard[];
}): Array<{ index: number; damage: number; name: string }> {
  const out: Array<{ index: number; damage: number; name: string }> = [];
  (stack.face.atk ?? []).forEach((a, index) => {
    if (!payCost(a.cost, stack.attached).ok) return;
    const damage = parseInt(a.damage.replace(/\D/g, ""), 10);
    out.push({ index, damage: Number.isFinite(damage) ? damage : 0, name: a.name });
  });
  return out;
}

/** Everything this side could legally do this turn.
 *
 *  Deliberately conservative: only the moves a straightforward game needs.
 *  Nothing here reaches for deck searching, abilities or card effects, so a
 *  practice game is honest about being a practice game rather than pretending
 *  to resolve text it doesn't understand. */
export function legalMoves(
  state: BattleState,
  meId: string,
  opts: { energyUsed: boolean; supporterUsed: boolean; firstTurn: boolean }
): Move[] {
  const me: SideState | undefined = state.sides[meId];
  if (!me) return [];
  const moves: Move[] = [];

  // Setup: something has to be Active before anything else matters.
  if (!me.active) {
    me.hand.forEach((card, handIndex) => {
      if (isPokemon(card) && card.basic !== false) {
        moves.push({
          action: { type: "handToActive", handIndex, mode: "new" },
          label: `Play ${card.name} as Active`,
        });
      }
    });
    if (moves.length === 0) {
      me.bench.forEach((b, benchIndex) => {
        moves.push({ action: { type: "promote", benchIndex }, label: `Promote ${b.face.name}` });
      });
    }
    if (moves.length === 0) {
      // No Basic anywhere: mulligan. Without this the bot has no legal move
      // at all, ends its turn, and draws one card a turn until a Basic turns
      // up — it sat out the first seven turns of a test game doing exactly
      // that, then lost with an empty bench.
      moves.push({ action: { type: "redrawSeven" }, label: "No Basic Pokémon — redraw" });
    }
    return moves;
  }

  me.hand.forEach((card, handIndex) => {
    // Basics to the bench
    if (isPokemon(card) && card.basic !== false && me.bench.length < 5) {
      moves.push({
        action: { type: "handToBench", handIndex, mode: "new" },
        label: `Bench ${card.name}`,
      });
    }
    // Energy — one a turn, onto anything in play
    if (card.cat === "energy" && !opts.energyUsed) {
      if (me.active) {
        moves.push({
          action: { type: "handToActive", handIndex, mode: "attach" },
          label: `Attach ${card.name} to ${me.active.face.name}`,
        });
      }
      me.bench.forEach((b, benchIndex) => {
        moves.push({
          action: { type: "handToBench", handIndex, benchIndex, mode: "attach" },
          label: `Attach ${card.name} to ${b.face.name}`,
        });
      });
    }
    // Evolutions, onto anything that didn't arrive this turn
    if (isPokemon(card) && card.basic === false && !opts.firstTurn) {
      if (me.active && (me.active.playedTurn ?? 0) !== state.turnCount) {
        moves.push({
          action: { type: "handToActive", handIndex, mode: "evolve" },
          label: `Evolve ${me.active.face.name} into ${card.name}`,
        });
      }
      me.bench.forEach((b, benchIndex) => {
        if ((b.playedTurn ?? 0) === state.turnCount) return;
        moves.push({
          action: { type: "handToBench", handIndex, benchIndex, mode: "evolve" },
          label: `Evolve ${b.face.name} into ${card.name}`,
        });
      });
    }
    // Trainers. Supporters are once a turn and barred on the opening turn;
    // Stadiums are left alone because their effects aren't modelled.
    if (card.cat === "trainer" && !card.stad) {
      const supporterBlocked = card.sup && (opts.supporterUsed || opts.firstTurn);
      if (!supporterBlocked) {
        moves.push({
          action: { type: "playCard", handIndex },
          label: `Play ${card.name}${card.sup ? " (Supporter)" : ""}`,
        });
      }
    }
  });

  // Attacks, if there's something to attack
  if (me.active && !opts.firstTurn) {
    const opp = Object.entries(state.sides).find(([id]) => id !== meId)?.[1];
    if (opp?.active) {
      for (const a of affordableAttacks(me.active)) {
        moves.push({
          action: { type: "attack", attackIndex: a.index },
          label: `Attack with ${a.name}`,
        });
      }
    }
  }

  moves.push({ action: { type: "endTurn" }, label: "End turn" });
  return moves;
}

/** Score a move. Higher is played sooner.
 *
 *  A deliberately plain opponent: it develops the board, powers up its
 *  Active and swings when it can. Predictable is the point — a practice
 *  partner you can run ten times and read the difference as your deck
 *  rather than its mood. */
function score(move: Move, state: BattleState, meId: string): number {
  const me = state.sides[meId];
  const action = move.action;
  switch (action.type) {
    case "handToActive":
      if (action.mode === "new") return 100;
      if (action.mode === "evolve") return 70;
      return 60; // energy onto the Active is the usual right answer
    case "promote":
      return 95;
    case "handToBench":
      if (action.mode === "new") return (me?.bench.length ?? 0) < 3 ? 80 : 40;
      if (action.mode === "evolve") return 65;
      return 35; // energy onto the bench, only if nothing better
    case "playCard":
      return 50;
    case "attack": {
      const attacks = me?.active ? affordableAttacks(me.active) : [];
      const chosen = attacks.find((a) => a.index === action.attackIndex);
      // Hitting hardest matters more than anything else left on the list,
      // and attacking ends the turn, so it sorts below development.
      return 20 + Math.min(20, (chosen?.damage ?? 0) / 10);
    }
    case "endTurn":
      return 0;
    default:
      return 10;
  }
}

/** The bot's next move, or null when it should stop. */
export function chooseMove(
  state: BattleState,
  meId: string,
  opts: { energyUsed: boolean; supporterUsed: boolean; firstTurn: boolean }
): Move | null {
  const moves = legalMoves(state, meId, opts);
  if (moves.length === 0) return null;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = score(m, state, meId);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best;
}
