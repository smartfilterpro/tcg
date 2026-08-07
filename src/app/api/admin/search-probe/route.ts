import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { runCardSearch } from "@/lib/cardSearch";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 120;

/** Run a search and report what every stage did.
 *
 *  The companion to set-probe: that one asks what the SOURCES hold, this one
 *  asks what OUR PIPELINE made of it. Between them, "the card is missing"
 *  resolves to one of four places — the query parsed wrong, the catalogue
 *  doesn't have it, the external call was skipped, or the merge or the cap
 *  threw it away — instead of being narrowed down over several days by
 *  changing code and looking again.
 *
 *  Runs the real search, not a copy of it. */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q) return NextResponse.json({ error: "Type a search to trace." }, { status: 400 });

    // The probe could only ever trace an ORDINARY search, which meant it
    // could not trace the one thing being debugged. Asked about 55/217 it
    // reported "the catalogue already has that collector number — no
    // external call" and stopped, correctly describing a code path nobody
    // was asking about: the picker's escalation passes deep=1, and without
    // it the paid source is never reached, so the stage that would explain
    // it never appeared.
    const deep = url.searchParams.get("deep") === "1";

    const supabase = await createClient();
    const { cards, source, trace } = await runCardSearch(supabase, q, { deep });

    // The readings that are easy to miss in a wall of stages.
    const notes: string[] = [];
    if (!deep) {
      notes.push(
        "This traced an ORDINARY search. The paid source is only reached by the picker's " +
          "\u201cSearch every source\u201d button — tick 'every source' above to trace that instead."
      );
    }
    if (!trace.needExternal && !trace.listingSet) {
      notes.push(
        "The external sources were NOT consulted — the catalogue answered on its own. " +
          "Any card the import hasn't reached yet cannot appear in this result, however it is searched for."
      );
    }
    if (trace.cutByLimit.length > 0) {
      notes.push(
        `${trace.cutByLimit.length} card(s) were found and then cut by the result limit. ` +
          "If the one you want is in that list, the search worked and the cap is the problem."
      );
    }
    if (trace.foldedAway.length > 0) {
      notes.push(
        `${trace.foldedAway.length} card(s) were folded away as duplicates of something already in the list. ` +
          "A card wrongly folded is indistinguishable from a card never found — check that list first."
      );
    }
    if (!trace.parsed.name && !trace.parsed.number && !trace.parsed.setName) {
      notes.push("The query parsed to nothing recognisable, so every source was asked a blank question.");
    }
    const paidStage = trace.stages.find((s) => s.stage === "paid source");
    if (paidStage && /NOT configured/.test(paidStage.detail)) {
      notes.push(
        "The paid source is not configured, so no amount of searching will surface printings only it carries."
      );
    }
    if (trace.parsed.setName && !trace.listingSet) {
      notes.push(
        "A set was named AND a card name or number was given, so this is a filtered card search rather than a set listing — different limit, different order."
      );
    }

    return NextResponse.json({
      deep,
      source,
      resultCount: cards.length,
      results: cards.slice(0, 60).map((c) => `${c.number} ${c.name} [${c.setName ?? "?"}]`),
      trace,
      notes,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Probe failed");
  }
}
