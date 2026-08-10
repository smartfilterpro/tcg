import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { PublicError, errorJson } from "@/lib/apiError";

/** POST: move copies of a card from one household member to another.
 *
 *  Cards move around a real household all the time — a duplicate goes to the
 *  little one, a deck staple comes back to whoever is building with it. Doing
 *  that in the app used to mean deleting it from one collection and searching
 *  it back into another, which loses the notes, the finish and the custom
 *  value, and gives a nine-year-old no record that the card was ever theirs.
 *
 *  Who may move what: your own cards, always. A parent may move anyone's in
 *  the group — the same authority they already hold over caps, the trade
 *  board and membership itself. A kid cannot reach into a sibling's shelf.
 *
 *  Service role throughout, deliberately. The write policies on
 *  collection_items are user_id = auth.uid(), which is right for every other
 *  path and makes this one impossible: a transfer must write a row the caller
 *  does not own. So the permission check here IS the boundary, and it runs
 *  before anything is touched.
 *
 *  Body: { itemId, toUserId, quantity }
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json()) as {
      itemId?: string;
      toUserId?: string;
      quantity?: number;
    };
    const itemId = (body.itemId ?? "").trim();
    const toUserId = (body.toUserId ?? "").trim();
    const quantity = Math.floor(Number(body.quantity ?? 0));
    if (!itemId || !toUserId || !Number.isFinite(quantity) || quantity < 1) {
      throw new PublicError("Pick a card, a person and how many.", 400);
    }

    const admin = createAdminClient();

    const { data: item } = await admin
      .from("collection_items")
      .select("id, user_id, card_id, variant, quantity, notes, price_override")
      .eq("id", itemId)
      .maybeSingle();
    if (!item) throw new PublicError("That card is no longer there.", 404);
    if (item.user_id === toUserId) throw new PublicError("That's already their card.", 400);
    if (quantity > (item.quantity as number)) {
      throw new PublicError(`Only ${item.quantity} to move.`, 400);
    }

    // Everyone involved must be in one group: the mover, the owner and the
    // recipient. Read in a single query so a half-answer can't authorise a
    // move — three separate lookups is three chances to get two of them.
    const { data: rows } = await admin
      .from("family_members")
      .select("user_id, group_id, role")
      .in("user_id", [user.id, item.user_id as string, toUserId]);

    const me = (rows ?? []).find((r) => r.user_id === user.id);
    const owner = (rows ?? []).find((r) => r.user_id === item.user_id);
    const to = (rows ?? []).find((r) => r.user_id === toUserId);
    const oneHouse =
      me && owner && to && me.group_id === owner.group_id && me.group_id === to.group_id;
    if (!oneHouse) throw new PublicError("That isn't your family.", 403);

    const mayMove = item.user_id === user.id || me.role === "parent";
    if (!mayMove) throw new PublicError("Only a parent can move someone else's cards.", 403);

    // Land it on the recipient first. If this fails nothing has been taken,
    // which is the safe way round: the alternative loses cards.
    const { data: theirs } = await admin
      .from("collection_items")
      .select("id, quantity")
      .eq("user_id", toUserId)
      .eq("card_id", item.card_id as string)
      .eq("variant", (item.variant as string) ?? "normal")
      .maybeSingle();

    if (theirs) {
      const { error } = await admin
        .from("collection_items")
        .update({
          quantity: (theirs.quantity as number) + quantity,
          updated_at: new Date().toISOString(),
        })
        .eq("id", theirs.id);
      if (error) throw error;
    } else {
      // The notes and the custom value travel with the card. "Grandma's, PSA
      // 9" is about the object, not about who is holding it.
      const { error } = await admin.from("collection_items").insert({
        user_id: toUserId,
        card_id: item.card_id,
        variant: (item.variant as string) ?? "normal",
        quantity,
        notes: item.notes,
        price_override: item.price_override,
      });
      if (error) throw error;
    }

    const left = (item.quantity as number) - quantity;
    const { error: takeErr } =
      left > 0
        ? await admin
            .from("collection_items")
            .update({ quantity: left, updated_at: new Date().toISOString() })
            .eq("id", itemId)
        : await admin.from("collection_items").delete().eq("id", itemId);
    if (takeErr) throw takeErr;

    return NextResponse.json({ ok: true, moved: quantity, left });
  } catch (err) {
    return errorJson(err, "Couldn't move that card.");
  }
}
