/** Player-vs-player battle engine.
 *
 * The app is the table, not the referee: it shuffles, deals, tracks zones,
 * damage, prizes, and coin flips, and keeps hidden information hidden — but
 * the two players enforce the actual game rules themselves, exactly like
 * playing across a real table. That keeps every card playable without the
 * app needing to understand any card's effects.
 */

export interface BattleCard {
  uid: string;
  name: string;
  image: string | null;
}

/** A Pokémon in play: the face card plus everything attached under/behind it
 *  (energy, tools, pre-evolutions). */
export interface BattleStack {
  face: BattleCard;
  attached: BattleCard[];
  damage: number;
}

export interface SideState {
  deck: BattleCard[];
  hand: BattleCard[];
  prizes: BattleCard[];
  discard: BattleCard[];
  active: BattleStack | null;
  bench: BattleStack[];
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
  turnUser: string | null;
  turnCount: number;
  log: LogEntry[];
}

export type BattleAction =
  | { type: "draw" }
  | { type: "shuffleDeck" }
  | { type: "mulligan" }
  | { type: "handToActive"; handIndex: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToBench"; handIndex: number; benchIndex?: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToDiscard"; handIndex: number }
  | { type: "promote"; benchIndex: number }
  | { type: "damage"; side: "me" | "opp"; target: "active" | number; delta: number }
  | { type: "knockout"; target: "active" | number }
  | { type: "stackToHand"; target: "active" | number }
  | { type: "detach"; target: "active" | number; attachedIndex: number; to: "discard" | "hand" }
  | { type: "takePrize" }
  | { type: "flipCoin" }
  | { type: "endTurn" }
  | { type: "concede" };

export class BattleError extends Error {}

const MAX_BENCH = 5;
const MAX_LOG = 200;

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deal a fresh side: shuffle, 7-card hand, 6 face-down prizes. */
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

function placeOnStack(stack: BattleStack, card: BattleCard, mode: "evolve" | "attach"): string {
  if (mode === "evolve") {
    stack.attached.push(stack.face);
    const prev = stack.face.name;
    stack.face = card;
    return `evolved ${prev} into ${card.name}`;
  }
  stack.attached.push(card);
  return `attached ${card.name} to ${stack.face.name}`;
}

/** Apply one player action. Mutates `state`, returns the log line text
 *  (without the actor's name). Throws BattleError on an impossible move. */
export function applyAction(
  state: BattleState,
  meId: string,
  oppId: string,
  action: BattleAction
): string {
  const me = state.sides[meId];
  const opp = state.sides[oppId];
  if (!me || !opp) throw new BattleError("Battle state is missing a player.");

  switch (action.type) {
    case "draw": {
      const card = me.deck.shift();
      if (!card) return "tried to draw — their deck is empty!";
      me.hand.push(card);
      return "drew a card";
    }
    case "shuffleDeck": {
      me.deck = shuffle(me.deck);
      return "shuffled their deck";
    }
    case "mulligan": {
      me.deck.push(...me.hand);
      me.hand = [];
      me.deck = shuffle(me.deck);
      me.hand = me.deck.splice(0, 7);
      return "shuffled their hand into their deck and drew 7 new cards";
    }
    case "handToActive": {
      if (action.mode === "new") {
        if (me.active) throw new BattleError("You already have an Active Pokémon.");
        const card = takeHandCard(me, action.handIndex);
        me.active = { face: card, attached: [], damage: 0 };
        return `played ${card.name} as their Active Pokémon`;
      }
      const stack = getStack(me, "active");
      const card = takeHandCard(me, action.handIndex);
      return placeOnStack(stack, card, action.mode);
    }
    case "handToBench": {
      if (action.mode === "new" || action.benchIndex === undefined) {
        if (me.bench.length >= MAX_BENCH) throw new BattleError("Your Bench is full (5 max).");
        const card = takeHandCard(me, action.handIndex);
        me.bench.push({ face: card, attached: [], damage: 0 });
        return `played ${card.name} to their Bench`;
      }
      const stack = getStack(me, action.benchIndex);
      const card = takeHandCard(me, action.handIndex);
      return placeOnStack(stack, card, action.mode);
    }
    case "handToDiscard": {
      const card = takeHandCard(me, action.handIndex);
      me.discard.push(card);
      return `discarded ${card.name} from their hand`;
    }
    case "promote": {
      const bench = me.bench[action.benchIndex];
      if (!bench) throw new BattleError("Nothing in that Bench spot.");
      me.bench.splice(action.benchIndex, 1);
      if (me.active) me.bench.push(me.active);
      me.active = bench;
      return `moved ${bench.face.name} to Active`;
    }
    case "damage": {
      const side = action.side === "me" ? me : opp;
      const stack = getStack(side, action.target);
      const delta = Math.max(-990, Math.min(990, Math.round(action.delta / 10) * 10));
      stack.damage = Math.max(0, Math.min(990, stack.damage + delta));
      const whose = action.side === "me" ? "their" : "the opposing";
      return delta >= 0
        ? `put ${delta} damage on ${whose} ${stack.face.name} (now ${stack.damage})`
        : `healed ${-delta} from ${whose} ${stack.face.name} (now ${stack.damage})`;
    }
    case "knockout": {
      const stack = removeStack(me, action.target);
      me.discard.push(...stackCards(stack));
      return `sent ${stack.face.name} (and everything attached) to their discard pile`;
    }
    case "stackToHand": {
      const stack = removeStack(me, action.target);
      me.hand.push(...stackCards(stack));
      return `picked ${stack.face.name} (and everything attached) up into their hand`;
    }
    case "detach": {
      const stack = getStack(me, action.target);
      const card = stack.attached[action.attachedIndex];
      if (!card) throw new BattleError("That attached card isn't there anymore.");
      stack.attached.splice(action.attachedIndex, 1);
      if (action.to === "hand") {
        me.hand.push(card);
        return `returned ${card.name} from ${stack.face.name} to their hand`;
      }
      me.discard.push(card);
      return `discarded ${card.name} from ${stack.face.name}`;
    }
    case "takePrize": {
      const prize = me.prizes.shift();
      if (!prize) throw new BattleError("You have no Prize cards left.");
      me.hand.push(prize);
      return `took a Prize card (${me.prizes.length} left)`;
    }
    case "flipCoin": {
      return Math.random() < 0.5 ? "flipped a coin: HEADS 🪙" : "flipped a coin: TAILS 🪙";
    }
    case "endTurn": {
      state.turnUser = oppId;
      state.turnCount += 1;
      return "ended their turn";
    }
    case "concede":
      // Handled by the API route (it also flips the battle row's status).
      return "conceded the battle";
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
}

export interface BattleView {
  me: SideView & { hand: BattleCard[] };
  opp: SideView;
  myTurn: boolean;
  turnCount: number;
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
  };
}

export function redactState(state: BattleState, viewerId: string, oppId: string): BattleView {
  const mine = state.sides[viewerId];
  const theirs = state.sides[oppId];
  return {
    me: { ...sideView(mine), hand: mine.hand },
    opp: sideView(theirs),
    myTurn: state.turnUser === viewerId,
    turnCount: state.turnCount,
    log: state.log.slice(-100),
  };
}
