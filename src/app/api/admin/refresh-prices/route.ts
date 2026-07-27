import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { refreshStalePrices, lastPriceRefresh } from "@/lib/priceRefresh";

export const maxDuration = 60;

// A refresh can take minutes (PokeTrace's free tier requires 2s between
// requests) — far longer than mobile browsers keep a request open. So POST
// starts the run detached and returns immediately; the panel polls GET
// until a fresh summary appears (results are recorded in app_state either
// way, including failures).

const running = globalThis as unknown as { __priceRefreshRunning?: boolean };

/** POST: start a refresh run in the background. */
export async function POST() {
  try {
    await requireAdmin();
    if (running.__priceRefreshRunning) {
      return NextResponse.json({ started: false, alreadyRunning: true });
    }
    running.__priceRefreshRunning = true;
    void (async () => {
      try {
        await refreshStalePrices();
      } catch (err) {
        console.error("manual price refresh error", err);
      } finally {
        running.__priceRefreshRunning = false;
      }
    })();
    return NextResponse.json({ started: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't start the refresh" },
      { status: 500 }
    );
  }
}

/** GET: the latest recorded run summary (poll target for the panel). */
export async function GET() {
  try {
    await requireAdmin();
    const summary = await lastPriceRefresh();
    return NextResponse.json({ summary, running: running.__priceRefreshRunning === true });
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
