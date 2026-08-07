import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runCardImport, readImportState, IMPORT_PAGE_SIZE } from "@/lib/cardImport";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

// Pages per call. At 250 cards a page that is 5,000 cards, comfortably
// inside the time limit even when pokemontcg.io is slow — and the state is
// saved after every page, so an overrun costs one page, not the run.
const PAGES_PER_CALL = 20;

const running = globalThis as unknown as { __cardImportRunning?: boolean };

/** POST: import (or continue importing) the card catalogue.
 *  Body: { restart?: boolean } — restart begins again at page 1.
 *
 *  Returns after a bounded slice rather than running to completion; the
 *  admin panel calls again while `done` is false. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    if (running.__cardImportRunning) {
      return NextResponse.json({ started: false, alreadyRunning: true });
    }
    const body = (await req.json().catch(() => ({}))) as { restart?: boolean };
    running.__cardImportRunning = true;
    try {
      const admin = createAdminClient();
      const state = await runCardImport(admin, PAGES_PER_CALL, { restart: body.restart === true });
      return NextResponse.json({ state, pageSize: IMPORT_PAGE_SIZE });
    } finally {
      running.__cardImportRunning = false;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Import failed");
  }
}

/** GET: where the import got to. */
export async function GET() {
  try {
    await requireAdmin();
    const state = await readImportState(createAdminClient());
    return NextResponse.json({
      state,
      running: running.__cardImportRunning === true,
      pageSize: IMPORT_PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
