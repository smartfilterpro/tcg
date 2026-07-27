import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";
import { fetchAllRows } from "@/lib/fetchAll";

export interface UserUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costUsd30d: number;
  costUsdMonth: number; // current calendar month — what the budget cap counts
}

/** GET: all users + pending invites + per-user AI usage (admin only). */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const [{ data: profiles }, { data: invites }, { data: usageRows }] = await Promise.all([
      admin.from("profiles").select("*").order("created_at"),
      admin.from("invites").select("*").order("created_at", { ascending: false }),
      // Paged: Supabase caps responses at 1000 rows — usage totals were
      // silently undercounting once the log grew past that.
      fetchAllRows(
        () =>
          admin
            .from("ai_usage")
            .select("user_id, model, input_tokens, output_tokens, created_at")
            .order("created_at", { ascending: false })
            .order("id"),
        50000
      ),
    ]);

    // Aggregate token usage per user (all-time + last 30 days + this month)
    const cutoff30d = Date.now() - 30 * 24 * 3600 * 1000;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const usage: Record<string, UserUsage> = {};
    for (const row of usageRows ?? []) {
      const u = (usage[row.user_id] ??= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costUsd30d: 0,
        costUsdMonth: 0,
      });
      u.calls += 1;
      u.inputTokens += row.input_tokens ?? 0;
      u.outputTokens += row.output_tokens ?? 0;
      const cost = estimateCostUsd(row.model ?? "", row.input_tokens ?? 0, row.output_tokens ?? 0);
      u.costUsd += cost;
      const t = new Date(row.created_at).getTime();
      if (t >= cutoff30d) u.costUsd30d += cost;
      if (t >= monthStart.getTime()) u.costUsdMonth += cost;
    }

    const profileEmails = new Set((profiles ?? []).map((p) => p.email));
    return NextResponse.json({
      users: profiles ?? [],
      invites: (invites ?? []).filter((i) => !profileEmails.has(i.email)),
      usage,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
