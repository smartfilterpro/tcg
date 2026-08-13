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
  /** Whoever just attacked. Only meaningful inside a trigger, and the whole
   *  reason triggers need their own target: Spiritomb's "place 1 damage
   *  counter on the Attacking Pokémon" cannot be said with sides alone,
   *  because the attacker is on the other side of the table from the card
   *  whose ability it is. */
  | "attacker"
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

/* ----------------------------------------------------------- counting */

/** Something on the board there can be more than one of.
 *
 *  Conditions answer yes or no, which turned out not to be enough: half the
 *  attacks in a real game scale with a number. "30 more damage for each of
 *  your opponent's Benched Pokémon" is not a condition, and without this it
 *  compiled to nothing and the player did the arithmetic by hand — badly,
 *  in the game that prompted this: 990 damage went onto a Seel with 80 HP. */
export type Count =
  | { count: "myBench" }
  | { count: "theirBench" }
  | { count: "energyOn"; who: TargetRef }
  /** Damage counters, i.e. damage ÷ 10 — the unit the cards are written in. */
  | { count: "countersOn"; who: TargetRef };

/** Damage beyond the printed number.
 *
 *  `per` turns a flat bonus into a multiplied one, which is the shape most
 *  variable attacks are printed in. `max` carries "up to 3 times". */
export interface DamageBonus {
  n: number;
  per?: Count;
  max?: number;
  when?: Condition;
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

/* -------------------------------------------------------------- triggers */

/** Something that fires because something else happened.
 *
 *  The third kind of thing, and the one a real game made unavoidable:
 *  Spiritomb sits on the BENCH and says "if your Active Darkness Pokémon is
 *  damaged by an attack, place 1 damage counter on the Attacking Pokémon".
 *  It is not an action — nobody plays it. It is not a modifier — it changes
 *  no number while nothing is happening. It is a reaction, and without one
 *  the ability could only ever be announced in the log and then done by
 *  hand, which is exactly what happened.
 *
 *  Deliberately a tiny set. Every entry here is a moment the engine already
 *  knows it is at, so a trigger can never fire at a time the engine cannot
 *  identify. */
export type TriggerMoment =
  /** The owner's side took attack damage. */
  | "damagedByAttack"
  /** The owner's Active was knocked out. */
  | "knockedOut";

export interface Trigger {
  on: TriggerMoment;
  /** Asked at the moment it fires. Spiritomb's "if your Active is a
   *  Darkness Pokémon" lives here. */
  when?: Condition;
  then: Action[];
}

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
    /** Extra damage beyond the printed number, and what it scales with. */
    bonus?: DamageBonus[];
    /** What the attack does besides damage. */
    effects?: ConditionalAction[];
    /** A condition the WHOLE attack hangs on — "Flip a coin. If tails, this
     *  attack does nothing."
     *
     *  Its own field rather than a condition on each part, because it
     *  governs the order of play: the flip happens BEFORE damage. The
     *  engine used to deal the printed damage and ask afterwards, so a
     *  tails meant healing 30 back off the defender by hand, which is both
     *  wrong and exactly backwards. */
    gate?: Condition;
  }>;
  /** A Trainer's or a Supporter's effect, when played. */
  play?: ConditionalAction[];
  /** Continuous effects this card contributes while it is in play. */
  modifiers?: Modifier[];
  /** Reactions this card contributes while it is in play. */
  triggers?: Trigger[];
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
    // Neither of these is answerable from the board alone — "chosen" needs
    // a player and "attacker" needs the event that is firing. A condition
    // that leans on either is simply not true here, which is the safe way
    // for an unanswerable question to fail.
    case "chosen":
    case "attacker":
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

/** Everything that reacts to a moment, from everything in play.
 *
 *  Same trust rule as modifiers: an uncertain compile contributes nothing
 *  automatically. A trigger firing wrongly is worse than a modifier being
 *  wrong, because it happens on someone else's turn — the player it hurts
 *  is not the one who could have caught it. */
export function firedTriggers(
  inPlay: Array<{ compiled?: CompiledCard | null; name: string }>,
  moment: TriggerMoment,
  board: BoardView,
  flip?: boolean
): Array<{ source: string; actions: Action[] }> {
  const out: Array<{ source: string; actions: Action[] }> = [];
  for (const card of inPlay) {
    const compiled = card.compiled;
    if (!compiled || compiled.confidence < TRUSTED) continue;
    for (const t of compiled.triggers ?? []) {
      if (t.on !== moment) continue;
      if (!testCondition(t.when, board, flip)) continue;
      if (t.then.length > 0) out.push({ source: card.name, actions: t.then });
    }
  }
  return out;
}

