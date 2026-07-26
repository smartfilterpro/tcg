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

/** POST: bulk-add cards (from scan review or manual add).
 *  Body: { items: [{ card: CardSummary, quantity: number, variant?: string }] }
 *  Upserts the shared card cache, then increments quantities per (card, finish). */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const body = (await req.json()) as {
      items?: Array<{ card: CardSummary; quantity: number; variant?: string }>;
    };
    const items = (body.items ?? []).filter(
      (i) =>
        i?.card?.id &&
        Number.isInteger(i.quantity) &&
        i.quantity > 0 &&
        i.quantity <= 999 &&
        (i.variant === undefined || (typeof i.variant === "string" && i.variant.length <= 40))
    );
    if (items.length === 0) {
      return NextResponse.json({ error: "No valid items" }, { status: 400 });
    }

    // 1) Upsert card reference rows (shared cache). Dedupe by card id first —
    // the same card can appear multiple times in one save (two copies in one
    // photo, or two finishes of the same card), and Postgres rejects an upsert
    // that touches the same row twice.
    const cardRows = [
      ...new Map(items.map((i) => [i.card.id, summaryToRow(i.card)])).values(),
    ];

    // Never let a data-less save clobber shared enrichments: if the incoming
    // row has no image/price (typical for promos the card databases lack) but
    // the shared record already has one (a user photo, a found image, cached
    // prices), keep the existing values. Admin-locked images are never
    // replaced by anything.
    const { data: existingCards } = await supabase
      .from("cards")
      .select("id, image_small, image_large, image_locked, market_price, prices")
      .in("id", cardRows.map((r) => r.id));
    const existingById = new Map((existingCards ?? []).map((c) => [c.id as string, c]));
    const storagePrefix = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/card-photos/`;
    const candidateRows: Array<{ card_id: string; url: string; uploaded_by: string }> = [];
    for (const row of cardRows) {
      // A user-attached photo (our storage bucket) is always kept as a
      // candidate for admin review, whatever ends up displayed.
      if (row.image_small?.startsWith(storagePrefix)) {
        candidateRows.push({ card_id: row.id, url: row.image_small, uploaded_by: user.id });
      }
      const existing = existingById.get(row.id);
      if (!existing) continue;
      if (existing.image_locked || (!row.image_small && existing.image_small)) {
        row.image_small = existing.image_small;
        row.image_large = existing.image_large ?? existing.image_small;
      }
      if (row.market_price == null && existing.market_price != null) {
        row.market_price = existing.market_price;
      }
      if (!row.prices && existing.prices) {
        row.prices = existing.prices as typeof row.prices;
      }
    }

    // image_locked is not part of the upsert payload, so it's preserved.
    const { error: cardErr } = await supabase
      .from("cards")
      .upsert(cardRows, { onConflict: "id" });
    if (cardErr) throw cardErr;

    if (candidateRows.length > 0) {
      // Best-effort (table exists after migration 007)
      await supabase
        .from("card_image_candidates")
        .upsert(candidateRows, { onConflict: "card_id,url", ignoreDuplicates: true })
        .then(() => {});
    }

    // 2) Merge quantities per (card id, finish)
    const wanted = new Map<string, { cardId: string; variant: string; qty: number }>();
    for (const i of items) {
      const variant = i.variant || "normal";
      const key = `${i.card.id}|${variant}`;
      const prev = wanted.get(key);
      wanted.set(key, { cardId: i.card.id, variant, qty: (prev?.qty ?? 0) + i.quantity });
    }

    // 3) Increment existing rows or insert new ones
    const cardIds = [...new Set([...wanted.values()].map((w) => w.cardId))];
    const { data: existing, error: exErr } = await supabase
      .from("collection_items")
      .select("id, card_id, variant, quantity")
      .eq("user_id", user.id)
      .in("card_id", cardIds);
    if (exErr) throw exErr;

    const existingByKey = new Map(
      (existing ?? []).map((r) => [`${r.card_id}|${r.variant ?? "normal"}`, r])
    );
    let added = 0;
    for (const [key, w] of wanted) {
      const row = existingByKey.get(key);
      if (row) {
        const { error } = await supabase
          .from("collection_items")
          .update({ quantity: (row.quantity as number) + w.qty, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("collection_items")
          .insert({ user_id: user.id, card_id: w.cardId, variant: w.variant, quantity: w.qty });
        if (error) throw error;
      }
      added += w.qty;
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
