import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";

// Recent scans, with where their time went.
//
// "A nine-card scan took 57 seconds" is a report nobody can act on, because
// the total hides which of three very different things was slow: the model
// reading the photo, our own catalogue answering, or a card falling through
// to an external API. Each scan now records its own split (migration 053) and
// this hands back the last few so the answer is a number rather than a guess.
//
// Read-only, admin-only, and it deliberately shows every member's scans —
// a pattern across accounts is the thing worth seeing.

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const limit = Math.min(50, Number(new URL(req.url).searchParams.get("limit") ?? 20) || 20);
    const admin = createAdminClient();

    // select("*") — timings only exists after migration 053, and naming it
    // would fail the whole read on a database without it.
    const { data, error } = await admin
      .from("scan_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const scans = rows.map((r) => {
      const t = (r.timings ?? null) as {
        modelMs?: number;
        matchMs?: number;
        totalMs?: number;
        cards?: Array<{ name: string; ms: number; path: string; swapped?: boolean }>;
      } | null;
      const cards = t?.cards ?? [];
      const byPath: Record<string, number> = {};
      for (const c of cards) byPath[c.path] = (byPath[c.path] ?? 0) + 1;
      return {
        id: r.id as string,
        at: r.created_at as string,
        status: r.status as string,
        cardCount: Array.isArray(r.cards) ? (r.cards as unknown[]).length : 0,
        durationMs: (r.duration_ms as number | null) ?? null,
        modelMs: t?.modelMs ?? null,
        matchMs: t?.matchMs ?? null,
        byPath,
        // The three worst cards, which is where a slow scan's time actually
        // sits — one card waiting on an external API can outweigh the rest.
        slowest: [...cards].sort((a, b) => b.ms - a.ms).slice(0, 3),
        error: (r.error as string | null) ?? null,
      };
    });

    const timed = scans.filter((s) => s.modelMs != null);
    return NextResponse.json({
      scans,
      // Null until migration 053 has run and a scan has happened since.
      summary:
        timed.length > 0
          ? {
              scans: timed.length,
              avgModelMs: Math.round(timed.reduce((n, s) => n + (s.modelMs ?? 0), 0) / timed.length),
              avgMatchMs: Math.round(timed.reduce((n, s) => n + (s.matchMs ?? 0), 0) / timed.length),
              fromCatalogue: timed.reduce((n, s) => n + (s.byPath.catalogue ?? 0), 0),
              fromOutside: timed.reduce(
                (n, s) => n + (s.byPath.pokemontcg ?? 0) + (s.byPath.tcgdex ?? 0),
                0
              ),
              unmatched: timed.reduce((n, s) => n + (s.byPath["no match"] ?? 0), 0),
            }
          : null,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Failed");
  }
}
