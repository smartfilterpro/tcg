import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAll";

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

/** Is this user allowed to make another AI call this calendar month?
 *  Admins are never capped. Fails open: if anything about the check breaks
 *  (pre-migration column, query error), the call is allowed. */
export async function checkAiBudget(
  supabase: SupabaseClient,
  user: { id: string },
  profile: { role?: string; ai_budget_usd?: number | string | null } | null
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (!profile || profile.role === "admin") return { ok: true };
    const budget =
      profile.ai_budget_usd == null ? null : Number(profile.ai_budget_usd);
    if (budget == null || !Number.isFinite(budget)) return { ok: true };

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("ai_usage")
        .select("model, input_tokens, output_tokens")
        .eq("user_id", user.id)
        .gte("created_at", monthStart.toISOString())
        .order("created_at")
        .order("id")
    );
    if (error) return { ok: true };
    const spent = (data ?? []).reduce(
      (s, r) => s + estimateCostUsd(r.model ?? "", r.input_tokens ?? 0, r.output_tokens ?? 0),
      0
    );
    if (spent >= budget) {
      return {
        ok: false,
        message: `You've used this month's AI allowance (~$${spent.toFixed(2)} of $${budget.toFixed(2)}). It resets on the 1st — or ask the admin to raise your limit.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
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
