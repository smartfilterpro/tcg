/** Player-vs-player battle engine.
 *
 * Two modes:
 * - Free play: the app is just the table — shuffles, deals, tracks zones and
 *   damage while the players enforce every rule themselves.
 * - Referee mode (state.rules === true, the default for new battles): the app
 *   additionally enforces the game's STRUCTURE — turn order, the automatic
 *   draw each turn, one energy attachment and one Supporter per turn, Basics
 *   only onto the board, evolution timing, auto-knockout when damage reaches
 *   HP, automatic Prize cards, and the win conditions (all prizes taken, no
 *   Pokémon left, deck-out).
 *
 * What it deliberately does NOT know is what any card's text does — attacks
 * and effects stay manual. Every rule check can be bypassed with
 * `override: true` ("card effect"), because plenty of real cards break the
 * structural rules on purpose.
 */

export interface BattleAttack {
  name: string;
  cost: string[];
  damage: string;
  text: string | null;
}

export interface BattleCard {
  uid: string;
  name: string;
  image: string | null;
  /** Card category, when known (database supertype, else the deck entry). */
  cat?: "pokemon" | "trainer" | "energy" | null;
  /** True = Basic Pokémon, false = evolution, null/undefined = unknown. */
  basic?: boolean | null;
  /** Trainer subtype Supporter (limited to one per turn). */
  sup?: boolean;
  /** Trainer subtype Stadium (stays in play in the shared Stadium spot). */
  stad?: boolean;
  /** Max HP when known — enables auto-knockout. */
  hp?: number | null;
  /** Energy types (for weakness/resistance matching). */
  types?: string[];
  /** Printed attacks, when the card database knows them. */
  atk?: BattleAttack[];
  /** Weakness type (×2) / resistance type (−30). */
  weak?: string;
  resist?: string;
  /** Retreat cost (energy to discard). */
  retreat?: number;
  /** Large image, for the tap-to-read zoom view. */
  big?: string | null;
  /** Printed rules text (Trainer / Special Energy / rule-box lines). */
  rules?: string[];
  abilities?: Array<{ name: string; text: string }>;
  /** AI-compiled effect ops, executed when a Trainer is played. */
  fx?: { ops: Array<{ op: string; n?: number; note?: string }> } | null;
}

export const STATUS_CONDITIONS = ["poisoned", "burned", "asleep", "paralyzed", "confused"] as const;
export type StatusCondition = (typeof STATUS_CONDITIONS)[number];

/** A Pokémon in play: the face card plus everything attached under/behind it
 *  (energy, tools, pre-evolutions). */
export interface BattleStack {
  face: BattleCard;
  attached: BattleCard[];
  damage: number;
  /** turnCount when this stack hit the board or last evolved (0 = setup). */
  playedTurn?: number;
  /** Active status conditions (poisoned, asleep, …). */
  status?: StatusCondition[];
}

export interface SideState {
  deck: BattleCard[];
  hand: BattleCard[];
  prizes: BattleCard[];
  discard: BattleCard[];
  active: BattleStack | null;
  bench: BattleStack[];
  /** Trainers played THIS turn, face-up on the table for the opponent to
   *  see — swept into the discard pile when the turn ends. */
  played?: BattleCard[];
  /** Referee mode: player finished setup (Active placed, prizes set). */
  ready?: boolean;
}

export interface LogEntry {
  at: string;
  text: string;
}

export interface BattleState {
  /** Keyed by user id. */
  sides: Record<string, SideState>;
  /** Display names, keyed by user id. */
  names: Record<string, string>;
  /** Host's choice: may players borrow decks members have shared? */
  allowSharedDecks?: boolean;
  /** Referee mode: enforce the structural rules of the game. */
  rules?: boolean;
  /** Referee mode: "setup" until both players are ready, then "play". */
  phase?: "setup" | "play";
  /** Who takes the first turn (needed for first-turn evolution rules). */
  firstUser?: string;
  /** Per-turn limits already used by the current turn player. */
  flags?: { energy?: boolean; supporter?: boolean; retreated?: boolean };
  /** Completed turns per player — first-turn rules key on THIS, not the
   *  global counter, so informal play (nobody tapping End turn) can't leave
   *  the game acting like it's turn 1 forever. */
  turnsTaken?: Record<string, number>;
  /** The Stadium in play (shared spot, one at a time). */
  stadium?: { card: BattleCard; owner: string } | null;
  /** Which deck each player brought, keyed by user id — what a rematch
   *  needs to deal the same two decks again. */
  decks?: Record<string, string>;
  /** One step back, for undo. See UndoPoint. */
  prev?: UndoPoint;
  turnUser: string | null;
  turnCount: number;
  log: LogEntry[];
}

/** The board as it was immediately before the last action.
 *
 *  Exactly one step is kept. This board is almost entirely manual — a
 *  mis-tapped "Discard hand" is otherwise unrecoverable — but a full history
 *  would multiply the size of a row that is rewritten on every single move.
 *  One step turns a misclick into a two-second fix, which is the whole of
 *  the problem worth solving. */
export interface UndoPoint {
  /** The previous board, itself carrying no undo point — so undo can't be
   *  chained backwards and the row can't grow without bound. */
  s: BattleState;
  /** The battle row's status and winner at that moment, so undoing the move
   *  that ended a game also un-ends it. */
  status: string;
  winner: string | null;
  /** Who acted. Only they may undo it: taking back a move after the other
   *  player has replied would silently discard their reply. */
  by: string;
  /** What it was, for the button and the log ("Undo: discarded their whole hand"). */
  label: string;
}

