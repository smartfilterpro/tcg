import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { itemPrice } from "@/lib/types";
import { sealedItemPrice } from "@/lib/sealed";
import { errorJson } from "@/lib/apiError";

/** GET: what the whole household owns, together and per member — cards
 *  AND sealed product. One number a family plan keeps asking for and
 *  nobody wants to compute by switching binders and adding on paper.
 *
 *  Same arithmetic as every other total in the app: itemPrice for cards
 *  (override, then the finish's price, then the headline) and
 *  sealedItemPrice for boxes (override, then market). Sealed rides along
 *  as its own figure and inside the total, so the page can say both
 *  "worth $X together" and how it splits.
 *
 *  The service role reads the pool: family_members is deliberately
 *  unreadable by clients, and membership itself is the authorization —
 *  the caller must BE in the family they're totalling. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();

    const { data: me } = await admin
      .from("family_members")
      .select("group_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!me) return NextResponse.json({ family: false });
    const { data: members } = await admin
      .from("family_members")
      .select("user_id")
      .eq("group_id", me.group_id);
    const ids = [...new Set((members ?? []).map((m) => m.user_id as string))];
    if (ids.length <= 1) return NextResponse.json({ family: false });

    type Row = {
      user_id: string;
      quantity: number;
      variant: string | null;
      price_override: number | null;
      card: {
        prices: Record<string, number | null> | null;
        market_price: number | null;
      } | Array<{
        prices: Record<string, number | null> | null;
        market_price: number | null;
      }> | null;
    };
    const { data: rows, error } = await fetchAllRows<Row>(() =>
      admin
        .from("collection_items")
        .select("user_id, quantity, variant, price_override, card:cards(prices, market_price)")
        .in("user_id", ids)
        .order("user_id")
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: Row[] | null;
          error: { message: string } | null;
        }>;
      }
    );
    if (error) throw error;

    const byMember = new Map<string, number>();
    for (const r of rows ?? []) {
      // supabase-js types the embedded to-one join as an array; at runtime
      // it is an object. Read either shape.
      const card = Array.isArray(r.card) ? r.card[0] : r.card;
      if (!card) continue;
      const each = itemPrice({
        price_override: r.price_override,
        variant: r.variant ?? "normal",
        card,
      });
      if (each == null) continue;
      byMember.set(r.user_id, (byMember.get(r.user_id) ?? 0) + each * (r.quantity ?? 0));
    }

    // Sealed product, per member. Its own map so the page can state the
    // split. Best-effort behind a try: the sealed tables arrive with a
    // later migration than families did, and a household without them
    // still deserves its card total.
    const sealedByMember = new Map<string, number>();
    try {
      type SealedRow = {
        user_id: string;
        quantity: number;
        price_override: number | null;
        product:
          | { market_price: number | null }
          | Array<{ market_price: number | null }>
          | null;
      };
      const { data: sealedRows, error: sealedErr } = await fetchAllRows<SealedRow>(() =>
        admin
          .from("sealed_items")
          .select("user_id, quantity, price_override, product:sealed_products(market_price)")
          .in("user_id", ids)
          .order("user_id")
          .order("id") as unknown as {
          range: (from: number, to: number) => PromiseLike<{
            data: SealedRow[] | null;
            error: { message: string } | null;
          }>;
        }
      );
      if (sealedErr) throw sealedErr;
      for (const r of sealedRows ?? []) {
        const product = Array.isArray(r.product) ? r.product[0] : r.product;
        const each = sealedItemPrice({ price_override: r.price_override, product });
        if (each == null) continue;
        sealedByMember.set(
          r.user_id,
          (sealedByMember.get(r.user_id) ?? 0) + each * (r.quantity ?? 0)
        );
      }
    } catch {
      // Pre-sealed-migration: cards-only totals, still correct.
    }

    const { data: profiles } = await admin
      .from("profiles")
      .select("id, display_name, email")
      .in("id", ids);
    const nameOf = new Map(
      (profiles ?? []).map((p) => [
        p.id as string,
        ((p.display_name as string | null)?.trim() ||
          ((p.email as string | null) ?? "").split("@")[0]) as string,
      ])
    );

    const round = (n: number) => Math.round(n * 100) / 100;
    const perMember = ids
      .map((id) => {
        const cards = round(byMember.get(id) ?? 0);
        const sealed = round(sealedByMember.get(id) ?? 0);
        return {
          id,
          name: nameOf.get(id) ?? "A member",
          cards,
          sealed,
          value: round(cards + sealed),
        };
      })
      .sort((a, b) => b.value - a.value);
    const cardsTotal = round(perMember.reduce((s, m) => s + m.cards, 0));
    const sealedTotal = round(perMember.reduce((s, m) => s + m.sealed, 0));
    const total = round(cardsTotal + sealedTotal);

    return NextResponse.json({
      family: true,
      total,
      cardsTotal,
      sealedTotal,
      members: perMember,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't total the household");
  }
}
