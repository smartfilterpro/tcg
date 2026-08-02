import { NextResponse } from "next/server";
import { requireModerator, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET ?refused=1 — what people have tried to call themselves and their
 *  decks. Refusals are the evidence of intent; acceptances are what the
 *  screen let through, which is the half a human has to skim, because the
 *  screen fails open by design. */
export async function GET(req: Request) {
  try {
    await requireModerator();
    const refusedOnly = new URL(req.url).searchParams.get("refused") === "1";
    const admin = createAdminClient();

    let q = admin
      .from("name_audit")
      .select("id, user_id, kind, attempted, allowed, reason, created_at")
      .order("created_at", { ascending: false })
      .limit(60);
    if (refusedOnly) q = q.eq("allowed", false);
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({
        rows: [],
        migrated: !/name_audit/.test(error.message),
      });
    }

    const ids = [...new Set((data ?? []).map((r) => r.user_id as string))];
    const who = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .in("id", ids);
      for (const p of profiles ?? []) {
        who.set(
          p.id as string,
          ((p.display_name as string | null)?.trim() || (p.email as string)) as string
        );
      }
    }

    // Refusal counts per person over the last week: one is a typo, several
    // is a decision, and the difference is what the admin is looking for.
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const strikes = new Map<string, number>();
    for (const r of data ?? []) {
      if (r.allowed === false && (r.created_at as string) >= weekAgo) {
        strikes.set(r.user_id as string, (strikes.get(r.user_id as string) ?? 0) + 1);
      }
    }

    return NextResponse.json({
      migrated: true,
      rows: (data ?? []).map((r) => ({
        id: r.id,
        userId: r.user_id,
        who: who.get(r.user_id as string) ?? "A member",
        kind: r.kind,
        attempted: r.attempted,
        allowed: r.allowed,
        reason: r.reason,
        at: r.created_at,
        strikes: strikes.get(r.user_id as string) ?? 0,
      })),
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
