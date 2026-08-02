import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { priceTrackerEnabled, ptFetch, PriceTrackerError, budgetState } from "@/lib/priceTracker";

export const maxDuration = 60;

// Does the paid source carry SEALED product — booster boxes, ETBs, tins?
//
// I don't know, and neither their docs nor our code can tell us: everything
// we have built against them is card-shaped. Rather than guess in either
// direction, this asks. It tries a handful of plausible shapes for the same
// question and reports exactly what each returned, including the failures,
// so the answer comes from their server instead of from an assumption.
//
// Discovery, not invention: a 404 here is a real result and is reported as
// one. Nothing downstream is built on any of these paths until one of them
// is shown to work.
//
// Cost is a few credits — every attempt pins limit=1, and the ones that 404
// cost nothing at all.

/** Sealed items whose names are unambiguous and current enough that a real
 *  catalogue would hold them. Two, so a single odd product name can't be
 *  mistaken for the whole source having nothing. */
const PROBES = [
  "Surging Sparks Booster Box",
  "Prismatic Evolutions Elite Trainer Box",
];

/** The endpoints worth trying, in the order they are most likely to exist.
 *  `/cards` first because it is the one we KNOW answers — the question there
 *  is whether its index includes non-card products. */
const CANDIDATES: Array<{ path: string; params: (q: string) => Record<string, string> }> = [
  { path: "/cards", params: (q) => ({ search: q, limit: "1" }) },
  { path: "/products", params: (q) => ({ search: q, limit: "1" }) },
  { path: "/sealed", params: (q) => ({ search: q, limit: "1" }) },
];

/** A short, readable description of a response: is there data, and what does
 *  the first record call itself? Enough to tell "found a booster box" from
 *  "found a Pikachu card that happens to match the words". */
function describe(body: unknown): {
  records: number;
  firstName: string | null;
  firstKeys: string[];
} {
  const data = (body as { data?: unknown })?.data;
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const first = list[0] as Record<string, unknown> | undefined;
  return {
    records: list.length,
    firstName:
      first && typeof first.name === "string" ? (first.name as string).slice(0, 120) : null,
    firstKeys: first ? Object.keys(first).slice(0, 25) : [],
  };
}

export async function GET() {
  try {
    await requireAdmin();
    if (!priceTrackerEnabled()) {
      return NextResponse.json({
        configured: false,
        verdict: "POKEMONPRICETRACKER_API_KEY isn't set, so there is nothing to ask.",
      });
    }

    const attempts: Array<Record<string, unknown>> = [];
    for (const query of PROBES) {
      for (const candidate of CANDIDATES) {
        try {
          const body = await ptFetch(candidate.path, candidate.params(query));
          attempts.push({ query, path: candidate.path, ok: true, ...describe(body) });
        } catch (err) {
          const status = err instanceof PriceTrackerError ? err.status : null;
          attempts.push({
            query,
            path: candidate.path,
            ok: false,
            status,
            // 404 means the endpoint doesn't exist, which is a clean answer.
            // Anything else may be transient and is worth reading verbatim.
            error: err instanceof Error ? err.message.slice(0, 200) : "failed",
          });
        }
      }
    }

    // The verdict is deliberately conservative: a match only counts when the
    // record NAMES the sealed product back. A card search that returns some
    // unrelated Pikachu for "Surging Sparks Booster Box" is a miss, not a
    // hit, and reading it as a hit is how a feature gets built on nothing.
    const hits = attempts.filter((a) => {
      if (!a.ok || (a.records as number) === 0) return false;
      const name = ((a.firstName as string) ?? "").toLowerCase();
      return /booster box|elite trainer|etb|tin|bundle|collection box|pack/.test(name);
    });

    return NextResponse.json({
      configured: true,
      budget: budgetState(),
      verdict: hits.length
        ? `Sealed product IS available — ${hits.length} of ${attempts.length} attempts returned a named sealed item.`
        : "No sealed product came back from any attempt. Every endpoint tried is card-only, or the names are indexed differently.",
      hits: hits.map((h) => ({ path: h.path, query: h.query, firstName: h.firstName })),
      attempts,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Probe failed" },
      { status: 500 }
    );
  }
}
