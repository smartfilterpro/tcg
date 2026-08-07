import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireModerator, AuthError } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/usage";
import { fetchAllRows } from "@/lib/fetchAll";
import { errorJson } from "@/lib/apiError";

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
    const { isAdmin } = await requireModerator();
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

    // Last sign-in lives on the auth user, not the profile row, so it comes
    // from the auth admin API. Paged, and best-effort: a failure here costs
    // one column, not the whole members page.
    const lastSignIn: Record<string, string | null> = {};
    try {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) break;
        for (const authUser of data?.users ?? []) {
          lastSignIn[authUser.id] = authUser.last_sign_in_at ?? null;
        }
        if (!data?.users || data.users.length < 200) break;
      }
    } catch {
      /* leave the column empty */
    }

    const profileEmails = new Set((profiles ?? []).map((p) => p.email));
    // A moderator gets the list to work from, not the spend behind it. AI
    // cost per member is a business figure and none of a content role's
    // business — the UI hides those columns, and this makes the data
    // absent rather than merely unrendered.
    return NextResponse.json({
      users: profiles ?? [],
      invites: isAdmin ? (invites ?? []).filter((i) => !profileEmails.has(i.email)) : [],
      usage: isAdmin ? usage : {},
      lastSignIn: isAdmin ? lastSignIn : {},
      isAdmin,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return errorJson(err, "Request failed");
}
