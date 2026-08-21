// Recording a card's TCGplayer id without letting it break anything else.
//
// The id is a nice-to-have: it is the join key for the bulk datasets the
// paid source publishes, and it arrives free on lookups we make anyway. The
// price and the picture are the point.
//
// It also carries a unique index (migration 033), which is correct — two
// cards cannot be the same TCGplayer product — but it means writing it can
// FAIL, and it fails precisely when the catalogue holds a duplicate: some
// other row already claims that id. Bundled into the same UPDATE as the
// price, one rejected bonus field discards the whole statement, so a card
// silently keeps no price because of a constraint that has nothing to do
// with prices. That is what "Found a price of $4.18 but it didn't save"
// was.
//
// So it is written on its own, after the write that matters. And a
// collision is no longer just swallowed: in practice the holder is almost
// always a "tcgp-…" twin this same sync minted before the canonical row
// existed — the import's page-time merge never caught them because its
// exact-name prefilter can't see TCGplayer-style names — so every sync pass
// re-warned about the same few hundred rows forever, and the canonical card
// never took its id. When the holder is PROVABLY the same card (same
// normalized name, same number with letters kept, agreeing set), it is
// folded here: its data gap-fills the survivor, what people own is
// repointed, the merge is recorded, and the id moves. Anything not provable
// stays a warning — a wrong fold deletes somebody's card, a duplicate row
// just costs storage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { setsAgree } from "@/lib/setName";
import { normalizeForSearch } from "@/lib/text";
import { mergePrices } from "@/lib/cardWrite";

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

export interface AttachResult {
  saved: boolean;
  /** The id already belongs to another card — a duplicate, worth surfacing
   *  rather than swallowing silently. */
  conflict: boolean;
}

/** Same keys the import merge and the dedupe tool use, for the same
 *  reasons: TCGplayer writes "Pikachu - 58/102", letters on a collector
 *  number are identity ("112a" is not card 112), and the set has to agree
 *  because reprints keep the original's number. */
const numKey = (n: string | null | undefined) =>
  (n ?? "")
    .split("/")[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^0-9])0+(?=\d)/g, "$1");
