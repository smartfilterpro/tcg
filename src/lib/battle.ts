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
  /** Max HP when known — enables auto-knockout. */
  hp?: number | null;
}

/** A Pokémon in play: the face card plus everything attached under/behind it
 *  (energy, tools, pre-evolutions). */
export interface BattleStack {
  face: BattleCard;
  attached: BattleCard[];
  damage: number;
  /** turnCount when this stack hit the board or last evolved (0 = setup). */
  playedTurn?: number;
}

export interface SideState {
  deck: BattleCard[];
  hand: BattleCard[];
  prizes: BattleCard[];
  discard: BattleCard[];
  active: BattleStack | null;
  bench: BattleStack[];
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
  flags?: { energy?: boolean; supporter?: boolean };
  turnUser: string | null;
  turnCount: number;
  log: LogEntry[];
}

export type BattleAction = { override?: boolean } & (
  | { type: "draw" }
  | { type: "shuffleDeck" }
  | { type: "mulligan" }
  | { type: "setPrizes" }
  | { type: "ready" }
  | { type: "handToActive"; handIndex: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToBench"; handIndex: number; benchIndex?: number; mode: "new" | "evolve" | "attach" }
  | { type: "handToDiscard"; handIndex: number }
  | { type: "playCard"; handIndex: number }
  | { type: "promote"; benchIndex: number }
  | { type: "damage"; side: "me" | "opp"; target: "active" | number; delta: number }
  | { type: "knockout"; target: "active" | number }
  | { type: "stackToHand"; target: "active" | number }
  | { type: "detach"; target: "active" | number; attachedIndex: number; to: "discard" | "hand" }
  | { type: "takePrize" }
  | { type: "flipCoin" }
  | { type: "endTurn" }
  | { type: "concede" }
);

export interface ActionResult {
  text: string;
  /** Set when this action ended the game. */
  winnerId?: string;
}

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

/** Deal a fresh side: shuffle and draw the 7-card hand. Prizes are NOT
 *  dealt here — official rules set prizes only after mulligans resolve and
 *  Basics are placed. Dealing them earlier can strand a player's only Basic
 *  Pokémon in the prize pile where no mulligan can ever recover it. */
export function buildSide(cards: BattleCard[]): SideState {
  const deck = shuffle(cards);
  const hand = deck.splice(0, 7);
  return { deck, hand, prizes: [], discard: [], active: null, bench: [] };
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

  const rules = state.rules === true;
  const phase = rules ? (state.phase ?? "setup") : "play";
  const override = action.override === true;
  const myTurn = state.turnUser === meId;
  const oppName = state.names[oppId] ?? "your opponent";
  const flags = (state.flags ??= {});
  const effectNote = override ? " (card effect)" : "";

  function needTurn(what: string) {
    if (rules && phase === "play" && !myTurn && !override) {
      throw new BattleError(`It's ${oppName}'s turn — wait for yours to ${what}.`);
    }
  }
  function needPlayPhase() {
    if (rules && phase === "setup" && !override) {
      throw new BattleError("Finish setup first — place your Basics and tap Ready.");
    }
  }
  /** Basic-Pokémon-only check for putting a card straight onto the board. */
  function checkBoardPlay(card: BattleCard) {
    if (!rules || override) return;
    if (card.cat && card.cat !== "pokemon") {
      throw new BattleError(`${card.name} isn't a Pokémon — it can't be played to the board.`);
    }
    if (card.basic === false) {
      throw new BattleError(
        `${card.name} is an evolution — play it on top of a Pokémon in play, not straight to the board.`
      );
    }
  }
  function checkEvolve(stack: BattleStack, card: BattleCard) {
    if (!rules || override) return;
    if (card.cat && card.cat !== "pokemon") {
      throw new BattleError(`${card.name} isn't a Pokémon — use Attach for energy and tools.`);
    }
    if (card.basic === true) {
      throw new BattleError(`${card.name} is a Basic Pokémon — it can't evolve another Pokémon.`);
    }
    if ((stack.playedTurn ?? 0) === state.turnCount) {
      throw new BattleError(`${stack.face.name} came into play this turn — it can't evolve yet.`);
    }
    const myFirstTurn = state.turnCount <= (meId === state.firstUser ? 1 : 2);
    if (myFirstTurn) {
      throw new BattleError("No evolving on your first turn.");
    }
  }
  function checkAttach(card: BattleCard) {
    if (!rules || override || phase !== "play") return;
    if (card.cat === "energy") {
      if (flags.energy) {
        throw new BattleError(
          "You've already attached an energy this turn — if a card effect allows more, use the card-effect option."
        );
      }
      flags.energy = true;
    }
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
    if (rules) {
      const prize = taker.prizes.shift();
      if (prize) {
        taker.hand.push(prize);
        text += ` ${state.names[takerId] ?? "The opponent"} takes a Prize card (${taker.prizes.length} left).`;
      }
      if (taker.prizes.length === 0 && (state.phase ?? "play") === "play") {
        return { text: `${text} That was the last Prize — the battle is over!`, winnerId: takerId };
      }
      if (!owner.active && owner.bench.length === 0) {
        return {
          text: `${text} ${state.names[ownerId] ?? "That player"} has no Pokémon left in play!`,
          winnerId: takerId,
        };
      }
    }
    return { text };
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
      me.deck = shuffle(me.deck);
      return { text: "shuffled their deck" };
    }
    case "mulligan": {
      if (rules && phase === "play" && !override) {
        throw new BattleError("Mulligans only happen during setup.");
      }
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
    case "setPrizes": {
      if (me.prizes.length > 0) throw new BattleError("Your Prize cards are already set.");
      me.prizes = me.deck.splice(0, 6);
      return { text: `set out their ${me.prizes.length} Prize cards` };
    }
    case "ready": {
      if (!rules) throw new BattleError("This battle doesn't use ready-up.");
      if (phase !== "setup") throw new BattleError("The battle already started.");
      if (!me.active) throw new BattleError("Play a Basic Pokémon as your Active first.");
      if (me.ready) throw new BattleError("You're already ready.");
      me.ready = true;
      if (me.prizes.length === 0) me.prizes = me.deck.splice(0, 6);
      let text = "placed their Pokémon, set their Prize cards, and is ready";
      if (opp.ready) {
        state.phase = "play";
        const first = state.firstUser ?? meId;
        const firstSide = state.sides[first];
        const firstName = state.names[first] ?? "The first player";
        const drawn = firstSide.deck.shift();
        if (drawn) firstSide.hand.push(drawn);
        text += ` — both players are set! ${firstName} drew a card and starts turn 1 (no attacking on the very first turn).`;
      }
      return { text };
    }
    case "handToActive": {
      if (action.mode === "new") {
        if (me.active) throw new BattleError("You already have an Active Pokémon.");
        const card = me.hand[action.handIndex];
        if (!card) throw new BattleError("That card isn't in your hand anymore.");
        checkBoardPlay(card);
        needTurn("play a Pokémon");
        takeHandCard(me, action.handIndex);
        me.active = { face: card, attached: [], damage: 0, playedTurn: phase === "setup" ? 0 : state.turnCount };
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
        me.bench.push({ face: card, attached: [], damage: 0, playedTurn: phase === "setup" ? 0 : state.turnCount });
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
      if (rules && !override) {
        if (card.cat && card.cat !== "trainer") {
          throw new BattleError(
            `${card.name} isn't a Trainer card — Pokémon go to the board, energy gets attached.`
          );
        }
        if (card.sup) {
          if (flags.supporter) {
            throw new BattleError("Only one Supporter per turn — yours is used.");
          }
          flags.supporter = true;
        }
      }
      takeHandCard(me, action.handIndex);
      me.discard.push(card);
      return { text: `played ${card.name}${card.sup ? " (Supporter)" : ""}${effectNote}` };
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
      // voluntary retreat/switch is a your-turn move.
      if (me.active) needTurn("retreat");
      me.bench.splice(action.benchIndex, 1);
      if (me.active) me.bench.push(me.active);
      me.active = bench;
      return { text: `moved ${bench.face.name} to Active` };
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
      // Referee: HP known and reached → automatic knockout + prize.
      if (rules && stack.face.hp && stack.damage >= stack.face.hp) {
        const ko = knockOut(targetOwnerId, action.target, `${text} —`);
        return { text: ko.text, winnerId: ko.winnerId };
      }
      return { text };
    }
    case "knockout": {
      // Manual KO (for cards without HP data, or effects). In referee mode
      // it still awards the prize, same as an automatic knockout.
      if (rules) {
        const ko = knockOut(meId, action.target, "declared a Knock Out —");
        return { text: ko.text, winnerId: ko.winnerId };
      }
      const stack = removeStack(me, action.target);
      me.discard.push(...stackCards(stack));
      return { text: `sent ${stack.face.name} (and everything attached) to their discard pile` };
    }
    case "stackToHand": {
      const stack = removeStack(me, action.target);
      me.hand.push(...stackCards(stack));
      return { text: `picked ${stack.face.name} (and everything attached) up into their hand` };
    }
    case "detach": {
      const stack = getStack(me, action.target);
      const card = stack.attached[action.attachedIndex];
      if (!card) throw new BattleError("That attached card isn't there anymore.");
      stack.attached.splice(action.attachedIndex, 1);
      if (action.to === "hand") {
        me.hand.push(card);
        return { text: `returned ${card.name} from ${stack.face.name} to their hand` };
      }
      me.discard.push(card);
      return { text: `discarded ${card.name} from ${stack.face.name}` };
    }
    case "takePrize": {
      const prize = me.prizes.shift();
      if (!prize) throw new BattleError("You have no Prize cards left.");
      me.hand.push(prize);
      let text = `took a Prize card (${me.prizes.length} left)`;
      if (rules && me.prizes.length === 0 && (state.phase ?? "play") === "play") {
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
      state.flags = {};
      if (rules) {
        // Every turn begins with a mandatory draw; failing it loses the game.
        const drawn = opp.deck.shift();
        if (!drawn) {
          return {
            text: `ended their turn — and ${oppName} has no cards left to draw. Deck-out!`,
            winnerId: meId,
          };
        }
        opp.hand.push(drawn);
        return { text: `ended their turn — ${oppName} drew a card` };
      }
      return { text: "ended their turn" };
    }
    case "concede":
      // Handled by the API route (it also flips the battle row's status).
      return { text: "conceded the battle" };
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
  ready: boolean;
}

export interface BattleView {
  me: SideView & { hand: BattleCard[] };
  opp: SideView;
  rules: boolean;
  phase: "setup" | "play";
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
    log: state.log.slice(-100),
  };
}