/** How many of something is on the board. */
export function countOf(c: Count, board: BoardView): number {
  switch (c.count) {
    case "myBench":
      return board.me.bench.length;
    case "theirBench":
      return board.them.bench.length;
    case "energyOn":
      return stacks(board, c.who).reduce((n, s) => n + s.energy, 0);
    case "countersOn":
      return stacks(board, c.who).reduce((n, s) => n + Math.floor(s.damage / 10), 0);
  }
}

/** Everything an attack does, worked out before anything is applied.
 *
 *  One function, because the order is the thing that was wrong. The engine
 *  dealt the printed damage the moment the attack was declared and left
 *  every condition, bonus and side effect to the players — so a coin-flip
 *  attack that missed had already hit, and a "+30 per Benched Pokémon"
 *  attack was a prompt to do mental arithmetic mid-game.
 *
 *  Nothing is applied here. It returns what SHOULD happen, so the caller can
 *  log it, apply it, or hand it to the players when confidence is low. */
export function resolveAttack(input: {
  compiled: CompiledCard | null | undefined;
  attackIndex: number;
  /** The printed damage, already parsed. */
  base: number;
  board: BoardView;
  /** The coin, when the attack needs one. Passed in, never rolled here. */
  flip?: boolean;
  weakness: boolean;
  resistance: boolean;
  /** From tools, abilities and stadiums already in play. */
  attackerMods?: number;
  defenderMods?: number;
  noWeakness?: boolean;
}): {
  /** Damage to the defending Pokémon. */
  total: number;
  /** How it was arrived at, for the log. */
  steps: string[];
  /** Whether a gate stopped the attack entirely. */
  fizzled: boolean;
  /** Side effects the caller should apply or announce. */
  effects: Action[];
  /** True when nothing was compiled, or not confidently enough to act on —
   *  the caller falls back to today's behaviour and tells the players. */
  manual: boolean;
} {
  const compiled = input.compiled;
  const trusted = !!compiled && compiled.confidence >= TRUSTED;
  const attack = trusted ? compiled!.attacks?.[input.attackIndex] : undefined;

  // Nothing compiled, or not enough to trust: the printed number and the
  // rules the engine has always known. Never a guess.
  if (!trusted || !attack) {
    const plain = resolveDamage({
      base: input.base,
      attackerBonus: input.attackerMods ?? 0,
      defenderReduction: input.defenderMods ?? 0,
      weakness: input.weakness,
      resistance: input.resistance,
      noWeakness: input.noWeakness,
    });
    return { ...plain, fizzled: false, effects: [], manual: true };
  }

  // A coin the caller hasn't tossed is NOT a tails.
  //
  // testCondition reads an absent flip as false, which is right for the
  // condition and catastrophic here: every coin-flip attack in the game
  // would silently miss, and miss in the engine's voice rather than the
  // player's. An unanswered gate falls back to manual, which is the same
  // thing the app does today.
  if (attack.gate?.if === "coinFlip" && input.flip === undefined) {
    const plain = resolveDamage({
      base: input.base,
      attackerBonus: input.attackerMods ?? 0,
      defenderReduction: input.defenderMods ?? 0,
      weakness: input.weakness,
      resistance: input.resistance,
      noWeakness: input.noWeakness,
    });
    return { ...plain, fizzled: false, effects: [], manual: true };
  }

  // The gate first. "If tails, this attack does nothing" means no damage and
  // no effects — not damage that gets healed back afterwards.
  if (attack.gate && !testCondition(attack.gate, input.board, input.flip)) {
    return {
      total: 0,
      steps: ["missed"],
      fizzled: true,
      effects: [],
      manual: false,
    };
  }

  let bonus = input.attackerMods ?? 0;
  const steps: string[] = [];
  for (const b of attack.bonus ?? []) {
    if (!testCondition(b.when, input.board, input.flip)) continue;
    const units = b.per ? countOf(b.per, input.board) : 1;
    const capped = b.max != null ? Math.min(units, b.max) : units;
    const add = b.n * capped;
    if (add === 0) continue;
    bonus += add;
    steps.push(b.per ? `+${b.n}×${capped}` : `${add > 0 ? "+" : ""}${add}`);
  }

  const resolved = resolveDamage({
    base: input.base,
    attackerBonus: bonus,
    defenderReduction: input.defenderMods ?? 0,
    weakness: input.weakness,
    resistance: input.resistance,
    noWeakness: input.noWeakness,
  });

  const effects: Action[] = [];
  for (const e of attack.effects ?? []) {
    const passed = testCondition(e.when, input.board, input.flip);
    effects.push(...(passed ? e.then : (e.otherwise ?? [])));
  }

  return {
    total: resolved.total,
    steps: [...steps, ...resolved.steps.filter((s) => !steps.includes(s))],
    fizzled: false,
    effects,
    manual: false,
  };
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
