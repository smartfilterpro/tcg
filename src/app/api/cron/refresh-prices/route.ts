import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { refreshStalePrices } from "@/lib/priceRefresh";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

// The scheduled price refresh. There was no scheduler at all before this —
// prices only moved when an admin pressed the button, so a collection could
// sit months out of date without anything saying so.
//
// Deliberately a plain authenticated URL rather than anything host-specific,
// so it works from GitHub Actions (what the repo ships), a Railway cron
// service, or any other scheduler, without changing the app.

const running = globalThis as unknown as { __cronPriceRefreshRunning?: boolean };

/** Constant-time compare that can't leak length either. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function run(req: Request) {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  // No secret configured means no endpoint. An unauthenticated route that
  // burns the day's PokeTrace allowance is worse than no schedule at all.
  if (expected.length < 16) {
    return NextResponse.json(
      { error: "Scheduled refresh is not configured (set CRON_SECRET)." },
      { status: 503 }
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !secretMatches(token, expected)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  if (running.__cronPriceRefreshRunning) {
    return NextResponse.json({ started: false, alreadyRunning: true });
  }
  running.__cronPriceRefreshRunning = true;
  try {
    // Larger than a manual run: this is the one that has to get through a
    // whole collection over successive nights. The PokeTrace share stays
    // under its free daily cap with room left for a manual run on top, and
    // text warming is free (pokemontcg.io), so it takes a bigger slice.
    const summary = await refreshStalePrices(400, { ptBudget: 150, textBudget: 120 });
    return NextResponse.json({ started: true, summary });
  } catch (err) {
    return errorJson(err, "Refresh failed");
  } finally {
    running.__cronPriceRefreshRunning = false;
  }
}

/** POST is the real entry point. */
export async function POST(req: Request) {
  return run(req);
}

/** GET too — several schedulers can only issue a GET. Same auth either way. */
export async function GET(req: Request) {
  return run(req);
}
