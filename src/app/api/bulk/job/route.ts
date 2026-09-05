import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/secretCompare";
import { errorJson } from "@/lib/apiError";

// The rig's front desk. POST creates a bulk job from the scanning bench —
// authenticated with the admin-minted rig key, so the Pi bridge can start
// a customer's stack without anyone opening the admin panel. GET answers
// a job's own device key with its counts, for the bridge's status page.

export async function POST(req: Request) {
  try {
    const given = req.headers.get("x-rig-key") ?? "";
    if (!given) return NextResponse.json({ error: "Missing x-rig-key header." }, { status: 401 });
    const admin = createAdminClient();
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", "bulk_rig_key")
      .maybeSingle();
    const stored = (data?.value ?? null) as { hash?: string; created_by?: string } | null;
    const givenHash = createHash("sha256").update(given).digest("hex");
    if (!stored?.hash || !stored.created_by || !secretMatches(givenHash, stored.hash)) {
      return NextResponse.json({ error: "Unknown rig key." }, { status: 403 });
    }

    const { label, expected } = (await req.json().catch(() => ({}))) as {
      label?: string;
      expected?: number;
    };
    if (!label?.trim()) {
      return NextResponse.json({ error: "Name the job — customer name works." }, { status: 400 });
    }
    const deviceKey = `bk_${randomBytes(24).toString("base64url")}`;
    const { data: job, error } = await admin
      .from("bulk_jobs")
      .insert({
        label: label.trim().slice(0, 80),
        created_by: stored.created_by,
        device_key: deviceKey,
        expected_cards:
          typeof expected === "number" && expected > 0 ? Math.min(Math.floor(expected), 8000) : null,
      })
      .select("id, label, device_key")
      .single();
    if (error) {
      return NextResponse.json(
        {
          error: /bulk_jobs/.test(error.message)
            ? "Bulk scanning needs a database update — run supabase/migrations/039_bulk_scan.sql."
            : error.message,
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ job });
  } catch (err) {
    return errorJson(err, "Couldn't create the job");
  }
}

/** GET ?job=<id> with x-bulk-key — the job's own counts, device-key authed,
 *  so the bridge's status page can show progress without an admin login. */
export async function GET(req: Request) {
  try {
    const key = req.headers.get("x-bulk-key") ?? "";
    const jobId = new URL(req.url).searchParams.get("job") ?? "";
    if (!key || !jobId) {
      return NextResponse.json({ error: "Missing job or x-bulk-key." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: job } = await admin
      .from("bulk_jobs")
      .select("id, label, status, device_key")
      .eq("id", jobId)
      .maybeSingle();
    if (!job || !secretMatches(key, job.device_key as string | null)) {
      return NextResponse.json({ error: "Unknown job or wrong device key." }, { status: 403 });
    }
    const [p1, verified, review] = await Promise.all([
      admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", jobId).not("pass1_path", "is", null),
      admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("confidence", "verified"),
      admin.from("bulk_cards").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("confidence", "review").eq("reviewed", false),
    ]);
    return NextResponse.json({
      label: job.label,
      status: job.status,
      pass1: p1.count ?? 0,
      verified: verified.count ?? 0,
      needsReview: review.count ?? 0,
    });
  } catch (err) {
    return errorJson(err, "Couldn't read the job");
  }
}
