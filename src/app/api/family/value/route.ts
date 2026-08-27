import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { itemPrice } from "@/lib/types";
import { errorJson } from "@/lib/apiError";

/** GET: what the whole household's cards are worth, together and per
 *  member. One number a family plan keeps asking for and nobody wants to
 *  compute by switching binders and adding on paper.
 *
 *  Same arithmetic as every other total in the app — itemPrice: the
 *  owner's override wins, then the finish's own price, then the card's
 *  headline. Card values only; sealed product is per-account and has no
 *  family view, so it stays out rather than being half-counted.
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

    const perMember = ids
      .map((id) => ({
        id,
        name: nameOf.get(id) ?? "A member",
        value: Math.round((byMember.get(id) ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.value - a.value);
    const total = Math.round(perMember.reduce((s, m) => s + m.value, 0) * 100) / 100;

    return NextResponse.json({ family: true, total, members: perMember });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't total the household");
  }
}
