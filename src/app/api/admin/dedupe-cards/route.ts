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
// The admin picks WHICH groups to fold. Grouping is a heuristic on
// name+number+set, and heuristics are wrong occasionally — two genuinely
// different printings can share all three (a promo reprint carrying its
// original number, say). So the dry run returns every group with each row's
// artwork, and the merge only touches the keys it is handed: a wrong-looking
// pair gets unticked instead of blocking the other seventy.

// Normalisation, matching the price sync's. Both sides matter here:
//
//   "95/84"            a TCGplayer collector number with the set size on it.
//                      Stripping non-digits alone made this 9584, which
//                      matched no pokemontcg.io row, so the twins this tool
//                      exists to fold were invisible to it.
//   "Silvally - 95/84" the number repeated inside a shop product name.
//
// Both are no-ops on values that were already plain.
const numKey = (n: string | null) =>
  (n ?? "").split("/")[0].replace(/\D/g, "").replace(/^0+(?=\d)/, "");
const nameKey = (n: string | null) =>
  (n ?? "")
    .replace(/\s*[-–—]\s*#?\d+\s*(?:\/\s*\w+)?\s*$/, "")
    .trim()
    .toLowerCase();
/** Set names come from two vendors and disagree cosmetically — "SV: Paldea
 *  Evolved" against "Paldea Evolved", "Pokémon" against "Pokemon". Reduced
 *  to letters and digits so those stop splitting a genuine pair, while
 *  still keeping genuinely different sets apart. */
const setKey = (s: string | null) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(?:sv|swsh|sm|xy|bw|hgss|dp|ex)\s*[:-]\s*/, "")
    .replace(/[^a-z0-9]/g, "");

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

/** Stable identity for a group, so the UI can hand specific ones back. */
const keyOf = (c: CardRow) =>
  `${nameKey(c.name)}|${numKey(c.number)}|${setKey(c.set_name)}`;

/** Best-provenanced first: the survivor is [0], the twins are the rest. */
function ordered(group: CardRow[]): CardRow[] {
  return [...group].sort(
    (a, b) =>
      provenance(a.id) - provenance(b.id) ||
      Number(b.image_locked === true) - Number(a.image_locked === true) ||
      Number(b.market_price != null) - Number(a.market_price != null)
  );
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; keys?: string[] };
    const dryRun = body.dryRun !== false;
    const wanted = Array.isArray(body.keys) ? new Set(body.keys) : null;
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
      const key = keyOf(c);
      const g = groups.get(key);
      if (g) g.push(c);
      else groups.set(key, [c]);
    }

    const dupEntries = [...groups.entries()].filter(([, g]) => g.length > 1);

    // How many collection entries hang off each duplicate row — the number
    // that says whether a merge moves someone's cards or merely tidies the
    // catalogue. One query per chunk, counted in memory.
    const dupIds = dupEntries.flatMap(([, g]) => g.map((c) => c.id));
    const owned = new Map<string, number>();
    for (let i = 0; i < dupIds.length; i += 300) {
      const { data: items } = await admin
        .from("collection_items")
        .select("card_id, quantity")
        .in("card_id", dupIds.slice(i, i + 300));
      for (const it of items ?? []) {
        owned.set(
          it.card_id as string,
          (owned.get(it.card_id as string) ?? 0) + ((it.quantity as number) ?? 0)
        );
      }
    }

    // Every group, with pictures — the admin decides by eye, so the payload
    // carries what the eye needs.
    const detail = dupEntries.slice(0, 300).map(([key, g]) => {
      const rows = ordered(g);
      return {
        key,
        name: rows[0].name,
        set: rows[0].set_name,
        rows: rows.map((c, i) => ({
          id: c.id,
          number: c.number,
          image: c.image_small,
          price: c.market_price,
          locked: c.image_locked === true,
          owned: owned.get(c.id) ?? 0,
          survivor: i === 0,
        })),
      };
    });

    let merged = 0;
    let itemsMoved = 0;
    let kept = 0;
    const failures: string[] = [];

    if (!dryRun) {
      // No keys given means every group — the old behaviour, kept so a
      // scripted call still works. The UI always sends its ticked list.
      const toMerge = wanted ? dupEntries.filter(([key]) => wanted.has(key)) : dupEntries;
      for (const [, group] of toMerge) {
        const sorted = ordered(group);
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
      duplicateGroups: dupEntries.length,
      groups: detail,
      truncated: Math.max(0, dupEntries.length - detail.length),
      merged,
      itemsMoved,
      kept,
      failures: failures.slice(0, 10),
      note: dryRun
        ? "Nothing written. Untick anything that isn't the same card, then merge."
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
