import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { runCardSearch } from "@/lib/cardSearch";

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

    const supabase = await createClient();
    const { cards, source } = await runCardSearch(supabase, q);
    // The trace is deliberately dropped here. It is a few kilobytes of
    // explanation on every keystroke of a debounced search box, and the
    // picker has no use for it.
    return NextResponse.json({ cards, source });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
