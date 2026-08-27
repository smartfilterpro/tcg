// Magic deck legality — the deterministic half of the MTG deck builder.
//
// Mirrors deckLegality.ts's role for Pokémon: the model is TOLD the rules
// in its prompt, and then the returned list is checked and repaired in
// code, because a rule stated is not a rule enforced. Kept separate from
// the Pokémon lib because the two games share almost nothing here —
// Magic's rules are per-format (Commander's singleton vs Standard's
// 4-of), and its one universal exemption is basic lands, not basic energy.

export type MtgFormat = "commander" | "standard";

/** Card names exempt from copy limits in every format. Snow-covered
 *  versions are their own printed names. ("Any number" cards like Relentless
 *  Rats exist; they are rare enough that trimming them with a note beats
 *  maintaining a list — the note tells the player exactly what happened.) */
const BASIC_LAND_RE =
  /^(snow-covered\s+)?(plains|island|swamp|mountain|forest|wastes)$/i;

export function isBasicLand(name: string): boolean {
  return BASIC_LAND_RE.test(name.trim());
}

export interface MtgDeckEntry {
  name: string;
  quantity: number;
  category: string; // commander | creature | spell | land
  /** From battle_data where held — WUBRG letters. */
  colorIdentity?: string[] | null;
  /** Scryfall legality word for the format, where held. */
  legality?: string | null;
}

export interface MtgDeckIssue {
  message: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Deterministic problems with a Magic list. Never guesses: a check that
 *  needs data we don't hold (unknown color identity, unknown legality)
 *  stays silent rather than flagging a card on suspicion. */
export function checkMtgDeck(entries: MtgDeckEntry[], format: MtgFormat): MtgDeckIssue[] {
  const issues: MtgDeckIssue[] = [];
  const total = entries.reduce((s, e) => s + e.quantity, 0);
  const target = format === "commander" ? 100 : 60;
  if (total !== target) {
    issues.push({
      message:
        format === "commander"
          ? `A Commander deck is exactly 100 cards including the commander — this list has ${total}.`
          : `A Standard deck's main board is 60 cards — this list has ${total}.`,
    });
  }

  const commanders = entries.filter((e) => e.category === "commander");
  if (format === "commander") {
    if (commanders.length === 0) {
      issues.push({ message: "No commander is marked (category \"commander\", quantity 1, listed first)." });
    } else if (commanders.length > 1 || commanders[0].quantity !== 1) {
      issues.push({ message: "Exactly one commander card is allowed." });
    }
  } else if (commanders.length > 0) {
    issues.push({ message: "Standard decks have no commander slot." });
  }

  // Copy limits.
  const maxCopies = format === "commander" ? 1 : 4;
  const byName = new Map<string, number>();
  for (const e of entries) byName.set(norm(e.name), (byName.get(norm(e.name)) ?? 0) + e.quantity);
  for (const [name, qty] of byName) {
    if (isBasicLand(name)) continue;
    if (qty > maxCopies) {
      issues.push({
        message:
          format === "commander"
            ? `"${name}" appears ${qty}× — Commander is singleton (1 copy of everything except basic lands).`
            : `"${name}" appears ${qty}× — the limit is 4 copies (basic lands excepted).`,
      });
    }
  }

  // Color identity (Commander) — only where we HOLD both identities.
  if (format === "commander" && commanders[0]?.colorIdentity) {
    const allowed = new Set(commanders[0].colorIdentity.map((c) => c.toUpperCase()));
    for (const e of entries) {
      if (e.category === "commander" || !e.colorIdentity) continue;
      const outside = e.colorIdentity.filter((c) => !allowed.has(c.toUpperCase()));
      if (outside.length > 0) {
        issues.push({
          message: `"${e.name}" is ${outside.join("")} in its color identity — outside the commander's (${[...allowed].join("") || "colorless"}).`,
        });
      }
    }
  }

  // Format legality — only where Scryfall told us.
  const fmtKey = format === "commander" ? "commander" : "standard";
  for (const e of entries) {
    if (e.legality === "banned") {
      issues.push({ message: `"${e.name}" is banned in ${fmtKey}.` });
    } else if (e.legality === "not_legal" && format === "standard") {
      issues.push({ message: `"${e.name}" is not Standard-legal (rotated or never printed there).` });
    }
  }

  return issues;
}

/** Trim the mechanical violations code can fix without judgement: excess
 *  copies. Everything else (wrong totals, identity violations, banned
 *  cards) goes back to the model as revision issues — cutting cards to fix
 *  those requires deck-building judgement code shouldn't fake. */
export function repairMtgCopies(
  entries: MtgDeckEntry[],
  format: MtgFormat
): { entries: MtgDeckEntry[]; notes: string[] } {
  const maxCopies = format === "commander" ? 1 : 4;
  const notes: string[] = [];
  const seen = new Map<string, number>();
  const out: MtgDeckEntry[] = [];
  for (const e of entries) {
    if (isBasicLand(e.name)) {
      out.push(e);
      continue;
    }
    const had = seen.get(norm(e.name)) ?? 0;
    const room = Math.max(0, maxCopies - had);
    const qty = Math.min(e.quantity, room);
    seen.set(norm(e.name), had + qty);
    if (qty < e.quantity) {
      notes.push(`Trimmed "${e.name}" from ${had + e.quantity} to ${maxCopies} cop${maxCopies === 1 ? "y" : "ies"}.`);
    }
    if (qty > 0) out.push({ ...e, quantity: qty });
  }
  return { entries: out, notes };
}

/** The readable numbers that ride along in the strategy text, plus the
 *  issues handed back for the one revision pass. */
export function mtgAnalysis(
  entries: MtgDeckEntry[],
  format: MtgFormat
): { summary: string; issues: string[] } {
  const total = entries.reduce((s, e) => s + e.quantity, 0);
  const lands = entries
    .filter((e) => e.category === "land" || isBasicLand(e.name))
    .reduce((s, e) => s + e.quantity, 0);
  const creatures = entries
    .filter((e) => e.category === "creature")
    .reduce((s, e) => s + e.quantity, 0);
  const summary =
    `${total} cards · ${lands} lands · ${creatures} creatures` +
    (format === "commander" ? " · Commander (100-card singleton)" : " · Standard (60-card)");
  const issues = checkMtgDeck(entries, format).map((i) => i.message);
  return { summary, issues };
}
