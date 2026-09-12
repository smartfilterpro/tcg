import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { runCardSearch } from "@/lib/cardSearch";
import { runMtgSearch } from "@/lib/scryfall";
import { errorJson } from "@/lib/apiError";

/** Live card search — used by the Add card and "fix this card" pickers.
 *
 *  The pipeline itself lives in lib/cardSearch so the admin probe can run
 *  the SAME code and report what each stage did. A probe that reimplemented
 *  the search would explain a program nobody is running. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const params = new URL(req.url).searchParams;
    const q = params.get("q")?.trim();
    if (!q) return NextResponse.json({ cards: [] });
    // local=1 — the picker's fast lane: our own rows only, returned
    // immediately, painted while the full answer is still in flight.
    const localOnly = params.get("local") === "1";

    // game=mtg — the Magic pipeline is its own, much shorter road: our own
    // rows plus Scryfall, which holds every printing and costs nothing.
    // None of the Pokémon search's staging (or its paid deep escalation)
    // applies.
    if (params.get("game") === "mtg") {
      const supabaseMtg = await createClient();
      const cards = await runMtgSearch(supabaseMtg, q, { localOnly });
      return NextResponse.json({ cards, source: localOnly ? "catalogue" : "scryfall" });
    }

    // deep=1 — the picker's "search every source" escalation. Off by
    // default because it spends paid credits, and a debounced search box
    // would spend them a keystroke at a time.
    const deep = params.get("deep") === "1";
    const supabase = await createClient();
    const { cards, source, notice } = await runCardSearch(supabase, q, { deep, localOnly });
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
