import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";

/** GET: the current user's Trainer AI usage for this month, as a share of
 *  their allowance — deliberately no dollar amounts (that's admin-only).
 *  { admin, percentUsed, calls, resetsOn, daily: number[14] (0..1) } */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const supabase = await createClient();

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const daysBack = new Date(Date.now() - 13 * 24 * 3600 * 1000);
    daysBack.setUTCHours(0, 0, 0, 0);
    const since = monthStart < daysBack ? monthStart : daysBack;

    const { data } = await supabase
      .from("ai_usage")
      .select("model, input_tokens, output_tokens, created_at")
      .eq("user_id", user.id)
      .gte("created_at", since.toISOString())
      .limit(20000);

    const rows = data ?? [];
    let spentMonth = 0;
    let calls = 0;
    const dayCost = new Map<string, number>();
    for (const r of rows) {
      const cost = estimateCostUsd(r.model ?? "", r.input_tokens ?? 0, r.output_tokens ?? 0);
      const t = new Date(r.created_at);
      if (t >= monthStart) {
        spentMonth += cost;
        calls += 1;
      }
      const key = t.toISOString().slice(0, 10);
      dayCost.set(key, (dayCost.get(key) ?? 0) + cost);
    }

    // Last 14 days, oldest → newest, normalized so the busiest day is 1
    const daily: number[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      daily.push(dayCost.get(d.toISOString().slice(0, 10)) ?? 0);
    }
    const peak = Math.max(...daily, 0.000001);
    const normalized = daily.map((v) => v / peak);

    const isAdmin = profile?.role === "admin";
    const budget =
      profile?.ai_budget_usd == null ? null : Number(profile.ai_budget_usd);
    const percentUsed =
      isAdmin || budget == null || !Number.isFinite(budget)
        ? null
        : budget <= 0
          ? 100
          : Math.min(100, (spentMonth / budget) * 100);

    const resetsOn = new Date(monthStart);
    resetsOn.setUTCMonth(resetsOn.getUTCMonth() + 1);

    return NextResponse.json({
      admin: isAdmin,
      percentUsed,
      calls,
      resetsOn: resetsOn.toISOString(),
      daily: normalized,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
