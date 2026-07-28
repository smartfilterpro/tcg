import { NextResponse } from "next/server";
import { searchCards, numberKey, cleanCardName, numberVariants } from "@/lib/pokemontcg";
import { searchTcgdex } from "@/lib/tcgdex";
import { requireUser, AuthError } from "@/lib/auth";
import { parseCardQuery } from "@/lib/cardQuery";

/** The primary API has been flaky — an error there must not kill the search,
 *  because the TCGdex fallback can still answer. */
async function safeSearch(
  opts: Parameters<typeof searchCards>[0]
): Promise<ReturnType<typeof searchCards> extends Promise<infer T> ? T : never> {
  try {
    return await searchCards(opts);
  } catch {
    return [];
  }
}

/** Live card search against pokemontcg.io — used by the "fix this card" picker. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q) return NextResponse.json({ cards: [] });

    const parsed = parseCardQuery(q);
    let cards = await safeSearch({ ...parsed, pageSize: 16 });

    const wantedKey = parsed.number ? numberKey(parsed.number) : "";
    const hasWantedNumber = (list: typeof cards) =>
      !wantedKey || list.some((c) => numberKey(c.number) === wantedKey);

    // The upstream API doesn't reliably honour a parenthesised OR of the
    // different ways a collector number can be spelled, so a card printed
    // "013/223" could miss while "13/223" hit. Retry each spelling on its
    // own before relaxing anything else.
    if (parsed.number && !hasWantedNumber(cards)) {
      for (const variant of numberVariants(parsed.number)) {
        const exact = await safeSearch({
          name: parsed.name,
          numberExact: variant,
          printedTotal: parsed.printedTotal,
          pageSize: 16,
        });
        if (hasWantedNumber(exact) && exact.length > 0) {
          cards = exact;
          break;
        }
      }
    }

    // Number-based searches can be over-constrained (e.g. printedTotal counts
    // only the base set, not secret rares; promo-set codes vary) — relax
    // progressively.
    if (cards.length === 0 && (parsed.printedTotal || parsed.setName)) {
      cards = await safeSearch({ name: parsed.name, number: parsed.number, pageSize: 16 });
    }
    if (cards.length === 0 && parsed.number && !parsed.name) {
      cards = await safeSearch({ name: q, pageSize: 16 });
    }
    // XY-era Mega Evolutions are named "M Gengar-EX", not "Mega Gengar EX" —
    // retry "Mega X" queries with the old naming convention.
    if (cards.length === 0 && parsed.name && /^mega\s+/i.test(parsed.name)) {
      const oldStyle = parsed.name.replace(/^mega\s+/i, "M ").replace(/\s*ex$/i, "");
      cards = await safeSearch({ name: oldStyle, number: parsed.number, pageSize: 16 });
    }
    // Punctuation-blind retry: match on word-parts only, so apostrophes,
    // periods, hyphens, and é can't block a match ("farfetchd" → Farfetch'd)
    if (cards.length === 0 && parsed.name) {
      cards = await safeSearch({
        nameTokens: parsed.name,
        number: parsed.number,
        pageSize: 16,
      });
      if (cards.length === 0 && parsed.number) {
        cards = await safeSearch({ nameTokens: parsed.name, pageSize: 16 });
      }
    }

    // A full name can match exactly and return ONLY the plainly-named
    // printings — which is why searching "Rayquaza" used to give fewer cards
    // than the truncated "Rayquaz" (that found nothing, so it fell through to
    // the broader token search). Widen whenever the result set is thin,
    // keeping the exact matches first.
    if (parsed.name && !parsed.number && cards.length > 0 && cards.length < 8) {
      const wider = await safeSearch({ nameTokens: parsed.name, pageSize: 16 });
      const seen = new Set(cards.map((c) => c.id));
      cards = [...cards, ...wider.filter((c) => !seen.has(c.id))].slice(0, 20);
    }

    // Consult TCGdex (usually has new sets/promos months earlier) when the
    // primary came up empty — or when it returned cards but NONE carry the
    // number that was searched for (typical promo case: a name search finds
    // old printings while the actual promo lives only in TCGdex).
    let source = "pokemontcg.io";
    const key = wantedKey;
    if (cards.length === 0 || !hasWantedNumber(cards)) {
      const alt = await searchTcgdex({
        name: parsed.name ? cleanCardName(parsed.name) : undefined,
        number: parsed.number,
        pageSize: 12,
      });
      const altNumberMatches = key ? alt.filter((c) => numberKey(c.number) === key) : alt;
      if (cards.length === 0) {
        cards = alt;
        if (alt.length > 0) source = "tcgdex";
      } else if (altNumberMatches.length > 0) {
        // Put the number-exact fallback results first, keep primary as alternatives
        cards = [...altNumberMatches, ...cards].slice(0, 20);
        source = "mixed";
      }
    }

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
