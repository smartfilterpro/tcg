// What makes a Pokémon TCG deck legal, and enforcing it.
//
// The build prompt already said "Exactly 60 cards. Max 4 copies of any card
// by name" and the model shipped a list with 5x Duskull anyway. A prompt is
// a request; it is not a guarantee, and a deck list is exactly the kind of
// output where one wrong number is invisible until somebody is deck-checked
// out of a tournament.
//
// So the rules live here once, in two forms that cannot drift apart: the
// text the model is given, and the code that checks what it returned.
//
// ── The rules ────────────────────────────────────────────────────────────
// Sources: the official Play! Pokémon rules. Everything below is a
// construction rule, not a play rule — nothing here is about how a game
// runs, only about whether a list may be registered.

/** The 60-card requirement is exact. Not "at least", not "up to". */
export const DECK_SIZE = 60;

/** Copies of one card NAME, across every printing of it. */
export const MAX_COPIES = 4;

/** Basic energy is the one exemption from the 4-copy rule. Special energy
 *  is NOT — "Double Turbo Energy" is capped at 4 like any other card, which
 *  is the mistake people make when they hear "energy is unlimited". */
export const BASIC_ENERGY_RE =
  /^(?:basic\s+)?(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon)\s+energy$/i;

export function isBasicEnergy(name: string): boolean {
  return BASIC_ENERGY_RE.test(name.trim());
}

/** Cards limited to ONE PER DECK regardless of name.
 *
 *  These are the rules a model reliably forgets, because they are not "max
 *  N of this card" but "max N of this whole category across the deck":
 *
 *    ACE SPEC   — one ACE SPEC card in the entire deck, full stop. Not one
 *                 of each; one, total.
 *    Radiant    — one Radiant Pokémon in the entire deck, same shape.
 *
 *  Detected from the card's own text, since that is what we hold. A card
 *  whose rarity or subtype says ACE SPEC also usually prints the rule on
 *  the card, and matching the printed line is more reliable than trusting a
 *  rarity string that varies by source. */
export const DECK_UNIQUE_RULES: Array<{
  key: string;
  label: string;
  limit: number;
  test: (card: { name: string; text?: string | null; rarity?: string | null; subtypes?: string[] | null }) => boolean;
}> = [
  {
    key: "ace_spec",
    label: "ACE SPEC",
    limit: 1,
    test: (c) =>
      /ace\s*spec/i.test(c.rarity ?? "") ||
      (c.subtypes ?? []).some((s) => /ace\s*spec/i.test(s)) ||
      /you can'?t have more than 1 ace spec card in your deck/i.test(c.text ?? ""),
  },
  {
    key: "radiant",
    label: "Radiant Pokémon",
    limit: 1,
    test: (c) =>
      /^radiant\s/i.test(c.name) ||
      (c.subtypes ?? []).some((s) => /radiant/i.test(s)) ||
      /you can'?t have more than 1 radiant pok[ée]mon in your deck/i.test(c.text ?? ""),
  },
  {
    key: "prism_star",
    label: "Prism Star",
    limit: 1,
    test: (c) =>
      /◇|prism star/i.test(c.name) ||
      (c.subtypes ?? []).some((s) => /prism/i.test(s)),
  },
];

/** The block handed to the model. Written as prohibitions because that is
 *  what it kept getting wrong — the previous wording described the rules
 *  and the model still broke the first one. */
export const DECK_RULES_PROMPT = `DECK LEGALITY — THESE ARE HARD RULES. A deck that breaks one is worthless
to the player: they would be deck-checked out of a tournament. Count before
you answer.

- EXACTLY 60 cards. Not 59, not 61. Add up your quantities and check.
- NEVER more than 4 copies of a card BY NAME. This counts across printings:
  if you list "Munkidori" twice as two different cards, their quantities ADD
  UP, and 2 + 3 is illegal. Merge same-name entries into one, or make sure
  the total is 4 or fewer.
- NEVER more than 1 ACE SPEC card in the whole deck. This is not one of
  each — it is one ACE SPEC card, total. (Master Ball, Hero's Cape,
  Prime Catcher, Maximum Belt, Neo Upper Energy, Secret Box, Scoop Up
  Cyclone, Survival Brace, Unfair Stamp, Awakening Drum, Legacy Energy,
  Dangerous Laser, Poké Vital A, Deluxe Bomb, Sparkling Crystal, Reboot Pod,
  Grand Tree, Treasure Tracker, Brilliant Blender, Energy Search Pro,
  Precious Trolley, Maximum Belt.)
- NEVER more than 1 Radiant Pokémon in the whole deck. Same shape as ACE
  SPEC: one, total, across all Radiant Pokémon.
- NEVER more than 1 of any Prism Star (◇) card, and only one of each.
- AT LEAST 1 Basic Pokémon, or the deck cannot start. Aim for 8 or more.
- Basic energy is the ONLY exemption from the 4-copy rule. SPECIAL energy
  (Double Turbo, Jet, Reversal, Neo Upper, Luminous, etc.) is capped at 4
  by name like everything else.
- An evolution card needs its pre-evolution in the deck. A Stage 2 needs
  the Stage 1 as well, unless the deck runs Rare Candy.
- Every card must be legal in the requested format.

Before you return the JSON: add the quantities. If the total is not exactly
60, fix it. Check every name appears at most 4 times in total. Check you
have at most one ACE SPEC.`;

