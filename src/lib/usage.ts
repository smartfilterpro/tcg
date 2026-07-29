import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";
import { debitCredits } from "@/lib/credits";

/** USD per million tokens, by model prefix (longest match wins). */
const PRICING: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "claude-opus", input: 5, output: 25 },
  { prefix: "claude-sonnet", input: 3, output: 15 },
  { prefix: "claude-haiku", input: 1, output: 5 },
  { prefix: "claude-fable", input: 10, output: 50 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate =
    PRICING.find((p) => model.startsWith(p.prefix)) ?? { input: 5, output: 25 };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
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
    | "find_image"
    | "trade_chat"
    | "deck_review"
    | "grade"
    | "card_fx",
  model: string,
  usage: { input_tokens?: number | null; output_tokens?: number | null } | undefined
): Promise<void> {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  try {
    await supabase.from("ai_usage").insert({
      user_id: userId,
      endpoint,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch {
    // Usage logging is best-effort (e.g. before migration 003 has been run).
  }
  // Every metered AI call debits the credit ledger HERE — one choke point,
  // debiting what the call actually cost rather than a fixed menu price.
  // ai_usage stays the cost record; the ledger is the account. debitCredits
  // skips infrastructure endpoints (card_fx) and is itself best-effort.
  await debitCredits(userId, endpoint, estimateCostUsd(model, inputTokens, outputTokens));
}
