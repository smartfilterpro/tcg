import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { normalizeForSearch } from "@/lib/text";
import { strictNumberKey } from "@/lib/pokemontcg";
import { setsAgree } from "@/lib/setName";
import { errorJson } from "@/lib/apiError";

// One physical printing, two catalogue rows.
//
// Three databases feed the catalogue and they disagree about leading
// zeros: the same Wailmer is "15" in one source's row and "015" in
// another's. Scanning picks one row deterministically NOW (soleCard), but
// copies saved at different times landed on different rows — so the same
// card sits twice in a collection, one half priced and the other not.
//
// This moves collection copies from duplicate rows onto the best row for
// that printing. Identity is judged the way the rest of the app judges
// it: same normalized name, same strict number key (letters kept — a
// TG12 is not a 12), and set names that AGREE per setName.ts — so a
// Trick or Trade reprint, which shares name and number with the card it
// reprints but not the set, never merges. Fail-safe is always "leave it
// split": a visible duplicate beats a lost card.
//
// Dry run by default, same stance as pattern-consolidate.

interface CardRow {
  id: string;
  name: string;
  number: string;
  set_name: string | null;
  market_price: number | null;
  image_small: string | null;
}

interface Move {
  card: string;
  from: string;
  to: string;
  toCard: string;
  quantity: number;
  merged: boolean;
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
    const dryRun = body.dryRun !== false;
    const admin = createAdminClient();

    const { data: items, error } = await fetchAllRows(() =>
      admin
        .from("collection_items")
        .select(
          "id, user_id, card_id, variant, quantity, card:cards(id, name, number, set_name, market_price, image_small)"
        )
        .order("id")
    );
    if (error) throw new Error(error.message);
    const rows = (items ?? []) as unknown as Array<{
      id: string;
      user_id: string;
      card_id: string;
      variant: string;
      quantity: number;
      card: CardRow | null;
    }>;

    // The distinct cards collections actually reference — the only rows
    // whose duplication anyone can see.
    const cards = new Map<string, CardRow>();
    for (const it of rows) if (it.card) cards.set(it.card.id, it.card);

    // Bucket by game + name + strict number; sets are judged pairwise
    // inside each bucket because sources NAME the same set differently
    // (setKey equality would miss "Pitch Black" vs "SV: Pitch Black").
    const buckets = new Map<string, CardRow[]>();
    for (const c of cards.values()) {
      const nameKey = normalizeForSearch(c.name);
      const numKey = strictNumberKey(c.number);
      if (!nameKey || !numKey) continue;
      const key = `${c.id.startsWith("scry-") ? "m" : "p"}|${nameKey}|${numKey}`;
      const list = buckets.get(key);
      if (list) list.push(c);
      else buckets.set(key, [c]);
    }

    const schemeRank = (id: string) =>
      id.startsWith("tcgp-") ? 2 : id.startsWith("tcgdex-") ? 1 : 0;
    // The winner is the row that can actually serve the collection:
    // priced first, pictured second, canonical id scheme as the tiebreak.
    const score = (c: CardRow) =>
      (c.market_price != null ? 0 : 4) + (c.image_small ? 0 : 2) + schemeRank(c.id) * 0.1;

    const winnerOf = new Map<string, CardRow>(); // losing card id → winning row
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      // Cluster by set agreement — tiny buckets, pairwise union-find.
      const parent = bucket.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          if (setsAgree(bucket[i].set_name, bucket[j].set_name)) {
            parent[find(i)] = find(j);
          }
        }
      }
      const clusters = new Map<number, CardRow[]>();
      for (let i = 0; i < bucket.length; i++) {
        const r = find(i);
        const list = clusters.get(r);
        if (list) list.push(bucket[i]);
        else clusters.set(r, [bucket[i]]);
      }
      for (const cluster of clusters.values()) {
        if (cluster.length < 2) continue;
        const sorted = [...cluster].sort(
          (a, b) => score(a) - score(b) || a.id.localeCompare(b.id)
        );
        const winner = sorted[0];
        for (const loser of sorted.slice(1)) winnerOf.set(loser.id, winner);
      }
    }

    const moves: Move[] = [];
    for (const it of rows) {
      if (!it.card) continue;
      const to = winnerOf.get(it.card.id);
      if (!to) continue;
      const { data: existing } = await admin
        .from("collection_items")
        .select("id, quantity")
        .eq("user_id", it.user_id)
        .eq("card_id", to.id)
        .eq("variant", it.variant)
        .maybeSingle();

      moves.push({
        card: `${it.card.name} #${it.card.number} (${it.card.id})`,
        from: it.variant,
        to: to.id,
        toCard: `${to.name} #${to.number}`,
        quantity: it.quantity,
        merged: !!existing,
      });
      if (dryRun) continue;

      if (existing) {
        await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + it.quantity })
          .eq("id", existing.id as string);
        await admin.from("collection_items").delete().eq("id", it.id);
      } else {
        await admin.from("collection_items").update({ card_id: to.id }).eq("id", it.id);
      }
    }

    return NextResponse.json({
      dryRun,
      considered: rows.length,
      duplicateRows: winnerOf.size,
      moved: moves.length,
      moves: moves.slice(0, 100),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Failed");
  }
}
