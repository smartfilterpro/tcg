import { NextResponse } from "next/server";
import { searchCards, numberKey, cleanCardName, numberVariants } from "@/lib/pokemontcg";
import { searchTcgdex } from "@/lib/tcgdex";
import { requireUser, AuthError } from "@/lib/auth";
import { parseCardQuery } from "@/lib/cardQuery";
import { normalizeForSearch } from "@/lib/text";
import type { CardSummary } from "@/lib/types";

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
    const wantedKey = parsed.number ? numberKey(parsed.number) : "";
    const hasWantedNumber = (list: CardSummary[]) =>
      !wantedKey || list.some((c) => numberKey(c.number) === wantedKey);

    // A single query shape can't cover how people type. A prefix match
    // misses "Surfing Pikachu" when you search "pikachu"; a contains match
    // is broad but the API may refuse a leading wildcard; token matching
    // gets past apostrophes and punctuation. Rather than keep guessing which
    // one the upstream matcher honours — the reason a full name returned
    // less than a partial one — run them together and merge, so a longer
    // query can never come back with fewer cards than a shorter one.
    let cards: CardSummary[] = [];
    if (parsed.name) {
      const shapes = await Promise.all([
        safeSearch({ ...parsed, pageSize: 60 }),
        safeSearch({
          nameContains: parsed.name,
          number: parsed.number,
          printedTotal: parsed.printedTotal,
          pageSize: 60,
        }),
        safeSearch({
          nameTokens: parsed.name,
          number: parsed.number,
          printedTotal: parsed.printedTotal,
          pageSize: 60,
        }),
      ]);
      const seen = new Set<string>();
      for (const shape of shapes) {
        for (const c of shape) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          cards.push(c);
        }
      }
      // Closest match first: the exact name, then names starting with what
      // was typed, then names merely containing it — newest printing first
      // within each band.
      const wanted = normalizeForSearch(cleanCardName(parsed.name));
      const rank = (c: CardSummary) => {
        const n = normalizeForSearch(c.name);
        if (n === wanted) return 0;
        if (n.startsWith(wanted)) return 1;
        if (n.includes(wanted)) return 2;
        return 3;
      };
      cards.sort(
        (a, b) => rank(a) - rank(b) || (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
      );
      cards = cards.slice(0, 40);
    } else {
      cards = await safeSearch({ ...parsed, pageSize: 16 });
    }

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

    // A single query shape can't cover how people type. A prefix match
    // misses "Surfing Pikachu" when you search "pikachu"; a contains match
    // is broad but the API may refuse a leading wildcard; token matching
    // handles apostrophes and punctuation. Rather than guess which one the
    // upstream matcher honours — the reason a full name kept returning less
    // than a partial one — run them together and merge. A longer query can
    // then never return fewer cards than a shorter one.
    if (parsed.name) {
      const shapes = await Promise.all([
        safeSearch({ name: parsed.name, number: parsed.number, pageSize: 60 }),
        safeSearch({ nameContains: parsed.name, number: parsed.number, pageSize: 60 }),
        safeSearch({ nameTokens: parsed.name, number: parsed.number, pageSize: 60 }),
      ]);
      const seen = new Set(cards.map((c) => c.id));
      for (const shape of shapes) {
        for (const c of shape) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          cards.push(c);
        }
      }
      // Closest match first: the exact name, then names starting with what
      // was typed, then everything else, newest printing first within each.
      const wanted = normalizeForSearch(cleanCardName(parsed.name));
      const rank = (c: (typeof cards)[number]) => {
        const n = normalizeForSearch(c.name);
        if (n === wanted) return 0;
        if (n.startsWith(wanted)) return 1;
        if (n.includes(wanted)) return 2;
        return 3;
      };
      cards.sort(
        (a, b) => rank(a) - rank(b) || (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
      );
      cards = cards.slice(0, 40);
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
        cards = [...altNumberMatches, ...cards].slice(0, 40);
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
