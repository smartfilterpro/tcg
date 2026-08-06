import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { patternPrintingFor } from "@/lib/cardPrinting";
import { defaultVariantFor, variantLabel, PATTERN_VARIANTS } from "@/lib/types";

// Moving ball-pattern copies onto the printing's own card.
//
// The same physical card can be in a collection two ways: as the plain card
// wearing a "Poké Ball pattern" finish, or as the printing's own catalogue
// row. Saving now prefers the row, so nothing NEW splits — but everything
// recorded before that has to be moved, or the same card sits in two places
// at two different values, and the one wearing a finish is valued as the
// plain card it isn't.
//
// Dry run by default. It moves somebody's collection, and a preview of what
// it would do costs nothing.

interface Move {
  itemId: string;
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

    const patterns = PATTERN_VARIANTS as readonly string[];
    const { data: items, error } = await fetchAllRows(() =>
      admin
        .from("collection_items")
        .select("id, user_id, card_id, variant, quantity, card:cards(id, name, number, set_name)")
        .in("variant", patterns)
        .order("id")
    );
    if (error) throw new Error(error.message);

    const rows = (items ?? []) as unknown as Array<{
      id: string;
      user_id: string;
      card_id: string;
      variant: string;
      quantity: number;
      card: { id: string; name: string; number: string; set_name: string | null } | null;
    }>;

    const moves: Move[] = [];
    const skipped: string[] = [];

    for (const item of rows) {
      if (!item.card) continue;
      const printing = await patternPrintingFor(
        admin,
        {
          id: item.card.id,
          name: item.card.name,
          number: item.card.number,
          setName: item.card.set_name,
        },
        variantLabel(item.variant)
      );
      if (!printing) {
        // No row for this printing — the finish is doing its job and the
        // copy stays exactly where it is.
        skipped.push(`${item.card.name} · ${variantLabel(item.variant)} — no catalogue row for it`);
        continue;
      }
      const toVariant = defaultVariantFor(
        { prices: printing.prices, rarity: printing.rarity, name: printing.name },
        null
      );

      // Does this member already own the printing in that finish? Then the
      // quantities merge rather than one row overwriting the other.
      const { data: existing } = await admin
        .from("collection_items")
        .select("id, quantity")
        .eq("user_id", item.user_id)
        .eq("card_id", printing.id)
        .eq("variant", toVariant)
        .maybeSingle();

      moves.push({
        itemId: item.id,
        card: `${item.card.name} #${item.card.number}`,
        from: variantLabel(item.variant),
        to: variantLabel(toVariant),
        toCard: printing.name,
        quantity: item.quantity,
        merged: !!existing,
      });

      if (dryRun) continue;

      if (existing) {
        await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + item.quantity })
          .eq("id", existing.id as string);
        await admin.from("collection_items").delete().eq("id", item.id);
      } else {
        await admin
          .from("collection_items")
          .update({ card_id: printing.id, variant: toVariant })
          .eq("id", item.id);
      }
    }

    return NextResponse.json({
      dryRun,
      considered: rows.length,
      moved: moves.length,
      moves: moves.slice(0, 100),
      skipped: skipped.slice(0, 50),
      skippedCount: skipped.length,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
