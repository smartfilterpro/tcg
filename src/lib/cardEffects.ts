// What a card DOES, in a form the engine can execute.
//
// The existing `fx` field was a flat list of at most three verbs from a set
// of six, produced for Trainers only. It cannot express the thing that makes
// this game a game: a card's effect depends on the board it is played into.
// "30 damage, plus 30 more if the Defending Pokémon is Poisoned" is not a
// number. A Tool that adds 20 to every attack is not an action at all — it
// is a rule that changes other cards while it sits there.
//
// So this is a small language rather than a list, with three kinds of thing:
//
//   ACTIONS   happen once, when something is played or an attack resolves.
//   MODIFIERS sit on the board and change numbers continuously.
//   CONDITIONS decide whether either applies, by asking about the board.
//
// Two rules govern the whole design.
//
// 1. THE ENGINE NEVER GUESSES. Every effect compiles to something the engine
//    executes exactly, or to `manual` with the printed text attached, which
//    puts a line in the log and lets the players decide — which is what the
//    app does today for everything. Degrading to today is always available
//    and is never wrong; inventing an effect is always wrong.
//
// 2. AI READS, CODE EXECUTES. Compiling text into this shape is a language
//    problem and happens once per card, in the background, cached forever.
//    Resolving it against a board is arithmetic and happens in a battle,
//    where no model is ever called.

/* ------------------------------------------------------------ conditions */

/** A question about the board, answerable without judgement.
 *
 *  Deliberately a closed set. A condition the compiler can't express becomes
 *  `manual` rather than a new opcode invented on the fly, because an opcode
 *  the engine doesn't implement is worse than no opcode at all. */
export type Condition =
  | { if: "always" }
  | { if: "coinFlip"; heads?: number }
  /** Target has any damage on it. */
  | { if: "damaged"; who: TargetRef }
  /** Target has this status condition. */
  | { if: "hasStatus"; who: TargetRef; status: string }
  /** Target is of this energy type — the Pokémon's type, not its energy. */
  | { if: "isType"; who: TargetRef; type: string }
  /** At least n energy attached to the target. */
  | { if: "energyAtLeast"; who: TargetRef; n: number }
  /** A card with this name is in play on the given side. */
  | { if: "inPlay"; side: "mine" | "theirs" | "either"; name: string }
  /** Target's remaining HP is at or below n. */
  | { if: "hpAtMost"; who: TargetRef; n: number };

/** Who an effect points at. Resolved against the board at execution time. */
export type TargetRef =
  | "self"
  | "myActive"
  | "myBench"
  | "myAll"
  | "theirActive"
  | "theirBench"
  | "theirAll"
  /** The player chooses — the engine asks rather than picking. */
  | "chosen";

/* --------------------------------------------------------------- actions */

/** Something that happens once.
 *
 *  `manual` is not a failure mode to be minimised — it is the escape hatch
 *  that makes the rest safe, and a compiler that never emits it is lying. */
export type Action =
  | { do: "damage"; who: TargetRef; n: number }
  | { do: "heal"; who: TargetRef; n: number }
  | { do: "status"; who: TargetRef; status: string }
  | { do: "clearStatus"; who: TargetRef; status?: string }
  | { do: "draw"; n: number }
  | { do: "discardHand"; n?: number }
  | { do: "millDeck"; n: number }
  | { do: "searchDeckToHand"; n: number; what?: string }
  | { do: "searchDeckToBench"; n: number; what?: string }
  | { do: "shuffleHandIntoDeckDraw"; n: number }
  | { do: "attachEnergyFromDiscard"; n: number; who: TargetRef }
  | { do: "discardEnergy"; who: TargetRef; n: number }
  | { do: "switch"; side: "mine" | "theirs" }
  | { do: "damageCounters"; who: TargetRef; n: number }
  /** Everything the compiler could not express, carried verbatim. */
  | { do: "manual"; note: string };

/** An action with the question that gates it, and what happens otherwise. */
export interface ConditionalAction {
  when?: Condition;
  then: Action[];
  otherwise?: Action[];
}

/* ------------------------------------------------------------- modifiers */

