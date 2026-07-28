// "Is this actually worth sending in?" — the question behind every grade
// estimate. We already store graded market values on cards (graded_prices,
// migration 023), so the answer is arithmetic rather than a guess.

export type GradedPrices = Record<string, number>;

export interface ValueRow {
  grade: number;
  /** Display form of the source tier, e.g. "PSA 10". */
  tier: string;
  value: number;
  /** What you clear after the fee, versus just selling it raw. */
  net: number;
  likely: boolean;
}

export interface GradeValue {
  cardId: string | null;
  cardName: string | null;
  raw: number | null;
  fee: number;
  rows: ValueRow[];
  likely: ValueRow | null;
  worstCase: ValueRow | null;
  bestCase: ValueRow | null;
  verdict: string;
  /** True when we had no graded comparables at all. */
  thin: boolean;
}

/** "PSA_9", "BGS_9_5", "CGC_10" → { company, grade }. */
export function parseTier(key: string): { company: string; grade: number } | null {
  const m = /^(PSA|BGS|CGC|SGC)_(\d+)(?:_(\d))?$/i.exec(key.trim());
  if (!m) return null;
  const grade = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  if (!Number.isFinite(grade)) return null;
  return { company: m[1].toUpperCase(), grade };
}

/** PSA first — it's the scale the rubric is modelled on and the deepest
 *  market — then BGS, CGC, SGC. */
const COMPANY_ORDER = ["PSA", "BGS", "CGC", "SGC"];

function priceFor(graded: GradedPrices, grade: number): { tier: string; value: number } | null {
  const matches: Array<{ company: string; value: number }> = [];
  for (const [key, value] of Object.entries(graded)) {
    const parsed = parseTier(key);
    if (!parsed || parsed.grade !== grade || typeof value !== "number" || value <= 0) continue;
    matches.push({ company: parsed.company, value });
  }
  if (matches.length === 0) return null;
  const rank = (company: string) => {
    const i = COMPANY_ORDER.indexOf(company);
    return i === -1 ? COMPANY_ORDER.length : i;
  };
  matches.sort((a, b) => rank(a.company) - rank(b.company));
  const best = matches[0];
  const gradeText = Number.isInteger(grade) ? String(grade) : grade.toFixed(1);
  return { tier: `${best.company} ${gradeText}`, value: best.value };
}

/** Pull the low/high out of a range string like "7.5-8.5". */
export function parseRange(range: string, fallback: number): { low: number; high: number } {
  const nums = (range.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 10);
  if (nums.length === 0) return { low: fallback, high: fallback };
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function computeGradeValue(opts: {
  cardId: string | null;
  cardName: string | null;
  estimatedGrade: number;
  range: string;
  raw: number | null;
  graded: GradedPrices | null;
  fee: number;
}): GradeValue {
  const { cardId, cardName, estimatedGrade, raw, fee } = opts;
  const graded = opts.graded ?? {};
  const { low, high } = parseRange(opts.range, estimatedGrade);

  // Grades worth pricing: everything the range covers, plus the round
  // grades above it — the upside is the whole reason people gamble on
  // submitting a card.
  const candidates = new Set<number>();
  for (let g = Math.floor(low * 2) / 2; g <= Math.ceil(high); g += 0.5) candidates.add(g);
  candidates.add(estimatedGrade);
  if (estimatedGrade >= 8) {
    candidates.add(9);
    candidates.add(10);
  }

  const rows: ValueRow[] = [];
  for (const grade of [...candidates].sort((a, b) => a - b)) {
    if (grade < 1 || grade > 10) continue;
    const found = priceFor(graded, grade);
    if (!found) continue;
    rows.push({
      grade,
      tier: found.tier,
      value: found.value,
      net: found.value - fee - (raw ?? 0),
      likely: grade === estimatedGrade,
    });
  }

  const likely = rows.find((r) => r.likely) ?? null;
  const inRange = rows.filter((r) => r.grade >= low && r.grade <= high);
  const worstCase = inRange.length > 0 ? inRange[0] : null;
  const bestCase = inRange.length > 0 ? inRange[inRange.length - 1] : rows[rows.length - 1] ?? null;
  // The honest upside is the CHEAPEST grade that turns a profit, not the
  // most expensive one on the table.
  const breakEven = rows.find((r) => r.net > 0) ?? null;

  const parts: string[] = [];
  const thin = rows.length === 0;
  const anyGradedData = Object.keys(graded).some((k) => parseTier(k));
  if (thin) {
    if (anyGradedData) {
      parts.push(
        `We have graded prices for this card, but none at the grades it's likely to land in, so there's nothing meaningful to compare against.`
      );
      if (raw != null) parts.push(`Raw it's worth about ${money(raw)}, against a ${money(fee)} fee.`);
    } else if (raw != null) {
      parts.push(
        `No graded sales data for this card yet, so there's nothing to compare against. Raw it's worth about ${money(raw)} — grading costs ${money(fee)}, so it only makes sense if you want it slabbed for its own sake.`
      );
    } else {
      parts.push(
        "No price data for this card yet, so there's no way to say whether grading pays. Prices fill in as the background refresh reaches this card."
      );
    }
  } else if (likely && likely.net > 0) {
    parts.push(
      `At the estimated ${estimatedGrade}, a ${likely.tier} is worth about ${money(likely.value)} — roughly ${money(likely.net)} ahead after the ${money(fee)} fee` +
        (raw != null ? ` and the ${money(raw)} you'd give up selling it raw` : "") +
        "."
    );
    const downside = worstCase && worstCase.grade < estimatedGrade ? worstCase : null;
    if (downside) {
      parts.push(
        `If it comes back a ${downside.grade} instead, you'd be ${
          downside.net >= 0 ? `${money(downside.net)} ahead` : `${money(Math.abs(downside.net))} behind`
        } — that's the risk you're taking.`
      );
    }
  } else if (likely) {
    parts.push(
      `At the estimated ${estimatedGrade}, a ${likely.tier} runs about ${money(likely.value)} — about ${money(Math.abs(likely.net))} short of the ${money(fee)} fee` +
        (raw != null ? ` plus the ${money(raw)} raw value` : "") +
        "."
    );
    parts.push(
      breakEven
        ? `It only starts paying at a ${breakEven.grade} (${money(breakEven.value)}), so it's a gamble rather than a payday.`
        : "Not worth submitting on value alone."
    );
  } else {
    parts.push(
      `No graded comparable at the estimated ${estimatedGrade} for this card${
        bestCase ? `, though a ${bestCase.tier} goes for about ${money(bestCase.value)}` : ""
      }.`
    );
  }
  const verdict = parts.join(" ");

  return { cardId, cardName, raw, fee, rows, likely, worstCase, bestCase, verdict, thin };
}
