/** Deterministic deck analysis — the math an experienced player does in
 *  their head, computed exactly. No AI involved: these numbers are used to
 *  VERIFY what the deck-builder AI produces (and to power a one-shot
 *  revision pass when the build fails the checks). */

export interface DeckMathEntry {
  name: string;
  quantity: number;
  category: "pokemon" | "trainer" | "energy" | string;
  /** True = Basic Pokémon, false = evolution, null/undefined = unknown. */
  basic?: boolean | null;
  /** Evolution stage when known ("Basic", "Stage 1", "Stage 2"). */
  stage?: string | null;
  /** Printed rules/effect text (trainers). */
  text?: string | null;
  /** Attack energy-cost sizes for Pokémon (e.g. [2, 3]). */
  attackCosts?: number[];
}

export interface DeckAnalysis {
  totalCards: number;
  basics: number;
  evolutions: number;
  trainers: number;
  drawSupporters: number;
  energyCount: number;
  /** % of opening hands with NO Basic Pokémon (forced mulligan). */
  mulliganPct: number;
  /** % of opening hands containing at least one draw/search trainer. */
  openingDrawPct: number;
  avgAttackCost: number | null;
  issues: string[];
}

/** P(zero successes in a 7-card opening hand) via hypergeometric. */
function pctNoneInSeven(deckSize: number, copies: number): number {
  if (copies <= 0) return 100;
  if (deckSize <= 7 || copies >= deckSize) return 0;
  let p = 1;
  for (let i = 0; i < 7; i++) {
    p *= (deckSize - copies - i) / (deckSize - i);
  }
  return p * 100;
}

const DRAW_TEXT = /draw|search your deck|look at the top/i;
// Well-known draw/search staples whose text may not be cached
const DRAW_NAMES =
  /professor'?s research|iono|hop\b|cynthia|marnie|colress|nest ball|ultra ball|quick ball|great ball|pok[eé] ball|level ball|buddy-buddy|capturing aroma|arven|pok[eé]gear/i;

/** Is this trainer a draw/search consistency card? (name + text heuristics) */
export function isDrawTrainer(name: string, text?: string | null): boolean {
  return DRAW_TEXT.test(text ?? "") || DRAW_NAMES.test(name);
}

export function analyzeDeck(entries: DeckMathEntry[]): DeckAnalysis {
  const totalCards = entries.reduce((s, e) => s + (e.quantity || 0), 0);
  const sum = (pred: (e: DeckMathEntry) => boolean) =>
    entries.filter(pred).reduce((s, e) => s + e.quantity, 0);

  const isBasicPokemon = (e: DeckMathEntry) =>
    e.category === "pokemon" && (e.basic === true || /^basic$/i.test(e.stage ?? ""));
  const isEvolution = (e: DeckMathEntry) =>
    e.category === "pokemon" && (e.basic === false || /^stage/i.test(e.stage ?? ""));

  const basics = sum(isBasicPokemon);
  // Unknown-stage Pokémon get counted as basics for mulligan math only if
  // NOTHING is known — safer to flag uncertainty than fake precision.
  const unknownStage = sum(
    (e) => e.category === "pokemon" && e.basic == null && !/^(basic|stage)/i.test(e.stage ?? "")
  );
  const evolutions = sum(isEvolution);
  const trainers = sum((e) => e.category === "trainer");
  const energyCount = sum((e) => e.category === "energy");
  const drawSupporters = sum(
    (e) =>
      e.category === "trainer" &&
      (DRAW_TEXT.test(e.text ?? "") || DRAW_NAMES.test(e.name))
  );

  const stage2 = sum((e) => /^stage ?2$/i.test(e.stage ?? ""));
  const rareCandy = sum((e) => /rare candy/i.test(e.name));

  const costs = entries
    .filter((e) => e.category === "pokemon" && e.attackCosts?.length)
    .flatMap((e) => e.attackCosts!.map((c) => ({ c, q: e.quantity })));
  const avgAttackCost =
    costs.length > 0
      ? costs.reduce((s, x) => s + x.c * x.q, 0) / costs.reduce((s, x) => s + x.q, 0)
      : null;

  const mulliganPct = pctNoneInSeven(totalCards, basics + unknownStage);
  const openingDrawPct = 100 - pctNoneInSeven(totalCards, drawSupporters);

  const issues: string[] = [];
  if (totalCards !== 60) issues.push(`Deck has ${totalCards} cards — it must be exactly 60.`);
  if (mulliganPct > 15)
    issues.push(
      `Only ${basics} Basic Pokémon → ${mulliganPct.toFixed(0)}% of opening hands mulligan. Aim for 8+ Basics (≤ ~12%).`
    );
  if (drawSupporters < 6)
    issues.push(
      `Only ${drawSupporters} draw/search trainers — the deck will brick. Aim for 8-12.`
    );
  if (avgAttackCost != null) {
    if (avgAttackCost >= 2.4 && energyCount < 10)
      issues.push(
        `Attacks average ${avgAttackCost.toFixed(1)} energy but the deck runs only ${energyCount} energy — add more (12-15 for hungry attackers).`
      );
    if (avgAttackCost <= 1.6 && energyCount > 13)
      issues.push(
        `Attacks are cheap (avg ${avgAttackCost.toFixed(1)}) but the deck runs ${energyCount} energy — trim to 8-10 and add trainers.`
      );
  }
  if (evolutions > basics)
    issues.push(
      `${evolutions} evolution Pokémon but only ${basics} Basics — evolution lines need wider bases (e.g. 4-3 or 3-2-2).`
    );
  if (stage2 > 0 && rareCandy === 0 && sum((e) => /^stage ?1$/i.test(e.stage ?? "")) === 0)
    issues.push(`Stage 2 Pokémon with no Stage 1s and no Rare Candy — they can never hit the board.`);

  return {
    totalCards,
    basics,
    evolutions,
    trainers,
    drawSupporters,
    energyCount,
    mulliganPct,
    openingDrawPct,
    avgAttackCost,
    issues,
  };
}

/** One-line summary for deck strategy text and logs. */
export function analysisSummary(a: DeckAnalysis): string {
  return (
    `Deck check — ${a.totalCards} cards · ${a.basics} Basics (mulligan ${a.mulliganPct.toFixed(0)}%) · ` +
    `${a.drawSupporters} draw/search trainers (in ${a.openingDrawPct.toFixed(0)}% of opening hands) · ` +
    `${a.energyCount} energy${a.avgAttackCost != null ? ` vs avg attack cost ${a.avgAttackCost.toFixed(1)}` : ""}`
  );
}
