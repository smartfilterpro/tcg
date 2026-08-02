import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { sealedKindLabel, type SealedSuggestion } from "@/lib/sealed";

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

    const push = (s: SealedSuggestion) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(s);
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

    // 2. Built from real set names.
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

    return NextResponse.json({ suggestions: out.slice(0, 60) });
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
