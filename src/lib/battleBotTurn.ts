// Running the practice opponent's turn on the server.
//
// Kept apart from the move logic so the bot's decisions stay pure and
// testable, and only this file knows about the engine's side effects.

import { applyAction, pushLogRaw, BattleError, type BattleState } from "@/lib/battle";
import { BOT_ID, chooseMove } from "@/lib/battleBot";

/** Hard stop on one turn. A bot that somehow never chooses to end its turn
 *  must not spin: it ends the turn itself and the game continues. */
const MAX_MOVES_PER_TURN = 14;

/** Play the bot's whole turn, mutating `state`. Returns the winner's id if
 *  the turn ended the game. */
export function runBotTurn(state: BattleState, humanId: string): string | undefined {
  const botName = state.names[BOT_ID] ?? "TrainerAI";
  let winner: string | undefined;

  for (let i = 0; i < MAX_MOVES_PER_TURN; i++) {
    if (state.turnUser !== BOT_ID) break;
    const turnsTaken = state.turnsTaken ?? {};
    const flags = state.flags ?? {};
    const move = chooseMove(state, BOT_ID, {
      energyUsed: flags.energy === true,
      supporterUsed: flags.supporter === true,
      firstTurn: (turnsTaken[BOT_ID] ?? 0) === 0 && state.turnCount <= 1,
    });
    if (!move) break;

    try {
      const result = applyAction(state, BOT_ID, humanId, move.action);
      pushLogRaw(state, `${botName} ${result.text}`);
      if (result.winnerId) {
        winner = result.winnerId;
        break;
      }
    } catch (err) {
      // A refused move is a bug in the enumerator, not a reason to strand
      // the game. Log it, end the turn, carry on.
      pushLogRaw(
        state,
        `${botName} tried to ${move.label.toLowerCase()} and couldn't (${
          err instanceof BattleError ? err.message : "unexpected error"
        }) — ending its turn.`
      );
      try {
        const ended = applyAction(state, BOT_ID, humanId, { type: "endTurn" });
        pushLogRaw(state, `${botName} ${ended.text}`);
        winner = ended.winnerId;
      } catch {
        state.turnUser = humanId;
      }
      break;
    }

    if (move.action.type === "endTurn" || move.action.type === "attack") break;
  }

  // Whatever happened, play must come back to the human.
  if (!winner && state.turnUser === BOT_ID) {
    try {
      const ended = applyAction(state, BOT_ID, humanId, { type: "endTurn" });
      pushLogRaw(state, `${botName} ${ended.text}`);
      winner = ended.winnerId;
    } catch {
      state.turnUser = humanId;
    }
  }
  return winner;
}
