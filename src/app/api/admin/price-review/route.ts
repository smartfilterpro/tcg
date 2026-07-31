import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Deciding a held price. The nightly refresh refuses to auto-apply any
// price that moved more than 5× and parks it in the run summary; this is
// the button for each parked row. "apply" accepts the feed's new price;
// "keep" stands by the current one and stamps the card so the very next
// run doesn't re-flag the same jump at the admin again tomorrow.

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const { cardId, action } = (await req.json()) as { cardId?: string; action?: string };
    if (!cardId || (action !== "apply" && action !== "keep")) {
      return NextResponse.json({ error: "Need cardId and action: apply | keep." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: state } = await admin
      .from("app_state")
      .select("value")
      .eq("key", "price_refresh")
      .maybeSingle();
    const summary = (state?.value ?? null) as {
      suspicious?: Array<{ id: string; name: string; old: number; next: number }>;
    } | null;
    const held = summary?.suspicious ?? [];
    const entry = held.find((s) => s.id === cardId);
    if (!entry) {
      return NextResponse.json({ error: "That card isn't held anymore." }, { status: 404 });
    }

    if (action === "apply") {
      const { error } = await admin
        .from("cards")
        .update({ market_price: entry.next, price_updated_at: new Date().toISOString() })
        .eq("id", cardId);
      if (error) throw error;
    } else {
      // Keeping the old price: stamp the check so the card goes to the back
      // of the stale queue instead of re-flagging tomorrow. If the feed
      // still says otherwise weeks from now, it will come back — which is
      // the right behaviour for a price that might genuinely be moving.
      const { error } = await admin
        .from("cards")
        .update({ price_updated_at: new Date().toISOString() })
        .eq("id", cardId);
      if (error) throw error;
    }

    const remaining = held.filter((s) => s.id !== cardId);
    // Update ONLY value: app_state.updated_at is the refresh loop's run
    // claim, and touching it here would silently postpone tonight's run.
    await admin
      .from("app_state")
      .update({ value: { ...(summary ?? {}), suspicious: remaining } })
      .eq("key", "price_refresh");

    return NextResponse.json({ ok: true, suspicious: remaining });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Review failed" },
      { status: 500 }
    );
  }
}
