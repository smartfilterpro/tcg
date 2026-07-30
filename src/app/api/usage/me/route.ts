import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";
import { fetchAllRows } from "@/lib/fetchAll";
import { creditSummary } from "@/lib/credits";

/** GET: the current user's TrainerAI usage for this month, as a share of
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

    const { data } = await fetchAllRows(() =>
      supabase
        .from("ai_usage")
        .select("model, input_tokens, output_tokens, created_at")
        .eq("user_id", user.id)
        .gte("created_at", since.toISOString())
        .order("created_at")
        .order("id")
    );

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

    // Credits: the account the app now meters against. The credit cycle is
    // per-user (signup anniversary; Stripe billing period once that lands),
    // so it deliberately does NOT share monthStart above — the old percent
    // fields stay only until the Phase 5 meter replaces the panel.
    let credits: {
      balance: number;
      plan: string;
      pooled: boolean;
      cycleStart: string;
      monthlyGrant: number;
      spentByReason: Record<string, number>;
    } | null = null;
    if (!isAdmin) {
      try {
        credits = await creditSummary(user, profile);
      } catch {
        // Pre-migration-026: the meter shows the legacy view and nothing breaks.
      }
    }

    const budget =
      profile?.ai_budget_usd == null ? null : Number(profile.ai_budget_usd);
    const percentUsed =
      isAdmin || budget == null || !Number.isFinite(budget)
        ? null
        : budget <= 0
          ? 100
          : Math.min(100, (spentMonth / budget) * 100);

    const resetsOn = credits
      ? (() => {
          const next = new Date(credits.cycleStart);
          next.setUTCMonth(next.getUTCMonth() + 1);
          return next;
        })()
      : (() => {
          const next = new Date(monthStart);
          next.setUTCMonth(next.getUTCMonth() + 1);
          return next;
        })();

    return NextResponse.json({
      admin: isAdmin,
      percentUsed,
      calls,
      resetsOn: resetsOn.toISOString(),
      daily: normalized,
      credits,
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