/* ------------------------------------------------------------- checking */

export interface DeckEntry {
  name: string;
  quantity: number;
  category?: string;
  card_id?: string | null;
  text?: string | null;
  rarity?: string | null;
  subtypes?: string[] | null;
}

export interface Violation {
  rule: string;
  message: string;
  /** True when the repair below can fix it without judgement. */
  repairable: boolean;
}

/** Same-name entries, folded. The 4-copy rule counts names, not rows, and
 *  a model that emits two printings of one card is not breaking the rule
 *  until you add them up — which is exactly why this is done in code. */
export function byName(cards: DeckEntry[]): Map<string, DeckEntry[]> {
  const out = new Map<string, DeckEntry[]>();
  for (const c of cards) {
    const key = c.name.trim().toLowerCase();
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  return out;
}

export function totalCards(cards: DeckEntry[]): number {
  return cards.reduce((n, c) => n + (Number.isFinite(c.quantity) ? c.quantity : 0), 0);
}

export function checkDeck(cards: DeckEntry[]): Violation[] {
  const problems: Violation[] = [];

  const total = totalCards(cards);
  if (total !== DECK_SIZE) {
    problems.push({
      rule: "size",
      message: `The deck has ${total} cards; it must have exactly ${DECK_SIZE}.`,
      repairable: true,
    });
  }

  for (const [, entries] of byName(cards)) {
    const name = entries[0].name;
    if (isBasicEnergy(name)) continue;
    const count = entries.reduce((n, e) => n + e.quantity, 0);
    if (count > MAX_COPIES) {
      problems.push({
        rule: "copies",
        message:
          entries.length > 1
            ? `${count} copies of ${name} across ${entries.length} printings — the limit is ${MAX_COPIES} by name.`
            : `${count} copies of ${name} — the limit is ${MAX_COPIES}.`,
        repairable: true,
      });
    }
  }

  for (const rule of DECK_UNIQUE_RULES) {
    const matching = cards.filter((c) => rule.test(c));
    const count = matching.reduce((n, c) => n + c.quantity, 0);
    if (count > rule.limit) {
      problems.push({
        rule: rule.key,
        message: `${count} ${rule.label} cards (${matching
          .map((c) => c.name)
          .join(", ")}) — only ${rule.limit} is allowed in a deck.`,
        repairable: true,
      });
    }
  }

  const basics = cards.filter(
    (c) => c.category === "pokemon" && (c.subtypes ?? []).some((s) => /^basic$/i.test(s))
  );
  // Only assert this when we actually have subtype data — claiming a deck
  // has no Basic Pokémon because we lack the data would be worse than
  // saying nothing.
  const anySubtypes = cards.some((c) => (c.subtypes ?? []).length > 0);
  if (anySubtypes && basics.length === 0) {
    problems.push({
      rule: "basics",
      message: "No Basic Pokémon — the deck cannot start a game.",
      repairable: false,
    });
  }

  return problems;
}

/** The app's own count of a deck, written for the model to read.
 *
 *  Counting sixty entries and cross-referencing every name against every
 *  other name is the single most expensive thing we ask a model to do about
 *  a deck, it is arithmetic rather than judgement, and it is the part it
 *  gets wrong. Doing it here and handing over the result costs nothing,
 *  cannot be miscounted, and leaves the model's attention for the question
 *  actually asked.
 *
 *  Says plainly what was NOT checked. A model told "the app checked
 *  legality" will report a deck as legal, and this can only see what is in
 *  the deck row — for a saved deck that is names, quantities and categories,
 *  with no card text or subtypes to recognise an ACE SPEC by. */
export function legalityBriefing(cards: DeckEntry[]): string {
  const problems = checkDeck(cards);
  const knowsSubtypes = cards.some((c) => (c.subtypes ?? []).length > 0);

  const lines = problems.length
    ? problems.map((p) => `- ${p.message}`).join("\n")
    : `- ${totalCards(cards)} cards, and no card appears more than ${MAX_COPIES} times by name.`;

  const unchecked = knowsSubtypes
    ? "evolution lines and format legality"
    : "ACE SPEC and Radiant limits (the app has no card text here, so it only spotted them by name), evolution lines, and format legality";

  return `THE APP'S OWN COUNT OF THIS DECK — these numbers are exact. Use them
instead of counting the list yourself:
${lines}

Not checked by the app: ${unchecked}. Judge those from your own knowledge of
the cards, and say so plainly if something is wrong.`;
}

/** Bring an illegal list back inside the rules, deterministically.
 *
 *  Trimming is always safe: it removes copies the deck may not legally
 *  hold. Topping back up to 60 is done with basic energy already in the
 *  deck, because that is the one card type with no copy limit and no
 *  evolution dependency — adding a Pokémon or a Trainer to reach 60 could
 *  break a different rule or an evolution line.
 *
 *  Returns what it did, so the player is told rather than quietly handed a
 *  different deck from the one described in the strategy text. */
export function repairDeck(cards: DeckEntry[]): { cards: DeckEntry[]; notes: string[] } {
  const notes: string[] = [];
  let out = cards.map((c) => ({ ...c, quantity: Math.max(0, Math.trunc(c.quantity || 0)) }));

  // 1. Copy limit, by name, across printings. Trim from the LAST printing
  //    first so the primary entry keeps its count.
  for (const [, entries] of byName(out)) {
    const name = entries[0].name;
    if (isBasicEnergy(name)) continue;
    let count = entries.reduce((n, e) => n + e.quantity, 0);
    if (count <= MAX_COPIES) continue;
    const before = count;
    for (let i = entries.length - 1; i >= 0 && count > MAX_COPIES; i--) {
      const cut = Math.min(entries[i].quantity, count - MAX_COPIES);
      entries[i].quantity -= cut;
      count -= cut;
    }
    notes.push(`Cut ${name} from ${before} to ${MAX_COPIES} — the limit is ${MAX_COPIES} by name.`);
  }

  // 2. One-per-deck categories.
  for (const rule of DECK_UNIQUE_RULES) {
    const matching = out.filter((c) => rule.test(c));
    let count = matching.reduce((n, c) => n + c.quantity, 0);
    if (count <= rule.limit) continue;
    const before = count;
    // Keep the first, drop the rest — the model listed its preferred one
    // first often enough, and any choice here beats an illegal deck.
    for (let i = matching.length - 1; i >= 0 && count > rule.limit; i--) {
      const keep = i === 0 ? rule.limit : 0;
      const cut = Math.min(matching[i].quantity, Math.max(0, count - rule.limit));
      const target = Math.max(keep, matching[i].quantity - cut);
      count -= matching[i].quantity - target;
      matching[i].quantity = target;
    }
    notes.push(
      `Reduced ${rule.label} cards from ${before} to ${rule.limit} — a deck may only hold ${rule.limit}.`
    );
  }

  out = out.filter((c) => c.quantity > 0);

  // 3. Back to exactly 60, using basic energy the deck already runs.
  const total = totalCards(out);
  if (total < DECK_SIZE) {
    const short = DECK_SIZE - total;
    const energy = out.find((c) => isBasicEnergy(c.name));
    if (energy) {
      energy.quantity += short;
      notes.push(`Added ${short} ${energy.name} to bring the deck back to ${DECK_SIZE}.`);
    } else {
      notes.push(
        `The deck is ${short} card${short === 1 ? "" : "s"} short of ${DECK_SIZE} — add ${short} basic energy.`
      );
    }
  } else if (total > DECK_SIZE) {
    // Over 60 after trimming: shave basic energy first, then the largest
    // non-Pokémon stack, since cutting a Pokémon can orphan an evolution.
    let over = total - DECK_SIZE;
    const order = [...out].sort((a, b) => {
      const rank = (c: DeckEntry) =>
        isBasicEnergy(c.name) ? 0 : c.category === "trainer" ? 1 : 2;
      return rank(a) - rank(b) || b.quantity - a.quantity;
    });
    for (const c of order) {
      if (over <= 0) break;
      const cut = Math.min(c.quantity - (c.category === "pokemon" ? 1 : 0), over);
      if (cut > 0) {
        c.quantity -= cut;
        over -= cut;
      }
    }
    out = out.filter((c) => c.quantity > 0);
    notes.push(`Trimmed ${total - DECK_SIZE} card(s) to bring the deck back to ${DECK_SIZE}.`);
  }

  return { cards: out, notes };
}