/** A continuous effect: something true while the card is in play.
 *
 *  This is the half the old `fx` could not represent at all, and the half
 *  that makes the board matter. A Tool attached to a Pokémon, an Ability on
 *  the Bench, a Stadium in the shared slot — each of these changes numbers
 *  belonging to OTHER cards, for as long as it is there.
 *
 *  Resolved in layers so the order can't depend on which card happened to be
 *  played first: additions before multiplications before floors, which is
 *  how the printed rules read and the only order that gives one answer. */
export type Modifier =
  /** Add to (or subtract from) damage this Pokémon's attacks deal. */
  | { mod: "attackDamage"; who: TargetRef; n: number; when?: Condition }
  /** Add to (or subtract from) damage this Pokémon takes. */
  | { mod: "damageTaken"; who: TargetRef; n: number; when?: Condition }
  /** Change retreat cost. Negative reduces; the engine floors it at zero. */
  | { mod: "retreatCost"; who: TargetRef; n: number; when?: Condition }
  /** Add to maximum HP. */
  | { mod: "maxHp"; who: TargetRef; n: number; when?: Condition }
  /** Cancel weakness, or resistance, on the holder. */
  | { mod: "noWeakness"; who: TargetRef; when?: Condition }
  /** Prevent all effects of attacks — the engine only notes this, since
   *  "prevent" needs a judgement about what counts as an effect. */
  | { mod: "manual"; note: string };

/* ------------------------------------------------- the compiled card */

/** Everything the compiler learned about one card.
 *
 *  Stored per card and shared by every player, because a card's rules do not
 *  vary by who is holding it. Versioned so a later, better compiler can be
 *  told which rows to redo without redoing all of them. */
export interface CompiledCard {
  /** Schema version this row was produced against. */
  v: number;
  /** Per attack, by index into the card's printed attack list. */
  attacks?: Array<{
    /** Extra damage beyond the printed number, and what it depends on. */
    bonus?: ConditionalAction[];
    /** What the attack does besides damage. */
    effects?: ConditionalAction[];
  }>;
  /** A Trainer's or a Supporter's effect, when played. */
  play?: ConditionalAction[];
  /** Continuous effects this card contributes while it is in play. */
  modifiers?: Modifier[];
  /** For an Energy card: the symbols it pays. "*" means any one symbol. */
  provides?: string[];
  /** How sure the compiler was. Below `TRUSTED` the engine still executes
   *  nothing automatically — it shows the note and lets the players call it. */
  confidence: number;
  /** Why, when confidence is low. Shown in the admin review list. */
  note?: string;
}

/** The current schema version. Bump when the language changes in a way that
 *  makes old rows wrong rather than merely incomplete. */
export const EFFECT_SCHEMA_VERSION = 1;

/** Below this, nothing is executed automatically.
 *
 *  Set high on purpose. A referee that is right 99% of the time and silently
 *  wrong the rest is worse than one that asks: the wrong 1% is invisible,
 *  lands mid-game, and costs someone a match they think they won. */
export const TRUSTED = 0.85;

/* --------------------------------------------------------------- runtime */

/** The board, as much of it as an effect can ask about. Deliberately a
 *  narrow view: conditions can read it and nothing can write through it. */
export interface BoardView {
  me: SideView;
  them: SideView;
}

export interface SideView {
  active: StackView | null;
  bench: StackView[];
  handCount: number;
  deckCount: number;
}

export interface StackView {
  name: string;
  types: string[];
  hp: number | null;
  damage: number;
  status: string[];
  energy: number;
  /** Names of everything attached, for `inPlay`-style questions. */
  attached: string[];
}

function stacks(board: BoardView, who: TargetRef): StackView[] {
  switch (who) {
    case "self":
    case "myActive":
      return board.me.active ? [board.me.active] : [];
    case "myBench":
      return board.me.bench;
    case "myAll":
      return [...(board.me.active ? [board.me.active] : []), ...board.me.bench];
    case "theirActive":
      return board.them.active ? [board.them.active] : [];
    case "theirBench":
      return board.them.bench;
    case "theirAll":
      return [...(board.them.active ? [board.them.active] : []), ...board.them.bench];
    // "chosen" cannot be resolved without asking a player, so a condition
    // that depends on it is not answerable here.
    case "chosen":
      return [];
  }
}

