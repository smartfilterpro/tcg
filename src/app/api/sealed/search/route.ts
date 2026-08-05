import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { sealedKindLabel, type SealedSuggestion } from "@/lib/sealed";
import { searchTrackerSealed } from "@/lib/sealedTracker";

export const maxDuration = 30;

// Suggesting sealed products to add.
//
// Free-text entry is how a catalogue fills with "Surging Sparks Booster Box",
// "surging sparks booster box" and "Surging Sparks BB" as three separate
// products — the same duplicate problem the card catalogue has been paying
// for all week, invited in at the front door. Suggestions are the fix: pick
// an existing name and there is nothing to misspell.
//
// Two sources, no new dependency:
//
//   1. sealed_products — what anyone has already added. Always first, since
//      matching an existing row is what keeps the catalogue from splitting.
//   2. Real set names from our own cards table, crossed with the product
//      types that actually exist. Sealed product is named formulaically —
//      "<Set> Booster Box", "<Set> Elite Trainer Box" — so a correct,
//      canonically-spelled suggestion can be built rather than fetched.
//
// Free text still works for anything unusual: Japanese product, old boxes,
// promo tins. The suggestion list is a shortcut, never a gate.

/** Read the product type out of a real product name.
 *
 *  Their catalogue names the product but does not categorise it, and the
 *  kind is what the collection list shows under each row. Longest phrases
 *  first, so "Elite Trainer Box" is not read as "Box", and "other" when
 *  nothing matches rather than a guess. */
function kindFromName(name: string): string {
  const n = name.toLowerCase();
  if (/elite trainer box|\betb\b/.test(n)) return "etb";
  if (/booster bundle/.test(n)) return "booster_bundle";
  if (/booster box|display box/.test(n)) return "booster_box";
  if (/booster pack|single pack/.test(n)) return "booster_pack";
  if (/collection box|premium collection|special collection/.test(n)) return "collection_box";
  if (/\btin\b/.test(n)) return "tin";
  if (/blister|three pack|3-pack/.test(n)) return "blister";
  return "other";
}

/** The product types worth offering for every set. Deliberately short — a
 *  list of twelve per set is noise, and these four are what people hold. */
const COMMON_KINDS: Array<{ kind: string; suffix: string }> = [
  { kind: "booster_box", suffix: "Booster Box" },
  { kind: "etb", suffix: "Elite Trainer Box" },
  { kind: "booster_bundle", suffix: "Booster Bundle" },
  { kind: "booster_pack", suffix: "Booster Pack" },
];

