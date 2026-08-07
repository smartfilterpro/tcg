import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";

/** GET: every bulk job with its counts — the service's job board. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { data: jobs, error } = await admin
      .from("bulk_jobs")
      .select("id, label, status, expected_cards, ai_cost_usd, uploaded_to, uploaded_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      return NextResponse.json(
        { error: /bulk_jobs/.test(error.message) ? "Bulk scanning needs a database update — run supabase/migrations/039_bulk_scan.sql." : error.message },
        { status: 400 }
      );
    }

    const withCounts = await Promise.all(
      (jobs ?? []).map(async (j) => {
        const [p1, p2, verified, review, reviewed] = await Promise.all([
          admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", j.id).not("pass1_path", "is", null),
          admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", j.id).not("pass2_path", "is", null),
          admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", j.id).eq("confidence", "verified"),
          admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", j.id).eq("confidence", "review").eq("reviewed", false),
          admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", j.id).eq("reviewed", true),
        ]);
        return {
          ...j,
          ai_cost_usd: Number(j.ai_cost_usd ?? 0),
          pass1: p1.count ?? 0,
          pass2: p2.count ?? 0,
          verified: verified.count ?? 0,
          needsReview: review.count ?? 0,
          reviewed: reviewed.count ?? 0,
        };
      })
    );
    return NextResponse.json({ jobs: withCounts });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { label, expected? } → a new job and its device key. The key is the
 *  rig's credential — shown once here and again on the job card. */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin();
    const { label, expected } = (await req.json()) as { label?: string; expected?: number };
    if (!label?.trim()) {
      return NextResponse.json({ error: "Name the job — customer name works." }, { status: 400 });
    }
    const admin = createAdminClient();
    const deviceKey = `bk_${randomBytes(24).toString("base64url")}`;
    const { data: job, error } = await admin
      .from("bulk_jobs")
      .insert({
        label: label.trim().slice(0, 80),
        created_by: user.id,
        device_key: deviceKey,
        expected_cards:
          typeof expected === "number" && expected > 0 ? Math.min(Math.floor(expected), 8000) : null,
      })
      .select("id, label, device_key")
      .single();
    if (error) {
      return NextResponse.json(
        { error: /bulk_jobs/.test(error.message) ? "Bulk scanning needs a database update — run supabase/migrations/039_bulk_scan.sql." : error.message },
        { status: 400 }
      );
    }
    return NextResponse.json({ job });
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