/** Capture the board before an action, for one step of undo. */
export function takeSnapshot(
  state: BattleState,
  status: string,
  winner: string | null,
  by: string,
  label: string
): UndoPoint {
  // Dropping `prev` is what keeps this to one level; without it every move
  // would nest the entire previous history inside the row.
  const { prev: _prev, ...rest } = state;
  return { s: structuredClone(rest) as BattleState, status, winner, by, label };
}

export type BattleAction = { override?: boolean } & (
  | { type: "draw" }
  | { type: "shuffleDeck"; keepTop?: number }
  | { type: "mulligan" }
  | { type: "discardHand" }
  | { type: "handToDeckAll"; where?: "shuffle" | "bottom" | "top" }
  | { type: "redrawSeven" }
  | { type: "handToActive"; handIndex: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToBench"; handIndex: number; benchIndex?: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToDiscard"; handIndex: number }
  | { type: "playCard"; handIndex: number }
  | { type: "deckTake"; uid: string; to?: "hand" | "top"; noShuffle?: boolean }
  | { type: "millDeck"; n: number }
  | { type: "discardToHand"; discardIndex: number }
  | { type: "handToDeck"; handIndex: number; where: "top" | "bottom" | "shuffle" }
  | { type: "stackToDeck"; target: "active" | number }
  | { type: "devolve"; target: "active" | number; to: "hand" | "discard" }
  | { type: "playStadium"; handIndex: number }
  | { type: "discardStadium" }
  | { type: "promoteOpp"; benchIndex: number }
  | { type: "reveal"; handIndex: number }
  | { type: "useAbility"; target: "active" | number; abilityIndex: number }
  | { type: "promote"; benchIndex: number }
  | { type: "benchActive" }
  | { type: "useStadium" }
  | { type: "attack"; attackIndex: number }
  | { type: "setStatus"; side: "me" | "opp"; target: "active" | number; status: StatusCondition; on: boolean }
  | { type: "damage"; side: "me" | "opp"; target: "active" | number; delta: number }
  | { type: "knockout"; target: "active" | number }
  | { type: "stackToHand"; target: "active" | number }
  | { type: "detach"; target: "active" | number; attachedIndex: number; to: "discard" | "hand"; side?: "me" | "opp" }
  | { type: "takePrize" }
  | { type: "flipCoin" }
  | { type: "endTurn" }
  | { type: "claimTurn" }
  | { type: "concede" }
  | { type: "undo" }
);

export interface ActionResult {
  text: string;
  /** Set when this action ended the game. */
  winnerId?: string;
}

export class BattleError extends Error {}

const MAX_BENCH = 5;
// Enough that a whole game survives to be exported. A full six-prize game
// with manual plays runs a couple of hundred entries, and the old 200 was
// quietly dropping the opening of any long game.
const MAX_LOG = 600;

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deal a fresh side: shuffle, draw seven, set six Prize cards. Setting
 *  prizes up front can bury the only Basic in the prize pile, which is why
 *  official rules do it after mulligans — so "redraw seven" puts the prizes
 *  back in the deck before re-dealing, which makes a stranded Basic
 *  recoverable without anyone having to think about the ordering. */
export function buildSide(cards: BattleCard[]): SideState {
  const deck = shuffle(cards);
  const hand = deck.splice(0, 7);
  const prizes = deck.splice(0, 6);
  return { deck, hand, prizes, discard: [], active: null, bench: [] };
}

function getStack(side: SideState, target: "active" | number): BattleStack {
  if (target === "active") {
    if (!side.active) throw new BattleError("No Active Pokémon there.");
    return side.active;
  }
  const stack = side.bench[target];
  if (!stack) throw new BattleError("Nothing in that Bench spot.");
  return stack;
}

function removeStack(side: SideState, target: "active" | number): BattleStack {
  const stack = getStack(side, target);
  if (target === "active") side.active = null;
  else side.bench.splice(target, 1);
  return stack;
}

function stackCards(stack: BattleStack): BattleCard[] {
  return [stack.face, ...stack.attached];
}

function takeHandCard(side: SideState, handIndex: number): BattleCard {
  const card = side.hand[handIndex];
  if (!card) throw new BattleError("That card isn't in your hand anymore.");
  side.hand.splice(handIndex, 1);
  return card;
}

function energyCount(stack: BattleStack): number {
  return stack.attached.filter((c) => c.cat === "energy").length;
}

function hasStatus(stack: BattleStack, s: StatusCondition): boolean {
  return (stack.status ?? []).includes(s);
}

/** Parse "80", "150+", "20×", "" → base number + variable marker. */
function parseDamage(damage: string): { base: number; variable: boolean } {
  const m = damage.trim().match(/^(\d+)?\s*([+×x*]?)$/);
  if (!m) return { base: 0, variable: true };
  return { base: m[1] ? parseInt(m[1], 10) : 0, variable: !!m[2] || !m[1] };
}

/** Apply one player action. Mutates `state`. Throws BattleError on an
 *  impossible or (in referee mode) illegal move. */