/** Answer a condition against the board.
 *
 *  `flip` is passed in rather than generated, so the same board and the same
 *  coin give the same answer — a rules engine that calls Math.random inside
 *  itself cannot be tested, replayed or trusted. */
export function testCondition(
  cond: Condition | undefined,
  board: BoardView,
  flip?: boolean
): boolean {
  if (!cond) return true;
  switch (cond.if) {
    case "always":
      return true;
    case "coinFlip":
      return flip === true;
    case "damaged":
      return stacks(board, cond.who).some((s) => s.damage > 0);
    case "hasStatus":
      return stacks(board, cond.who).some((s) =>
        s.status.map((x) => x.toLowerCase()).includes(cond.status.toLowerCase())
      );
    case "isType":
      return stacks(board, cond.who).some((s) =>
        s.types.map((x) => x.toLowerCase()).includes(cond.type.toLowerCase())
      );
    case "energyAtLeast":
      return stacks(board, cond.who).some((s) => s.energy >= cond.n);
    case "hpAtMost":
      return stacks(board, cond.who).some(
        (s) => s.hp != null && s.hp - s.damage <= cond.n
      );
    case "inPlay": {
      const sides =
        cond.side === "mine"
          ? [board.me]
          : cond.side === "theirs"
            ? [board.them]
            : [board.me, board.them];
      const want = cond.name.toLowerCase();
      return sides.some((side) =>
        [...(side.active ? [side.active] : []), ...side.bench].some(
          (s) =>
            s.name.toLowerCase() === want ||
            s.attached.some((a) => a.toLowerCase() === want)
        )
      );
    }
  }
}

/** Every modifier currently in force, gathered from everything in play.
 *
 *  Collected fresh each time rather than cached on the state. A modifier's
 *  condition can stop being true between one attack and the next — the
 *  Pokémon it points at gets knocked out, the energy is discarded — and a
 *  cached list would keep applying an effect whose reason has left the
 *  board. Recomputing is cheap and cannot go stale. */
export function activeModifiers(
  inPlay: Array<{ compiled?: CompiledCard | null; who: TargetRef }>,
  board: BoardView,
  flip?: boolean
): Modifier[] {
  const out: Modifier[] = [];
  for (const card of inPlay) {
    const compiled = card.compiled;
    if (!compiled || compiled.confidence < TRUSTED) continue;
    for (const m of compiled.modifiers ?? []) {
      if (m.mod === "manual") continue;
      if (!testCondition(m.when, board, flip)) continue;
      out.push(m);
    }
  }
  return out;
}

/** Apply the damage modifiers in a fixed order.
 *
 *  Additions, then weakness, then resistance, then reductions, then floor at
 *  zero — the order the printed rules use. Doing it in any other order gives
 *  a different number for the same board, which is the classic way a digital
 *  card game and a physical one stop agreeing. */
export function resolveDamage(input: {
  base: number;
  /** From the attacker's own bonuses and modifiers. */
  attackerBonus: number;
  /** From the defender's damage-taken modifiers (usually negative). */
  defenderReduction: number;
  weakness: boolean;
  resistance: boolean;
  noWeakness?: boolean;
}): { total: number; steps: string[] } {
  const steps: string[] = [];
  let n = input.base;
  if (input.attackerBonus) {
    n += input.attackerBonus;
    steps.push(`${input.attackerBonus > 0 ? "+" : ""}${input.attackerBonus}`);
  }
  if (n > 0 && input.weakness && !input.noWeakness) {
    n *= 2;
    steps.push("weakness ×2");
  }
  if (n > 0 && input.resistance) {
    n -= 30;
    steps.push("resistance −30");
  }
  if (input.defenderReduction) {
    n += input.defenderReduction;
    steps.push(`${input.defenderReduction > 0 ? "+" : ""}${input.defenderReduction}`);
  }
  return { total: Math.max(0, n), steps };
}
