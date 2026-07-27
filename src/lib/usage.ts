import type { SupabaseClient } from "@supabase/supabase-js";

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
  endpoint: "scan" | "deck_build" | "coach" | "find_image" | "trade_chat",
  model: string,
  usage: { input_tokens?: number | null; output_tokens?: number | null } | undefined
): Promise<void> {
  try {
    await supabase.from("ai_usage").insert({
      user_id: userId,
      endpoint,
      model,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    });
  } catch {
    // Usage logging is best-effort (e.g. before migration 003 has been run).
  }
}
