import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";
import { debitCredits } from "@/lib/credits";

/** USD per million tokens. Longest matching prefix wins, so a rate for one
 *  model sits in front of the family rate behind it.
 *
 *  `until` marks a rate that expires — introductory pricing, mostly. A call
 *  is priced by the rate in force when it was made, not the rate in force
 *  when somebody opens the admin page: re-pricing July's rows at September's
 *  rate would quietly rewrite what the month cost. */
interface Rate {
  prefix: string;
  input: number;
  output: number;
  /** Exclusive: the rate applies to calls made strictly before this. */
  until?: string;
}

const PRICING: Rate[] = [
  // Sonnet 5 launched at an introductory rate that ends after 31 August
  // 2026, at which point the family rate below takes over on its own.
  { prefix: "claude-sonnet-5", input: 2, output: 10, until: "2026-09-01T00:00:00Z" },
  { prefix: "claude-opus", input: 5, output: 25 },
  { prefix: "claude-sonnet", input: 3, output: 15 },
  { prefix: "claude-haiku", input: 1, output: 5 },
  { prefix: "claude-fable", input: 10, output: 50 },
];

/** Cache writes cost a quarter again over fresh input; cache reads a tenth
 *  of it. Both are relative to the model's own input rate, so they follow
 *  it automatically. The write figure is the five-minute one, which is the
 *  only TTL this app asks for. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** The four token counts a call can produce. All optional: a caller with
 *  only two of them is describing a call that genuinely had two. */
export interface TokenCounts {
  input?: number | null;
  output?: number | null;
  /** `cache_creation_input_tokens` on the API response. */
  cacheWrite?: number | null;
  /** `cache_read_input_tokens` on the API response. */
  cacheRead?: number | null;
}

function rateFor(model: string, at: Date): { input: number; output: number } {
  let best: Rate | null = null;
  for (const r of PRICING) {
    if (!model.startsWith(r.prefix)) continue;
    if (r.until && at.getTime() >= Date.parse(r.until)) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  // An unrecognised model is priced as Opus — the dearest tier we sell, so
  // an unknown model can only ever be over-estimated, never under.
  return best ?? { input: 5, output: 25 };
}

/** What one call cost, in dollars.
 *
 *  `at` is when the call was made. Callers re-deriving cost from a stored
 *  row should pass that row's timestamp; callers pricing a call they just
 *  made can leave it out. */
export function estimateCostUsd(model: string, tokens: TokenCounts, at: Date = new Date()): number {
  const rate = rateFor(model, at);
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const cacheRead = tokens.cacheRead ?? 0;
  return (
    (input * rate.input +
      output * rate.output +
      cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * rate.input * CACHE_READ_MULTIPLIER) /
    1_000_000
  );
}

/** The token counts as the API reports them. `input_tokens` is the UNCACHED
 *  remainder, not the whole prompt — the total is all three input figures
 *  added together, which is why reading only the first under-counted every
 *  request that used the cache. */
export function tokensFrom(
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined
): Required<{ [K in keyof TokenCounts]: number }> {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
  };
}

/** Record one AI call's token usage. Fire-and-forget: a logging failure must
 *  never break the feature that made the call. */
export async function logAiUsage(
  supabase: SupabaseClient,
  userId: string,
  endpoint:
    | "scan"
    | "deck_build"
    | "coach"
    | "chat"
    | "find_image"
    | "trade_chat"
    | "deck_review"
    | "grade"
    | "card_fx"
    // The mail-in scanning service. Never metered against a member's
    // credits — the admin runs it and the job carries its own bill.
    | "bulk_scan",
  model: string,
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined,
  /** Which thinking depth this call ran at, where the caller sets one.
   *  Recorded so a change to it can be measured afterwards rather than
   *  inferred from a deploy timestamp. */
  effort?: string
): Promise<void> {
  const tokens = tokensFrom(usage);
  try {
    await supabase.from("ai_usage").insert({
      user_id: userId,
      endpoint,
      model,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_write_tokens: tokens.cacheWrite,
      cache_read_tokens: tokens.cacheRead,
      effort: effort ?? null,
    });
  } catch {
    // Usage logging is best-effort (e.g. before a migration has been run).
  }
  // Every metered AI call debits the credit ledger HERE — one choke point,
  // debiting what the call actually cost rather than a fixed menu price.
  // ai_usage stays the cost record; the ledger is the account. debitCredits
  // skips infrastructure endpoints (card_fx) and is itself best-effort.
  await debitCredits(userId, endpoint, estimateCostUsd(model, tokens));
}

/** Cost of a stored ai_usage row, priced at the rate in force when it was
 *  written. Rows predating migration 057 carry zeros for the cache columns,
 *  which is what they always implicitly claimed. */
export function rowCostUsd(row: {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_read_tokens?: number | null;
  created_at?: string | null;
}): number {
  return estimateCostUsd(
    row.model ?? "",
    {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheWrite: row.cache_write_tokens,
      cacheRead: row.cache_read_tokens,
    },
    row.created_at ? new Date(row.created_at) : new Date()
  );
}
