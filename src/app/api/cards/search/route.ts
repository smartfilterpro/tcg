import { NextResponse } from "next/server";
import { searchCards } from "@/lib/pokemontcg";
import { requireUser, AuthError } from "@/lib/auth";

/** Parse a free-form query into name / collector-number / set-size parts.
 *  Supported shapes:
 *    "101/190"            → number 101 in a set of 190
 *    "#101" or "101"      → number 101 in any set
 *    "TG12/TG30", "SV045" → alphanumeric promo/gallery numbers
 *    "Charizard 4/102"    → name + number + set size
 *    "Charizard"          → name only
 */
function parseQuery(raw: string): { name?: string; number?: string; printedTotal?: string } {
  const q = raw.trim();

  // "number/total" — optionally preceded by a name, e.g. "Charizard 4/102"
  const slash = q.match(/^(.*?)[\s#]*([A-Za-z]{0,4}\d{1,3}[a-z]?)\s*\/\s*[A-Za-z]{0,4}(\d{1,3})$/);
  if (slash) {
    const name = slash[1].trim();
    return {
      name: name || undefined,
      number: slash[2],
      printedTotal: slash[3],
    };
  }

  // "#101" — explicit number, any set
  const hash = q.match(/^#\s*([A-Za-z]{0,4}\d{1,3}[a-z]?)$/);
  if (hash) return { number: hash[1] };

  // Bare number (or promo codes like "TG12", "SV045") — nothing else it could be
  const bare = q.match(/^([A-Za-z]{0,4}\d{1,3}[a-z]?)$/);
  if (bare && /\d/.test(q) && !/^[A-Za-z]+\d$/.test(q)) {
    // exclude names ending in a digit like "Porygon2" (letters+single digit)
    return { number: bare[1] };
  }

  return { name: q };
}

/** Live card search against pokemontcg.io — used by the "fix this card" picker. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q) return NextResponse.json({ cards: [] });

    const parsed = parseQuery(q);
    let cards = await searchCards({ ...parsed, pageSize: 16 });

    // Number-based searches can be over-constrained (e.g. printedTotal counts
    // only the base set, not secret rares) — relax progressively.
    if (cards.length === 0 && parsed.printedTotal) {
      cards = await searchCards({ name: parsed.name, number: parsed.number, pageSize: 16 });
    }
    if (cards.length === 0 && parsed.number && !parsed.name) {
      cards = await searchCards({ name: q, pageSize: 16 });
    }

    return NextResponse.json({ cards });
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
