import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** POST: record one scan's outcome for admin analytics. Best-effort —
 *  failures never bother the user. Body: { durationMs, detected,
 *  autoMatched, saved, keptMatch } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const b = (await req.json()) as Record<string, unknown>;
    const int = (v: unknown, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0;
    const supabase = await createClient();
    await supabase.from("scan_events").insert({
      user_id: user.id,
      duration_ms: int(b.durationMs, 60 * 60_000),
      cards_detected: int(b.detected, 500),
      cards_auto_matched: int(b.autoMatched, 500),
      cards_saved: int(b.saved, 500),
      cards_kept_match: int(b.keptMatch, 500),
    });
    // Errors (e.g. pre-migration-012) are intentionally swallowed.
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ ok: true }); // telemetry never fails loudly
  }
}