export async function GET(req: Request) {
  try {
    await requireUser();
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    const supabase = await createClient();
    const out: SealedSuggestion[] = [];
    const seen = new Set<string>();

    const byKey = new Map<string, SealedSuggestion>();
    /** First one wins its PLACE in the list; later ones fill its gaps.
     *
     *  It used to be first-wins-outright, and that quietly threw away the
     *  best part of the paid catalogue. A product already in your collection
     *  is pushed first (correctly — matching an existing row is what stops
     *  the catalogue splitting), and if that row has no picture then the
     *  official product shot arriving thirty lines later was dropped on the
     *  floor because the name was already taken. Which is why a search for
     *  products you own showed four cardboard-box icons. */
    const push = (s: SealedSuggestion) => {
      const key = s.name.toLowerCase();
      const existing = byKey.get(key);
      if (!existing) {
        seen.add(key);
        byKey.set(key, s);
        out.push(s);
        return;
      }
      existing.image ??= s.image ?? null;
      existing.marketPrice ??= s.marketPrice ?? null;
      existing.setName ??= s.setName ?? null;
      existing.year ??= s.year ?? null;
      existing.tcgPlayerId ??= s.tcgPlayerId;
    };

    // 1. Products already in the catalogue.
    {
      let query = supabase
        .from("sealed_products")
        .select("name, kind, set_name, release_year, market_price, image_url")
        .limit(12);
      if (q) query = query.ilike("name", `%${q}%`);
      const { data, error } = await query;
      // A missing table just means nothing to suggest from here yet; the
      // set-derived half below still works, so this is not fatal.
      if (!error) {
        for (const p of data ?? []) {
          push({
            name: p.name as string,
            kind: (p.kind as string) ?? "other",
            kindLabel: sealedKindLabel((p.kind as string) ?? "other"),
            setName: (p.set_name as string | null) ?? null,
            year: (p.release_year as number | null) ?? null,
            source: "catalogue",
            marketPrice: (p.market_price as number | null) ?? null,
            image: (p.image_url as string | null) ?? null,
          });
        }
      }
    }

    // 2. The paid sealed catalogue — real products, with real names, real
    // prices and official product shots.
    //
    // This is what the generated suggestions below were standing in for.
    // Those are guesses: "<Set> Booster Bundle" is offered for every set,
    // including the ones that never had a bundle, and picking one creates a
    // product that can never be priced because it does not exist. These are
    // things that demonstrably exist, because a catalogue is naming them.
    //
    // Costs credits per search, so it is gated on a real query rather than
    // firing on an empty box, and results are cached upstream for an hour.
    let notice: string | null = null;
    if (q.length >= 3) {
      const paid = await searchTrackerSealed(q);
      // Say it on the screen when the product database declined, rather than
      // letting an empty answer read as "no such product". Only when it
      // found NOTHING — a short list that still has the box in it needs no
      // explanation.
      if (paid.products.length === 0 && !paid.log.startsWith("0 product")) {
        notice = paid.log.includes("budget")
          ? "The product database is out of credits for today, so this list is only what's already in the catalogue. New product will appear when the allowance resets."
          : `Only showing what's already in the catalogue — ${paid.log}.`;
      }
      for (const p of paid.products) {
        push({
          name: p.name,
          kind: kindFromName(p.name),
          kindLabel: sealedKindLabel(kindFromName(p.name)),
          setName: p.setName,
          year: null,
          source: "tracker",
          marketPrice: p.price,
          image: p.image,
          tcgPlayerId: p.tcgPlayerId,
        });
      }
    }

    // 3. Built from real set names.
    //
    // Kept as a fallback beneath the real catalogue rather than deleted:
    // it costs nothing, it answers instantly while the paid search is in
    // flight, and it covers an empty query box, which the paid search
    // cannot be asked about.
    //
    // Matched on the SET, not on the whole product name: someone typing
    // "surging" wants Surging Sparks products, and requiring their words to
    // match "Surging Sparks Booster Box" in order would work only once they
    // had typed most of it. The suffix is added after matching, never
    // searched against.
    {
      let query = supabase
        .from("cards")
        .select("set_name, release_date")
        .not("set_name", "is", null)
        .limit(900);
      if (q) query = query.ilike("set_name", `%${q}%`);
      else query = query.order("release_date", { ascending: false });
      const { data } = await query;

      const sets = new Map<string, string | null>();
      for (const row of data ?? []) {
        const name = row.set_name as string | null;
        if (!name) continue;
        if (!sets.has(name)) sets.set(name, (row.release_date as string | null) ?? null);
      }
      // Newest sets first: the boxes people are buying right now are the
      // ones just released, and an alphabetical list buries them.
      const ordered = [...sets.entries()].sort((a, b) =>
        (b[1] ?? "").localeCompare(a[1] ?? "")
      );

      for (const [setName, released] of ordered.slice(0, 14)) {
        const year = Number((released ?? "").slice(0, 4));
        for (const { kind, suffix } of COMMON_KINDS) {
          push({
            name: `${setName} ${suffix}`,
            kind,
            kindLabel: sealedKindLabel(kind),
            setName,
            year: Number.isFinite(year) && year > 1995 ? year : null,
            source: "suggested",
          });
        }
        if (out.length > 60) break;
      }
    }

    return NextResponse.json({
      suggestions: out.slice(0, 60),
      ...(notice ? { notice } : {}),
    });
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
