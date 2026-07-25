import { NextResponse } from "next/server";
import { searchCards } from "@/lib/pokemontcg";
import { requireUser, AuthError } from "@/lib/auth";

/** Parse a free-form query into name / collector-number / set-size parts.
 *  Supported shapes:
 *    "101/190", "095/086"  → number in a set of that size (zeros OK)
 *    "095/SVP"             → promo-set code after the slash
 *    "#101" or "101"       → number in any set
 *    "TG12/TG30", "SWSH095"→ alphanumeric promo/gallery numbers
 *    "Charizard 4/102"     → name + number + set size
 *    "Charizard"           → name only
 */
function parseQuery(raw: string): {
  name?: string;
  number?: string;
  printedTotal?: string;
  setName?: string;
} {
  const q = raw.trim();

  // "number/total" — optionally preceded by a name, e.g. "Charizard 4/102".
  // The part after the slash is either a set size ("190") or a promo-set
  // code ("SVP", "SWSH", "SM").
  const slash = q.match(/^(.*?)[\s#]*([A-Za-z]{0,4}\d{1,3}[a-z]?)\s*\/\s*([A-Za-z0-9]{1,8})$/);
  if (slash) {
    const name = slash[1].trim();
    const after = slash[3];
    const digitsInAfter = after.replace(/\D/g, "");
    return {
      name: name || undefined,
      number: slash[2],
      printedTotal: digitsInAfter ? digitsInAfter : undefined,
      setName: digitsInAfter ? undefined : after, // "SVP" → search promo sets by name
    };
  }

  // "#101" — explicit number, any set
  const hash = q.match(/^#\s*([A-Za-z]{0,4}\d{1,3}[a-z]?)$/);
  if (hash) return { number: hash[1] };

  // Bare number (or promo codes like "TG12", "SWSH095") — nothing else it could be
  const bare = q.match(/^#?\s*([A-Za-z]{0,4}\d{1,3}[a-z]?)$/);
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
    // only the base set, not secret rares; promo-set codes vary) — relax
    // progressively.
    if (cards.length === 0 && (parsed.printedTotal || parsed.setName)) {
      cards = await searchCards({ name: parsed.name, number: parsed.number, pageSize: 16 });
    }
    if (cards.length === 0 && parsed.number && !parsed.name) {
      cards = await searchCards({ name: q, pageSize: 16 });
    }
    // XY-era Mega Evolutions are named "M Gengar-EX", not "Mega Gengar EX" —
    // retry "Mega X" queries with the old naming convention.
    if (cards.length === 0 && parsed.name && /^mega\s+/i.test(parsed.name)) {
      const oldStyle = parsed.name.replace(/^mega\s+/i, "M ").replace(/\s*ex$/i, "");
      cards = await searchCards({ name: oldStyle, number: parsed.number, pageSize: 16 });
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