export function applyAction(
  state: BattleState,
  meId: string,
  oppId: string,
  action: BattleAction
): ActionResult {
  const me = state.sides[meId];
  const opp = state.sides[oppId];
  if (!me || !opp) throw new BattleError("Battle state is missing a player.");

  // One mode. The app keeps score — prizes, the per-turn draw, knockouts,
  // poison and burn, and the win — but it does not block plays. Refereeing
  // was a separate mode that gated the useful half of the board (attack
  // buttons, playing a Trainer) behind a checkbox, and enforcing rules the
  // cards themselves constantly break caused more stuck games than it
  // prevented. Score-keeping is the part worth automating; judgement stays
  // with the players.
  const phase: "setup" | "play" = "play";
  const override = action.override === true;
  // Battles created before prizes were dealt at the start have an empty
  // pile. Fill it while that side's board is still untouched, so those games
  // behave like new ones rather than never awarding a Prize card.
  for (const side of [me, opp]) {
    if (
      side.prizes.length === 0 &&
      !side.active &&
      side.bench.length === 0 &&
      side.discard.length === 0 &&
      side.deck.length >= 6
    ) {
      side.prizes = side.deck.splice(0, 6);
    }
  }
  const myTurn = state.turnUser === meId;
  const oppName = state.names[oppId] ?? "your opponent";
  const flags = (state.flags ??= {});
  const effectNote = override ? " (card effect)" : "";
  const turnsTaken = (state.turnsTaken ??= {});
  const myTurnsDone = turnsTaken[meId] ?? 0;
  /** True only on the game's opening turn: nobody has completed a turn AND
   *  the global counter agrees. The turnCount check keeps battles created
   *  before per-player tracking existed from re-arming first-turn blocks
   *  mid-game (their counters start at zero whatever the board looks like). */
  const gameFirstTurn =
    meId === state.firstUser &&
    myTurnsDone === 0 &&
    (turnsTaken[oppId] ?? 0) === 0 &&
    state.turnCount <= 1;
  const myFirstTurn =
    myTurnsDone === 0 && state.turnCount <= (meId === state.firstUser ? 1 : 2);

  // Kept as named no-ops so every call site still reads as the rule it used
  // to enforce. Nothing here refuses a move any more: players call their own
  // game, and the cards break these rules often enough that enforcing them
  // stranded more turns than it saved.
  function needTurn(_what: string) {}
  function needPlayPhase() {}
  function checkBoardPlay(_card: BattleCard) {}
  function checkEvolve(_stack: BattleStack, _card: BattleCard) {}
  /** Records that an energy went down this turn — the board shows a chip so
   *  you can see it, but attaching a second one is still allowed. */
  function checkAttach(card: BattleCard) {
    if (card.cat === "energy") flags.energy = true;
  }
  /** Knock a stack out: cards to its owner's discard, prize to the other
   *  player, and check every way this can end the game. */
  function knockOut(
    ownerId: string,
    target: "active" | number,
    cause: string
  ): { text: string; winnerId?: string } {
    const owner = state.sides[ownerId];
    const taker = ownerId === meId ? opp : me;
    const takerId = ownerId === meId ? oppId : meId;
    const stack = removeStack(owner, target);
    owner.discard.push(...stackCards(stack));
    let text = `${cause} ${stack.face.name} is Knocked Out!`;
    const prize = taker.prizes.shift();
    if (prize) {
      taker.hand.push(prize);
      text += ` ${state.names[takerId] ?? "The opponent"} takes a Prize card (${taker.prizes.length} left).`;
      // Only a prize actually taken can be the last one. Without this, a
      // battle that started before prizes were dealt automatically — and so
      // has an empty pile — would declare a winner on the first knockout.
      if (taker.prizes.length === 0) {
        return { text: `${text} That was the last Prize — the battle is over!`, winnerId: takerId };
      }
    }
    if (!owner.active && owner.bench.length === 0) {
      return {
        text: `${text} ${state.names[ownerId] ?? "That player"} has no Pokémon left in play!`,
        winnerId: takerId,
      };
    }
    return { text };
  }
  /** Pokémon Checkup (between turns, referee mode): poison and burn damage
   *  tick on both Actives, paralysis wears off for the player whose turn
   *  just ended, sleep gets its wake-up reminder. Call AFTER the turn has
   *  passed (me = the player who just ended their turn). */
  function runCheckup(): { text: string; winnerId?: string } {
    const parts: string[] = [];
    for (const [ownerId, side] of [
      [meId, me],
      [oppId, opp],
    ] as const) {
      const active = side.active;
      if (!active || !active.status?.length) continue;
      const name = active.face.name;
      let koed = false;
      for (const [condition, tick] of [
        ["poisoned", 10],
        ["burned", 20],
      ] as const) {
        if (koed || !hasStatus(active, condition)) continue;
        active.damage = Math.min(990, active.damage + tick);
        parts.push(
          `Checkup: ${name} takes ${tick} ${condition === "poisoned" ? "poison" : "burn"} damage (now ${active.damage}${active.face.hp ? ` / ${active.face.hp} HP` : ""})${condition === "burned" ? " — flip a coin: heads cures the burn" : ""}.`
        );
        if (active.face.hp && active.damage >= active.face.hp) {
          const ko = knockOut(ownerId, "active", "Checkup:");
          parts.push(ko.text);
          if (ko.winnerId) return { text: parts.join(" ") + " ", winnerId: ko.winnerId };
          koed = true;
        }
      }
      if (!koed && hasStatus(active, "asleep")) {
        parts.push(`Checkup: ${name} is asleep — flip a coin: heads wakes it up (clear the marker).`);
      }
    }
    if (me.active && hasStatus(me.active, "paralyzed")) {
      me.active.status = (me.active.status ?? []).filter((s) => s !== "paralyzed");
      parts.push(`Checkup: ${me.active.face.name} is no longer paralyzed.`);
    }
    return { text: parts.length ? parts.join(" ") + " " : "" };
  }

  /** End-of-turn sweep: Trainers played this turn leave the table and land
   *  in their owner's discard pile. */
  function sweepPlayed(side: SideState): string {
    if (!side.played?.length) return "";
    const n = side.played.length;
    side.discard.push(...side.played);
    side.played = [];
    return ` (${n} played Trainer${n === 1 ? "" : "s"} to the discard)`;
  }

  switch (action.type) {
    case "draw": {
      needTurn("draw");
      const card = me.deck.shift();
      if (!card) return { text: "tried to draw — their deck is empty!" };
      me.hand.push(card);
      return { text: `drew a card${effectNote}` };
    }
    case "shuffleDeck": {
      // keepTop: card effects that stack the top then say "shuffle the rest".
      const keep = Math.max(0, Math.min(10, Math.round(action.keepTop ?? 0)));
      if (keep > 0) {
        const top = me.deck.slice(0, keep);
        me.deck = [...top, ...shuffle(me.deck.slice(keep))];
        return {
          text: `shuffled their deck, keeping the top ${keep} card${keep === 1 ? "" : "s"} in place${effectNote}`,
        };
      }
      me.deck = shuffle(me.deck);
      return { text: "shuffled their deck" };
    }
    case "mulligan": {
      // Official rules: a mulligan hand is revealed to the opponent, who may
      // then draw 1 extra card. The log is our "reveal".
      const revealed = me.hand.map((c) => c.name).join(", ") || "an empty hand";
      me.deck.push(...me.hand);
      me.hand = [];
      me.deck = shuffle(me.deck);
      me.hand = me.deck.splice(0, 7);
      return {
        text: `mulliganed — revealed ${revealed} — shuffled it back and drew 7. ${oppName} may draw 1 extra card.`,
      };
    }
    case "discardHand": {
      const n = me.hand.length;
      if (n === 0) throw new BattleError("Your hand is already empty.");
      me.discard.push(...me.hand);
      me.hand = [];
      return { text: `discarded their whole hand (${n} card${n === 1 ? "" : "s"})` };
    }
    case "handToDeckAll": {
      const n = me.hand.length;
      if (n === 0) throw new BattleError("Your hand is already empty.");
      // Index 0 is the top of the deck, so "bottom" is a plain push. The
      // hand is still shuffled first — cards like Vivillon's Grand Wing say
      // "shuffles their hand and puts it on the bottom", which hides the
      // order you were holding without disturbing the deck underneath.
      const where = action.where ?? "shuffle";
      if (where === "top") {
        me.deck.unshift(...shuffle(me.hand));
      } else {
        me.deck.push(...(where === "bottom" ? shuffle(me.hand) : me.hand));
      }
      me.hand = [];
      if (where === "shuffle") me.deck = shuffle(me.deck);
      const cards = `${n} card${n === 1 ? "" : "s"}`;
      const text =
        where === "bottom"
          ? `shuffled their hand and put it on the bottom of their deck (${cards})`
          : where === "top"
            ? `put their hand on top of their deck (${cards})`
            : `shuffled their hand (${cards}) back into their deck`;
      return { text };
    }
    case "redrawSeven": {
      // Hand AND prizes go back before re-dealing. Prizes are set when the
      // battle is created, so without returning them a Basic buried in the
      // prize pile could never be drawn no matter how many times you redrew.
      const returned = me.hand.length + me.prizes.length;
      me.deck.push(...me.hand, ...me.prizes);
      me.hand = [];
      me.prizes = [];
      me.deck = shuffle(me.deck);
      me.hand = me.deck.splice(0, 7);
      me.prizes = me.deck.splice(0, 6);
      return {
        text: `shuffled ${returned} cards back, drew a new hand of ${me.hand.length} and set ${me.prizes.length} Prize cards`,
      };
    }
    case "handToActive": {
      if (action.mode === "new") {
        if (me.active) throw new BattleError("You already have an Active Pokémon.");
        const card = me.hand[action.handIndex];
        if (!card) throw new BattleError("That card isn't in your hand anymore.");
        checkBoardPlay(card);
        needTurn("play a Pokémon");
        takeHandCard(me, action.handIndex);
        me.active = { face: card, attached: [], damage: 0, playedTurn: state.turnCount };
        return { text: `played ${card.name} as their Active Pokémon${effectNote}` };
      }
      needPlayPhase();
      const stack = getStack(me, "active");
      const card = me.hand[action.handIndex];
      if (!card) throw new BattleError("That card isn't in your hand anymore.");
      if (action.mode === "evolve") {
        checkEvolve(stack, card);
        needTurn("evolve");
        takeHandCard(me, action.handIndex);
        stack.attached.push(stack.face);
        const prev = stack.face.name;
        stack.face = card;
        stack.playedTurn = state.turnCount;
        stack.status = []; // evolving cures status conditions
        return { text: `evolved ${prev} into ${card.name}${effectNote}` };
      }
      needTurn("attach");
      checkAttach(card);
      takeHandCard(me, action.handIndex);
      stack.attached.push(card);
      return { text: `attached ${card.name} to ${stack.face.name}${effectNote}` };
    }
    case "handToBench": {
      if (action.mode === "new" || action.benchIndex === undefined) {
        if (me.bench.length >= MAX_BENCH) throw new BattleError("Your Bench is full (5 max).");
        const card = me.hand[action.handIndex];
        if (!card) throw new BattleError("That card isn't in your hand anymore.");
        checkBoardPlay(card);
        needTurn("play a Pokémon");
        takeHandCard(me, action.handIndex);
        me.bench.push({ face: card, attached: [], damage: 0, playedTurn: state.turnCount });
        return { text: `played ${card.name} to their Bench${effectNote}` };
      }
      needPlayPhase();
      const stack = getStack(me, action.benchIndex);
      const card = me.hand[action.handIndex];
      if (!card) throw new BattleError("That card isn't in your hand anymore.");
      if (action.mode === "evolve") {
        checkEvolve(stack, card);
        needTurn("evolve");
        takeHandCard(me, action.handIndex);
        stack.attached.push(stack.face);
        const prev = stack.face.name;
        stack.face = card;
        stack.playedTurn = state.turnCount;
        stack.status = []; // evolving cures status conditions
        return { text: `evolved ${prev} into ${card.name}${effectNote}` };
      }
      needTurn("attach");
      checkAttach(card);
      takeHandCard(me, action.handIndex);
      stack.attached.push(card);
      return { text: `attached ${card.name} to ${stack.face.name}${effectNote}` };
    }
    case "playCard": {
      needPlayPhase();
      needTurn("play a Trainer card");
      const card = me.hand[action.handIndex];
      if (!card) throw new BattleError("That card isn't in your hand anymore.");
      if (card.sup) flags.supporter = true;
      takeHandCard(me, action.handIndex);
      // Face-up on the table so the opponent can see what was played —
      // swept into the discard pile when this turn ends.
      (me.played ??= []).push(card);
      let text = `played ${card.name}${card.sup ? " (Supporter)" : ""}${effectNote}`;
      if (card.rules?.length) {
        const cardText = card.rules.join(" ");
        text += ` — “${cardText.length > 200 ? cardText.slice(0, 200) + "…" : cardText}”`;
      }
      // Execute the AI-compiled effect script: deterministic ops happen
      // automatically, interactive/conditional ones become instructions.
      for (const op of card.fx?.ops?.slice(0, 3) ?? []) {
        const n = typeof op.n === "number" ? Math.max(1, Math.min(12, Math.round(op.n))) : null;
        if (op.op === "draw" && n) {
          const drawn = me.deck.splice(0, n);
          me.hand.push(...drawn);
          text += `. Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"}`;
        } else if (op.op === "millDeck" && n) {
          const milled = me.deck.splice(0, n);
          me.discard.push(...milled);
          text += `. Discarded from deck: ${milled.map((c) => c.name).join(", ") || "nothing (deck empty)"}`;
        } else if (op.op === "heal" && n) {
          if (me.active) {
            me.active.damage = Math.max(0, me.active.damage - n);
            text += `. Healed ${n} from ${me.active.face.name} (now ${me.active.damage})`;
          }
        } else if (op.op === "shuffleHandIntoDeckDraw" && n) {
          me.deck.push(...me.hand);
          me.hand = [];
          me.deck = shuffle(me.deck);
          me.hand = me.deck.splice(0, n);
          text += `. Shuffled their hand into their deck and drew ${me.hand.length}`;
        } else if (op.op === "searchDeckToHand") {
          text += `. → Now search your deck (deck pile → 🔍 Search)${op.note ? ` for: ${op.note}` : ""}`;
        } else if (op.note) {
          text += `. → ${op.note}`;
        }
      }
      return { text };
    }
    case "deckTake": {
      // The player already saw their (alphabetized) deck via the search
      // view; take the chosen card. A search normally ends in a shuffle,
      // but some card effects say NOT to shuffle — noShuffle keeps the
      // rest of the deck in its exact order.
      const idx = me.deck.findIndex((c) => c.uid === action.uid);
      if (idx === -1) throw new BattleError("That card isn't in your deck.");
      const [card] = me.deck.splice(idx, 1);
      const shuffled = action.noShuffle !== true;
      if (shuffled) me.deck = shuffle(me.deck);
      if (action.to === "top") {
        me.deck.unshift(card);
        return {
          text: shuffled
            ? `searched their deck, shuffled, and put a card on top${effectNote}`
            : `moved a card from their deck to the top — WITHOUT shuffling${effectNote}`,
        };
      }
      me.hand.push(card);
      return {
        text: shuffled
          ? `searched their deck, took 1 card, and shuffled${effectNote}`
          : `took a card from their deck WITHOUT shuffling${effectNote}`,
      };
    }
    case "handToDeck": {
      const card = takeHandCard(me, action.handIndex);
      if (action.where === "top") me.deck.unshift(card);
      else if (action.where === "bottom") me.deck.push(card);
      else {
        me.deck.push(card);
        me.deck = shuffle(me.deck);
      }
      const whereText =
        action.where === "top" ? "on top of" : action.where === "bottom" ? "on the bottom of" : "shuffled into";
      return { text: `put a card from their hand ${whereText} their deck${effectNote}` };
    }
    case "stackToDeck": {
      const stack = removeStack(me, action.target);
      me.deck.push(...stackCards(stack));
      me.deck = shuffle(me.deck);
      return { text: `shuffled ${stack.face.name} (and everything attached) into their deck${effectNote}` };
    }
    case "devolve": {
      const stack = getStack(me, action.target);
      let prevIdx = -1;
      for (let i = stack.attached.length - 1; i >= 0; i--) {
        if (stack.attached[i].cat === "pokemon" || stack.attached[i].cat == null) {
          prevIdx = i;
          break;
        }
      }
      if (prevIdx === -1) {
        throw new BattleError(`${stack.face.name} has no earlier stage underneath to devolve into.`);
      }
      const removed = stack.face;
      stack.face = stack.attached[prevIdx];
      stack.attached.splice(prevIdx, 1);
      if (action.to === "hand") me.hand.push(removed);
      else me.discard.push(removed);
      return {
        text: `devolved ${removed.name} (${action.to === "hand" ? "to their hand" : "discarded"}) — ${stack.face.name} stays in play${effectNote}`,
      };
    }
    case "playStadium": {
      needPlayPhase();
      needTurn("play a Stadium");
      const card = me.hand[action.handIndex];
      if (!card) throw new BattleError("That card isn't in your hand anymore.");
      takeHandCard(me, action.handIndex);
      let text = `played the Stadium ${card.name}`;
      const old = state.stadium;
      if (old) {
        state.sides[old.owner]?.discard.push(old.card);
        text += ` — ${old.card.name} is discarded`;
      }
      state.stadium = { card, owner: meId };
      if (card.rules?.length) {
        const t = card.rules.join(" ");
        text += ` — “${t.length > 180 ? t.slice(0, 180) + "…" : t}”`;
      }
      return { text: `${text}${effectNote}` };
    }
    case "discardStadium": {
      const stadium = state.stadium;
      if (!stadium) throw new BattleError("There's no Stadium in play.");
      state.sides[stadium.owner]?.discard.push(stadium.card);
      state.stadium = null;
      return { text: `discarded the Stadium ${stadium.card.name}${effectNote}` };
    }
    case "promoteOpp": {
      // Gust effects (Boss's Orders): YOU move the opponent's Pokémon.
      needPlayPhase();
      needTurn("switch the opposing Active");
      const bench = opp.bench[action.benchIndex];
      if (!bench) throw new BattleError("Nothing in that Bench spot.");
      opp.bench.splice(action.benchIndex, 1);
      if (opp.active) {
        opp.active.status = []; // leaving Active clears conditions
        opp.bench.push(opp.active);
      }
      opp.active = bench;
      return { text: `switched ${oppName}'s Active — ${bench.face.name} is now Active (card effect)` };
    }
    case "reveal": {
      const card = me.hand[action.handIndex];
      if (!card) throw new BattleError("That card isn't in your hand anymore.");
      return { text: `revealed ${card.name} from their hand` };
    }
    case "useAbility": {
      const stack = getStack(me, action.target);
      const ability = stack.face.abilities?.[action.abilityIndex];
      if (!ability) throw new BattleError("That ability isn't on this card.");
      const t = ability.text.length > 180 ? ability.text.slice(0, 180) + "…" : ability.text;
      return { text: `used ${stack.face.name}'s ability “${ability.name}”${t ? ` — ${t}` : ""}` };
    }
    case "millDeck": {
      const n = Math.max(1, Math.min(5, Math.round(action.n)));
      const milled = me.deck.splice(0, n);
      if (milled.length === 0) throw new BattleError("Your deck is empty.");
      me.discard.push(...milled);
      return {
        text: `discarded the top ${milled.length} card${milled.length === 1 ? "" : "s"} of their deck: ${milled.map((c) => c.name).join(", ")}`,
      };
    }
    case "discardToHand": {
      const card = me.discard[action.discardIndex];
      if (!card) throw new BattleError("That card isn't in your discard pile.");
      me.discard.splice(action.discardIndex, 1);
      me.hand.push(card);
      return { text: `returned ${card.name} from their discard pile to their hand${effectNote}` };
    }
    case "handToDiscard": {
      const card = takeHandCard(me, action.handIndex);
      me.discard.push(card);
      return { text: `discarded ${card.name} from their hand` };
    }
    case "promote": {
      const bench = me.bench[action.benchIndex];
      if (!bench) throw new BattleError("Nothing in that Bench spot.");
      // Promoting after a knockout is always allowed, even off-turn; a
      // voluntary retreat/switch is a your-turn move with a retreat cost.
      let costNote = "";
      if (me.active) {
        needTurn("retreat");
        const retiring = me.active;
        {
          if (hasStatus(retiring, "asleep") || hasStatus(retiring, "paralyzed")) {
            throw new BattleError(
              `${retiring.face.name} is ${(retiring.status ?? []).join(" and ")} — it can't retreat. (Card effect switches use ✨.)`
            );
          }
          const cost = retiring.face.retreat ?? 0;
          if (cost > 0) {
            if (energyCount(retiring) < cost) {
              throw new BattleError(
                `${retiring.face.name} needs ${cost} energy to retreat and only has ${energyCount(retiring)} attached.`
              );
            }
            const discarded: string[] = [];
            for (let i = retiring.attached.length - 1; i >= 0 && discarded.length < cost; i--) {
              if (retiring.attached[i].cat === "energy") {
                discarded.push(retiring.attached[i].name);
                me.discard.push(retiring.attached[i]);
                retiring.attached.splice(i, 1);
              }
            }
            costNote = ` (discarded ${discarded.join(", ")} to retreat)`;
          }
          flags.retreated = true;
        }
        // Leaving the Active spot removes status conditions.
        retiring.status = [];
      }
      me.bench.splice(action.benchIndex, 1);
      if (me.active) me.bench.push(me.active);
      me.active = bench;
      return { text: `moved ${bench.face.name} to Active${costNote}${me.active === bench && costNote ? "" : effectNote}` };
    }
    case "attack": {
      needPlayPhase();
      needTurn("attack");
      if (!me.active) throw new BattleError("You need an Active Pokémon to attack.");
      if (!opp.active) throw new BattleError(`${oppName} has no Active Pokémon to attack — wait for them to promote one.`);
      const attack = me.active.face.atk?.[action.attackIndex];
      if (!attack) throw new BattleError("That attack isn't on this card.");
      // Anything that would once have refused the attack is now a note in
      // the log, so the table can see it and decide.
      const warnings: string[] = [];
      if (hasStatus(me.active, "asleep")) warnings.push("asleep");
      if (hasStatus(me.active, "paralyzed")) warnings.push("paralyzed");
      const cost = attack.cost.filter((c) => c.toLowerCase() !== "free").length;
      if (energyCount(me.active) < cost) {
        warnings.push(`${energyCount(me.active)} of ${cost} energy attached`);
      }
      const { base, variable } = parseDamage(attack.damage);
      const target = opp.active;
      let dmg = base;
      const mods: string[] = [];
      const myTypes = me.active.face.types ?? [];
      if (dmg > 0 && target.face.weak && myTypes.includes(target.face.weak)) {
        dmg *= 2;
        mods.push("weakness ×2");
      }
      if (dmg > 0 && target.face.resist && myTypes.includes(target.face.resist)) {
        dmg = Math.max(0, dmg - 30);
        mods.push("resistance −30");
      }
      let text = `attacked with ${attack.name}`;
      if (warnings.length > 0) text += ` (${warnings.join(", ")})`;
      if (hasStatus(me.active, "confused")) {
        text += " (confused — remember the coin flip: tails = 30 damage to itself instead)";
      }
      if (dmg > 0) {
        target.damage = Math.min(990, target.damage + dmg);
        text += ` — ${dmg} damage to ${target.face.name}${mods.length ? ` (${mods.join(", ")})` : ""} (now ${target.damage}${target.face.hp ? ` / ${target.face.hp} HP` : ""})`;
      }
      if (variable) {
        text += ` — ${attack.damage.includes("+") || attack.damage.includes("×") || attack.damage.includes("x") ? "this attack has a +/× damage effect" : "damage varies"}: read the card and adjust with the damage buttons`;
      }
      if (attack.text) {
        text += `. Effect: ${attack.text.length > 220 ? attack.text.slice(0, 220) + "…" : attack.text}`;
      }
      if (target.face.hp && target.damage >= target.face.hp) {
        const ko = knockOut(oppId, "active", `${text} —`);
        if (ko.winnerId) return { text: ko.text, winnerId: ko.winnerId };
        text = ko.text;
      }
      // Attacking ends the turn.
      state.turnUser = oppId;
      state.turnCount += 1;
      turnsTaken[meId] = myTurnsDone + 1;
      state.flags = {};
      text += sweepPlayed(me);
      const checkup = runCheckup();
      if (checkup.winnerId) return { text: `${text}. ${checkup.text}`, winnerId: checkup.winnerId };
      const drawn = opp.deck.shift();
      if (!drawn) {
        return { text: `${text}. ${checkup.text}Turn passes — and ${oppName} has no cards left to draw. Deck-out!`, winnerId: meId };
      }
      opp.hand.push(drawn);
      return { text: `${text}. ${checkup.text}Turn passes — ${oppName} drew a card.` };
    }
    case "setStatus": {
      needPlayPhase();
      const side = action.side === "me" ? me : opp;
      const stack = getStack(side, action.target);
      const status = (stack.status ??= []);
      const has = status.includes(action.status);
      if (action.on && !has) status.push(action.status);
      if (!action.on && has) status.splice(status.indexOf(action.status), 1);
      const whose = action.side === "me" ? "their" : "the opposing";
      return {
        text: action.on
          ? `marked ${whose} ${stack.face.name} as ${action.status}`
          : `cleared ${action.status} from ${whose} ${stack.face.name}`,
      };
    }
    case "damage": {
      needPlayPhase();
      needTurn("deal damage");
      const targetOwnerId = action.side === "me" ? meId : oppId;
      const side = action.side === "me" ? me : opp;
      const stack = getStack(side, action.target);
      const delta = Math.max(-990, Math.min(990, Math.round(action.delta / 10) * 10));
      stack.damage = Math.max(0, Math.min(990, stack.damage + delta));
      const whose = action.side === "me" ? "their" : "the opposing";
      let text =
        delta >= 0
          ? `put ${delta} damage on ${whose} ${stack.face.name} (now ${stack.damage}${stack.face.hp ? ` / ${stack.face.hp} HP` : ""})`
          : `healed ${-delta} from ${whose} ${stack.face.name} (now ${stack.damage})`;
      // HP known and reached → automatic knockout + prize.
      if (stack.face.hp && stack.damage >= stack.face.hp) {
        const ko = knockOut(targetOwnerId, action.target, `${text} —`);
        return { text: ko.text, winnerId: ko.winnerId };
      }
      return { text };
    }
    case "knockout": {
      // Manual KO (for cards without HP data, or effects) — awards the
      // prize exactly like an automatic knockout.
      const ko = knockOut(meId, action.target, "declared a Knock Out —");
      return { text: ko.text, winnerId: ko.winnerId };
    }
    case "stackToHand": {
      const stack = removeStack(me, action.target);
      me.hand.push(...stackCards(stack));
      return { text: `picked ${stack.face.name} (and everything attached) up into their hand` };
    }
    case "detach": {
      // side "opp": attack/card effects that strip energy off the OPPOSING
      // Pokémon — the cards always go to their owner's discard/hand.
      const owner = action.side === "opp" ? opp : me;
      const stack = getStack(owner, action.target);
      const card = stack.attached[action.attachedIndex];
      if (!card) throw new BattleError("That attached card isn't there anymore.");
      stack.attached.splice(action.attachedIndex, 1);
      const whose = action.side === "opp" ? `the opposing ${stack.face.name}` : stack.face.name;
      const suffix = action.side === "opp" ? " (card effect)" : effectNote;
      if (action.to === "hand") {
        owner.hand.push(card);
        return { text: `returned ${card.name} from ${whose} to ${action.side === "opp" ? `${oppName}'s` : "their"} hand${suffix}` };
      }
      owner.discard.push(card);
      return { text: `discarded ${card.name} from ${whose}${suffix}` };
    }
    case "benchActive": {
      if (!me.active) throw new BattleError("You have no Active Pokémon.");
      if (me.bench.length >= MAX_BENCH) throw new BattleError("Your Bench is full (5 max).");
      const stack = me.active;
      stack.status = []; // leaving Active clears conditions
      me.bench.push(stack);
      me.active = null;
      return { text: `moved ${stack.face.name} from Active to their Bench${effectNote || " (card effect)"}` };
    }
    case "useStadium": {
      const st = state.stadium;
      if (!st) throw new BattleError("There's no Stadium in play.");
      const t = st.card.rules?.join(" ") ?? "";
      return {
        text: `used the Stadium ${st.card.name}${t ? ` — “${t.length > 160 ? t.slice(0, 160) + "…" : t}”` : ""}`,
      };
    }
    case "takePrize": {
      const prize = me.prizes.shift();
      if (!prize) throw new BattleError("You have no Prize cards left.");
      me.hand.push(prize);
      let text = `took a Prize card (${me.prizes.length} left)`;
      if (me.prizes.length === 0) {
        return { text: `${text} — that was the last Prize. The battle is over!`, winnerId: meId };
      }
      return { text };
    }
    case "flipCoin": {
      return { text: Math.random() < 0.5 ? "flipped a coin: HEADS 🪙" : "flipped a coin: TAILS 🪙" };
    }
    case "endTurn": {
      needPlayPhase();
      needTurn("end the turn");
      state.turnUser = oppId;
      state.turnCount += 1;
      turnsTaken[meId] = myTurnsDone + 1;
      state.flags = {};
      const swept = sweepPlayed(me);
      const checkup = runCheckup();
      if (checkup.winnerId) {
        return { text: `ended their turn${swept}. ${checkup.text}`, winnerId: checkup.winnerId };
      }
      // Every turn begins with a draw; running out of cards loses the game.
      const drawn = opp.deck.shift();
      if (!drawn) {
        return {
          text: `ended their turn${swept}. ${checkup.text}${oppName} has no cards left to draw. Deck-out!`,
          winnerId: meId,
        };
      }
      opp.hand.push(drawn);
      return { text: `ended their turn${swept}. ${checkup.text}${oppName} drew a card` };
    }
    case "claimTurn": {
      // Unjam: if the table got out of sync with reality (someone forgot to
      // End turn and play continued informally), either player can claim
      // the turn. Loudly logged so it can't be sneaky.
      needPlayPhase();
      if (myTurn) throw new BattleError("It's already your turn.");
      state.turnUser = meId;
      state.flags = {};
      sweepPlayed(opp); // the interrupted player's table cards still discard
      return { text: "took the turn (out-of-turn fix — agreed at the table)" };
    }
    case "concede":
      // Handled by the API route (it also flips the battle row's status).
      return { text: "conceded the battle" };
    case "undo":
      // Also the route's: undo restores a whole previous board, which is not
      // something one action can express against the current one.
      throw new BattleError("Undo is handled before the board is touched.");
    default:
      throw new BattleError("Unknown action.");
  }
}

export function pushLog(state: BattleState, actorName: string, text: string) {
  state.log.push({ at: new Date().toISOString(), text: `${actorName} ${text}` });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

export function pushLogRaw(state: BattleState, text: string) {
  state.log.push({ at: new Date().toISOString(), text });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

/** What one player is allowed to see of a side. Hands, deck order, and
 *  face-down prizes stay hidden — only counts are exposed. */
export interface SideView {
  handCount: number;
  deckCount: number;
  prizeCount: number;
  discard: BattleCard[];
  active: BattleStack | null;
  bench: BattleStack[];
  /** Trainers played this turn, face-up for both players. */
  played: BattleCard[];
  ready: boolean;
}

export interface BattleView {
  me: SideView & { hand: BattleCard[] };
  opp: SideView;
  rules: boolean;
  phase: "setup" | "play";
  myTurn: boolean;
  turnCount: number;
  /** Whether the current turn's one-energy attachment is already used. */
  energyUsed: boolean;
  /** The shared Stadium in play, if any. */
  stadium: { card: BattleCard; mine: boolean } | null;
  /** What this viewer can take back, or null. Only ever their own move. */
  undo: string | null;
  log: LogEntry[];
}

function sideView(side: SideState): SideView {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    prizeCount: side.prizes.length,
    discard: side.discard,
    active: side.active,
    bench: side.bench,
    played: side.played ?? [],
    ready: side.ready === true,
  };
}

export function redactState(state: BattleState, viewerId: string, oppId: string): BattleView {
  const mine = state.sides[viewerId];
  const theirs = state.sides[oppId];
  return {
    me: { ...sideView(mine), hand: mine.hand },
    opp: sideView(theirs),
    rules: state.rules === true,
    phase: state.rules === true ? (state.phase ?? "setup") : "play",
    myTurn: state.turnUser === viewerId,
    turnCount: state.turnCount,
    energyUsed: state.flags?.energy === true,
    stadium: state.stadium
      ? { card: state.stadium.card, mine: state.stadium.owner === viewerId }
      : null,
    // Only the player who made the move is offered it back, and only the
    // label crosses — the snapshot itself holds both hands and full deck
    // order, so it must never reach a client.
    undo: state.prev && state.prev.by === viewerId ? state.prev.label : null,
    log: state.log.slice(-100),
  };
}
