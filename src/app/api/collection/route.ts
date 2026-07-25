import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { summaryToRow, type CardSummary, type CollectionItem } from "@/lib/types";

/** GET: the current user's full collection (cards joined). Filtering happens client-side. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("collection_items")
      .select("*, card:cards(*)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    return NextResponse.json({ items: (data ?? []) as unknown as CollectionItem[] });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: bulk-add cards (from the scan review screen).
 *  Body: { items: [{ card: CardSummary, quantity: number }] }
 *  Upserts the shared card cache, then increments quantities. */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const body = (await req.json()) as {
      items?: Array<{ card: CardSummary; quantity: number }>;
    };
    const items = (body.items ?? []).filter(
      (i) => i?.card?.id && Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= 999
    );
    if (items.length === 0) {
      return NextResponse.json({ error: "No valid items" }, { status: 400 });
    }

    // 1) Upsert card reference rows (shared cache)
    const cardRows = items.map((i) => summaryToRow(i.card));
    const { error: cardErr } = await supabase
      .from("cards")
      .upsert(cardRows, { onConflict: "id" });
    if (cardErr) throw cardErr;

    // 2) Merge quantities per card id (same card may appear twice in one scan)
    const wanted = new Map<string, number>();
    for (const i of items) {
      wanted.set(i.card.id, (wanted.get(i.card.id) ?? 0) + i.quantity);
    }

    // 3) Increment existing rows or insert new ones
    const cardIds = [...wanted.keys()];
    const { data: existing, error: exErr } = await supabase
      .from("collection_items")
      .select("id, card_id, quantity")
      .eq("user_id", user.id)
      .in("card_id", cardIds);
    if (exErr) throw exErr;

    const existingByCard = new Map((existing ?? []).map((r) => [r.card_id as string, r]));
    let added = 0;
    for (const [cardId, qty] of wanted) {
      const row = existingByCard.get(cardId);
      if (row) {
        const { error } = await supabase
          .from("collection_items")
          .update({ quantity: (row.quantity as number) + qty, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("collection_items")
          .insert({ user_id: user.id, card_id: cardId, quantity: qty });
        if (error) throw error;
      }
      added += qty;
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("collection error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
