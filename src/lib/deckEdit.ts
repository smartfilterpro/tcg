// Letting TrainerAI change a deck — with the player's hand on the switch.
//
// The assistant could already read a collection and reason about a deck, and
// its answer to "can you update the deck for me?" was an honest no. Doing
// the swap by hand in the editor is a chore precisely when the advice is
// good, so the gap between "here is the exact edit" and "the edit is made"
// is the thing worth closing.
//
// The shape, which matters more than the feature:
//
//   The model PROPOSES. It never writes.
//   The player APPROVES a specific, itemised diff.
//   The server VALIDATES and writes.
//
// A model with direct write access to somebody's saved decks would be one
// misread question away from rewriting a list they spent an evening on.
// Proposing costs nothing if it is wrong, because a wrong proposal is
// declined rather than undone.
//
// Validation is the server's job and is not skipped just because a player
// approved: approval means "I want this change", not "I have checked it is
// legal and that I own the cards". Those are still ours to check.

import type { DeckEntry } from "@/lib/deckLegality";
import { checkDeck, isBasicEnergy } from "@/lib/deckLegality";

export interface DeckEditChange {
  /** Card name, exactly as it should read in the deck. */
  name: string;
  /** Copies AFTER the change. Zero removes the card. */
  to: number;
  /** Catalogue id when the model knows it, so a specific printing can be
   *  targeted; null for basic energy and for cards identified by name. */
  card_id?: string | null;
  /** One short line the player reads before approving. */
  reason?: string | null;
}

export interface DeckEditProposal {
  deckId: string;
  deckName: string;
  changes: DeckEditChange[];
}

export interface AppliedChange extends DeckEditChange {
  from: number;
}

/** Apply a proposal to a deck's card list, in memory.
 *
 *  Returns the new list and what actually changed, so the caller can show a
 *  diff that reflects the write rather than the request — a change asking
 *  for 3 of something the deck already runs 3 of is not a change, and
 *  saying so is better than reporting a no-op as an edit. */
export function applyChanges(
  cards: DeckEntry[],
  changes: DeckEditChange[]
): { cards: DeckEntry[]; applied: AppliedChange[] } {
  const next = cards.map((c) => ({ ...c }));
  const applied: AppliedChange[] = [];

  for (const change of changes) {
    const key = change.name.trim().toLowerCase();
    // Every printing of the name, because the deck may hold two rows for
    // one card and "make it 3" means three in total, not three of each.
    const matches = next.filter((c) => c.name.trim().toLowerCase() === key);
    const from = matches.reduce((n, c) => n + c.quantity, 0);
    const to = Math.max(0, Math.trunc(change.to));
    if (from === to) continue;

    if (matches.length === 0) {
      next.push({
        name: change.name.trim(),
        quantity: to,
        category: guessCategory(change.name),
        card_id: change.card_id ?? null,
      });
    } else if (to === 0) {
      for (const m of matches) m.quantity = 0;
    } else if (matches.length === 1) {
      matches[0].quantity = to;
    } else {
      // Spread across printings: fill the first rows to their previous
      // sizes where possible, so a deck running 2 of one print and 1 of
      // another going to 4 becomes 3 and 1 rather than collapsing.
      let left = to;
      for (const m of matches) {
        const take = Math.min(m.quantity, left);
        m.quantity = take;
        left -= take;
      }
      if (left > 0) matches[0].quantity += left;
    }

    applied.push({ ...change, to, from });
  }

  return { cards: next.filter((c) => c.quantity > 0), applied };
}

/** A rough category for a card the deck doesn't hold yet. Only used for
 *  grouping in the editor; the deck's legality does not depend on it. */
function guessCategory(name: string): string {
  if (isBasicEnergy(name)) return "energy";
  return "pokemon";
}

export interface EditValidation {
  ok: boolean;
  /** Reasons the edit is refused outright. */
  errors: string[];
  /** Things worth saying but not worth refusing over. */
  warnings: string[];
}

/** Would this edit produce a deck the player can legally play, from cards
 *  the player actually owns?
 *
 *  Deliberately REFUSES rather than repairing. The builder repairs, because
 *  there the model wrote a whole deck and the player never saw the illegal
 *  version. Here the player is approving a specific, itemised change: fixing
 *  it silently would mean applying something other than what they agreed to.
 */
export function validateEdit(
  cards: DeckEntry[],
  ownedByName: Map<string, number>
): EditValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const violation of checkDeck(cards)) {
    // Size is a warning, not an error: the editor lets a deck be saved at
    // any size on purpose — people build over several sittings — and
    // refusing an otherwise good edit because the deck is at 58 would make
    // the assistant useless mid-build.
    if (violation.rule === "size") warnings.push(violation.message);
    else errors.push(violation.message);
  }

  // Owned copies. Basic energy is exempt by the same app rule the builder
  // uses: players rarely scan energy, so the app assumes an endless supply.
  const wanted = new Map<string, number>();
  for (const c of cards) {
    const key = c.name.trim().toLowerCase();
    wanted.set(key, (wanted.get(key) ?? 0) + c.quantity);
  }
  for (const [key, need] of wanted) {
    if (isBasicEnergy(key)) continue;
    const owned = ownedByName.get(key) ?? 0;
    if (owned < need) {
      errors.push(
        `The deck would need ${need} ${titleCase(key)} but you own ${owned}.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}
