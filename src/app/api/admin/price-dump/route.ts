import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { DumpUnavailable, exportsEnabled, runPriceDump, type DumpType } from "@/lib/priceDump";

// Downloading a dump is slow — a whole catalogue of gzipped CSV.
export const maxDuration = 300;

const TYPES: DumpType[] = ["cards", "printings", "sealed", "ebay", "population"];

/** GET — is it switched on? */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({
      enabled: exportsEnabled(),
      note: exportsEnabled()
        ? "Bulk exports are on. Run a dry run first."
        : "Off. Needs the Business plan and POKEMONPRICETRACKER_EXPORTS=1.",
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}

/** POST { type?, dryRun? } — pull a dump and (optionally) apply it.
 *
 *  dryRun defaults to TRUE. The HTTP side of this — auth, the 302 to blob
 *  storage, the pre-06:00 503 — could not be tested on the Personal plan, so
 *  the first real run should be one that cannot write anything. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { type?: string; dryRun?: boolean };
    const type = TYPES.includes(body.type as DumpType) ? (body.type as DumpType) : "printings";

    const result = await runPriceDump(createAdminClient(), {
      type,
      // Only an explicit false writes. A typo in the body must not turn a
      // look into a catalogue-wide overwrite.
      dryRun: body.dryRun !== false,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof DumpUnavailable) {
      return NextResponse.json(
        { error: err.message, retryAfterSeconds: err.retryAfterSeconds },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dump failed" },
      { status: 500 }
    );
  }
}
