import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";

export const maxDuration = 300;

// Folding duplicate card rows: the same physical card held twice because two
// sources spelled it differently. The observed case: Perfect Order Gengar as
// "#050" from one database and "#50" from another — two rows, one card, and
// every view downstream (collection, set completion, the assistant's index)
// counts them separately.
//
// Duplicates are grouped by (name, zero-stripped collector number, set name).
// The survivor is the best-provenanced id: an unprefixed pokemontcg.io row
// over tcgdex- over tcgp- over custom-. Collection entries are repointed
// with quantity merges, and a duplicate row is deleted ONLY once nothing
// references it — collection_items.card_id cascades on delete, so deleting
// first would destroy people's collections.
//
// Dry run by default. This rewrites what people own; look before leaping.

const numKey = (n: string | null) => (n ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

function provenance(id: string): number {
  if (id.startsWith("custom-")) return 3;
  if (id.startsWith("tcgp-")) return 2;
  if (id.startsWith("tcgdex-")) return 1;
  return 0; // pokemontcg.io — richest data, canonical numbering
}

interface CardRow {
  id: string;
  name: string;
  number: string;
  set_name: string | null;
  market_price: number | null;
  prices: Record<string, number | null> | null;
  image_small: string | null;
  image_large: string | null;
  image_locked: boolean | null;
  tcgplayer_id: string | null;
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
    const dryRun = body.dryRun !== false;
    const admin = createAdminClient();

    const { data: cards, error } = await fetchAllRows<CardRow>(() =>
      admin
        .from("cards")
        .select(
          "id, name, number, set_name, market_price, prices, image_small, image_large, image_locked, tcgplayer_id"
        )
        .order("id")
    );
    if (error) throw new Error(error.message);

    const groups = new Map<string, CardRow[]>();
    for (const c of cards) {
      const key = `${c.name.toLowerCase()}|${numKey(c.number)}|${(c.set_name ?? "").toLowerCase()}`;
      const g = groups.get(key);
      if (g) g.push(c);
      else groups.set(key, [c]);
    }

    const dupGroups = [...groups.values()].filter((g) => g.length > 1);
    const sample = dupGroups.slice(0, 12).map((g) => ({
      name: g[0].name,
      set: g[0].set_name,
      rows: g.map((c) => `${c.id} (#${c.number})`),
    }));

    let merged = 0;
    let itemsMoved = 0;
    let kept = 0;
    const failures: string[] = [];

    if (!dryRun) {
      for (const group of dupGroups) {
        // Survivor: best provenance; ties broken toward the one with a
        // locked image (an admin curated it), then the one holding a price.
        const sorted = [...group].sort(
          (a, b) =>
            provenance(a.id) - provenance(b.id) ||
            Number(b.image_locked === true) - Number(a.image_locked === true) ||
            Number(b.market_price != null) - Number(a.market_price != null)
        );
        const survivor = sorted[0];
        kept++;

        for (const twin of sorted.slice(1)) {
          // Anything the twin knows that the survivor doesn't.
          const patch: Record<string, unknown> = {};
          if (!survivor.tcgplayer_id && twin.tcgplayer_id) patch.tcgplayer_id = twin.tcgplayer_id;
          if (survivor.market_price == null && twin.market_price != null) {
            patch.market_price = twin.market_price;
            patch.prices = twin.prices;
          }
          if (!survivor.image_small && !survivor.image_locked && twin.image_small) {
            patch.image_small = twin.image_small;
            patch.image_large = twin.image_large ?? twin.image_small;
            if (twin.image_locked) patch.image_locked = true;
          }
          if (Object.keys(patch).length > 0) {
            await admin.from("cards").update(patch).eq("id", survivor.id).then(() => {});
          }

          // Repoint ownership, merging quantities where someone owns both.
          const { data: items } = await admin
            .from("collection_items")
            .select("id, user_id, variant, quantity")
            .eq("card_id", twin.id);
          let stranded = 0;
          for (const item of items ?? []) {
            const { error: moveErr } = await admin
              .from("collection_items")
              .update({ card_id: survivor.id })
              .eq("id", item.id);
            if (!moveErr) {
              itemsMoved++;
              continue;
            }
            const { data: existing } = await admin
              .from("collection_items")
              .select("id, quantity")
              .eq("user_id", item.user_id)
              .eq("card_id", survivor.id)
              .eq("variant", item.variant)
              .maybeSingle();
            if (existing) {
              const { error: qtyErr } = await admin
                .from("collection_items")
                .update({ quantity: (existing.quantity as number) + (item.quantity as number) })
                .eq("id", existing.id);
              if (!qtyErr) {
                await admin.from("collection_items").delete().eq("id", item.id).then(() => {});
                itemsMoved++;
                continue;
              }
            }
            stranded++;
          }

          if (stranded === 0) {
            const { error: delErr } = await admin.from("cards").delete().eq("id", twin.id);
            if (delErr) failures.push(`${twin.id}: ${delErr.message}`);
            else merged++;
          } else {
            failures.push(`${twin.id}: ${stranded} collection entries could not be moved`);
          }
        }
      }
    }

    return NextResponse.json({
      dryRun,
      cards: cards.length,
      duplicateGroups: dupGroups.length,
      sample,
      merged,
      itemsMoved,
      kept,
      failures: failures.slice(0, 10),
      note: dryRun
        ? "Nothing written. POST {\"dryRun\": false} to fold these."
        : "Done. Collections were repointed before any row was removed.",
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dedupe failed" },
      { status: 500 }
    );
  }
}