const twinNameKey = (n: string | null | undefined) =>
  normalizeForSearch((n ?? "").replace(/\s*[-–—]\s*#?\d+\s*(?:\/\s*\w+)?\s*$/, ""));

/** Fold the twin row holding `tcgPlayerId` into `survivorId`, when and only
 *  when they are provably the same card. Returns true when the id is free
 *  to attach afterwards. */
async function foldTwinHoldingId(
  admin: SupabaseClient,
  survivorId: string,
  tcgPlayerId: string
): Promise<boolean> {
  try {
    // Only ever fold INTO a canonical row — an automatic merge must never
    // pick a sync-minted row as the survivor.
    if (survivorId.startsWith("tcgp-")) return false;
    const { data: twin } = await admin
      .from("cards")
      // The whole row: it may be deleted below, and a deletion with no
      // record of what was deleted cannot be undone.
      .select("*")
      .eq("tcgplayer_id", tcgPlayerId)
      .maybeSingle();
    if (!twin) return false;
    const twinId = twin.id as string;
    if (twinId === survivorId) return true; // already ours; the retry no-ops
    // Only secondary-scheme rows are folded automatically. Two CANONICAL
    // rows claiming one product is a data question for the dedupe tool.
    if (!twinId.startsWith("tcgp-") && !twinId.startsWith("tcgdex-")) return false;

    const { data: survivor } = await admin
      .from("cards")
      .select("*")
      .eq("id", survivorId)
      .maybeSingle();
    if (!survivor) return false;

    // Identity, all three legs. Note the name comparison keeps parenthetical
    // printing qualifiers — a "(Poké Ball Pattern)" row is a DIFFERENT
    // product and must never fold into the plain card.
    if (twinNameKey(twin.name as string) !== normalizeForSearch((survivor.name as string) ?? ""))
      return false;
    if (numKey(twin.number as string) !== numKey(survivor.number as string)) return false;
    if (!setsAgree(twin.set_name as string | null, survivor.set_name as string | null))
      return false;

    // 1. Anything the twin knows that the survivor doesn't.
    const patch: Record<string, unknown> = {};
    if (survivor.market_price == null && twin.market_price != null) {
      patch.market_price = twin.market_price;
    }
    const mergedPrices = mergePrices(survivor.prices, twin.prices);
    if (mergedPrices) patch.prices = mergedPrices;
    if (!survivor.image_small && !survivor.image_locked && twin.image_small) {
      patch.image_small = twin.image_small;
      patch.image_large = twin.image_large ?? twin.image_small;
    }
    if ("graded_prices" in twin && survivor.graded_prices == null && twin.graded_prices != null) {
      patch.graded_prices = twin.graded_prices;
    }
    if ("poketrace_id" in twin && !survivor.poketrace_id && twin.poketrace_id) {
      patch.poketrace_id = twin.poketrace_id;
    }
    if (Object.keys(patch).length > 0) {
      await admin.from("cards").update(patch).eq("id", survivorId).then(() => {});
    }

    // The id is released FIRST. Even if a stranded collection row blocks the
    // delete below, the survivor still takes ownership — which is the whole
    // point — and the id-less twin waits for the dedupe tool.
    const { error: releaseErr } = await admin
      .from("cards")
      .update({ tcgplayer_id: null })
      .eq("id", twinId);
    if (releaseErr) return false;

    // 2. Repoint what people own. Row by row: a (user, card, variant)
    // conflict means they own both twins and the quantities must merge.
    const { data: items } = await admin
      .from("collection_items")
      .select("id, user_id, variant, quantity")
      .eq("card_id", twinId);
    let stranded = 0;
    const moved: Array<Record<string, unknown>> = [];
    for (const item of items ?? []) {
      const { error: moveErr } = await admin
        .from("collection_items")
        .update({ card_id: survivorId })
        .eq("id", item.id);
      if (!moveErr) {
        moved.push({ ...item, how: "repointed" });
        continue;
      }
      const { data: existing } = await admin
        .from("collection_items")
        .select("id, quantity")
        .eq("user_id", item.user_id)
        .eq("card_id", survivorId)
        .eq("variant", item.variant)
        .maybeSingle();
      if (existing) {
        const { error: qtyErr } = await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + (item.quantity as number) })
          .eq("id", existing.id);
        if (!qtyErr) {
          moved.push({ ...item, how: "folded", intoId: existing.id });
          await admin.from("collection_items").delete().eq("id", item.id).then(() => {});
          continue;
        }
      }
      stranded += 1;
    }

    // 3. The twin goes only when nothing points at it (card_id cascades on
    // delete), and it goes on the record either way — this path runs
    // automatically with nobody watching, which is exactly the merge that
    // most needs an undo trail (card_merges, migration 047).
    await admin
      .from("card_merges")
      .insert({
        source: "price-sync",
        survivor_id: survivorId,
        twin_id: twinId,
        twin,
        items: moved,
      })
      .then(() => {});
    if (stranded === 0) {
      await admin.from("cards").delete().eq("id", twinId).then(() => {});
    }
    console.log(
      `price sync: folded twin ${twinId} into ${survivorId} (tcgplayer ${tcgPlayerId}` +
        `${stranded > 0 ? `, ${stranded} item(s) stranded — twin kept id-less` : ""})`
    );
    return true;
  } catch {
    return false; // a failed fold is the old behaviour: warn and move on
  }
}

export async function attachTcgPlayerId(
  admin: SupabaseClient,
  cardId: string,
  tcgPlayerId: string | null | undefined
): Promise<AttachResult> {
  if (!tcgPlayerId) return { saved: false, conflict: false };
  const { error } = await admin
    .from("cards")
    .update({ tcgplayer_id: tcgPlayerId })
    .eq("id", cardId);
  if (!error) return { saved: true, conflict: false };
  if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
    if (await foldTwinHoldingId(admin, cardId, String(tcgPlayerId))) {
      const { error: retryErr } = await admin
        .from("cards")
        .update({ tcgplayer_id: tcgPlayerId })
        .eq("id", cardId);
      if (!retryErr) return { saved: true, conflict: false };
    }
    console.warn(
      `tcgplayer id ${tcgPlayerId} already belongs to another card — ${cardId} has a duplicate.`
    );
    return { saved: false, conflict: true };
  }
  // Anything else is unexpected, but still not worth failing the caller's
  // real work over.
  console.warn(`couldn't record tcgplayer id for ${cardId}: ${error.message}`);
  return { saved: false, conflict: false };
}
