import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { refreshStalePrices } from "@/lib/priceRefresh";

export const maxDuration = 300; // a full refresh slice takes a while

/** POST: run a price-refresh slice right now (admin button). The background
 *  loop does this automatically about once a day. */
export async function POST() {
  try {
    await requireAdmin();
    const summary = await refreshStalePrices();
    return NextResponse.json({ summary });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("refresh-prices error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 }
    );
  }
}
