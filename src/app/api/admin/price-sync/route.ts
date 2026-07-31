import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { budgetState, hydrateBudget, priceTrackerEnabled } from "@/lib/priceTracker";
import { readSyncState, runPriceSync } from "@/lib/priceTrackerSync";

// A slice of sets is a lot of HTTP and a lot of row updates.
export const maxDuration = 300;

const running = globalThis as unknown as { __priceSyncRunning?: boolean };

/** GET — where the sync got to, and what's left of today's allowance. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    // Re-adopt the persisted tally before reporting — otherwise the first
    // panel load after a deploy shows the restart's zeroed counter.
    await hydrateBudget();
    return NextResponse.json({
      enabled: priceTrackerEnabled(),
      running: running.__priceSyncRunning === true,
      budget: budgetState(),
      state: await readSyncState(admin),
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}

/** POST { maxSets?, reserve?, restart? } — walk another slice of sets.
 *
 *  Bounded per call rather than run to completion: the whole catalogue is
 *  around 20,500 cards and one credit each, so a full pass is slightly more
 *  than a day's allowance and far more than one request's time budget. The
 *  admin panel calls again while `done` is false. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    if (running.__priceSyncRunning) {
      return NextResponse.json({ started: false, alreadyRunning: true });
    }
    const body = (await req.json().catch(() => ({}))) as {
      maxSets?: number;
      reserve?: number;
      restart?: boolean;
    };

    running.__priceSyncRunning = true;
    try {
      const state = await runPriceSync(createAdminClient(), {
        maxSets: body.maxSets,
        reserve: body.reserve,
        restart: body.restart === true,
      });
      return NextResponse.json({ state, budget: budgetState() });
    } finally {
      running.__priceSyncRunning = false;
    }
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    );
  }
}
