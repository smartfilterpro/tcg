import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { runCardSearch } from "@/lib/cardSearch";
import { errorJson } from "@/lib/apiError";

/** Live card search — used by the Add card and "fix this card" pickers.
 *
 *  The pipeline itself lives in lib/cardSearch so the admin probe can run
 *  the SAME code and report what each stage did. A probe that reimplemented
 *  the search would explain a program nobody is running. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const q = new URL(req.url).searchParams.get("q")?.trim();
    if (!q) return NextResponse.json({ cards: [] });

    // deep=1 — the picker's "search every source" escalation. Off by
    // default because it spends paid credits, and a debounced search box
    // would spend them a keystroke at a time.
    const deep = new URL(req.url).searchParams.get("deep") === "1";
    const supabase = await createClient();
    const { cards, source, notice } = await runCardSearch(supabase, q, { deep });
    // The trace is deliberately dropped here. It is a few kilobytes of
    // explanation on every keystroke of a debounced search box, and the
    // picker has no use for it. The notice is one sentence and only appears
    // when the answer is knowably incomplete — that one the picker shows.
    return NextResponse.json({ cards, source, ...(notice ? { notice } : {}) });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Search failed");
  }
}
