import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";

/** Token-authenticated collection export for Claude Cowork / external tools.
 *  GET /api/export?token=... — no session required (the token IS the auth). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token || token.length < 20) {
    return NextResponse.json({ error: "Missing or invalid token" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: tokenRow } = await admin
    .from("api_tokens")
    .select("user_id")
    .eq("token", token)
    .maybeSingle();
  if (!tokenRow) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const [{ data: profile }, { data: items }, { data: playProfile }] = await Promise.all([
    admin.from("profiles").select("display_name, email").eq("id", tokenRow.user_id).single(),
    fetchAllRows(() =>
      admin
        .from("collection_items")
        .select("quantity, variant, notes, price_override, card:cards(*)")
        .eq("user_id", tokenRow.user_id)
        .order("created_at")
    ),
    admin
      .from("play_profiles")
      .select("style_notes")
      .eq("user_id", tokenRow.user_id)
      .maybeSingle(),
  ]);

  const collection = (items ?? []).map((i) => {
    const c = i.card as unknown as Record<string, unknown> & {
      prices?: Record<string, number | null> | null;
      market_price?: number | null;
    };
    const variant = (i.variant as string) ?? "normal";
    return {
      id: c.id,
      name: c.name,
      quantity: i.quantity,
      finish: variant,
      notes: i.notes ?? null,
      supertype: c.supertype,
      subtypes: c.subtypes,
      types: c.types,
      hp: c.hp,
      rarity: c.rarity,
      set: c.set_name,
      number: c.number,
      market_price_usd:
        (i.price_override as number | null) ?? c.prices?.[variant] ?? c.market_price ?? null,
    };
  });

  return NextResponse.json({
    owner: profile?.display_name || profile?.email || "unknown",
    exported_at: new Date().toISOString(),
    play_style: playProfile?.style_notes ?? null,
    total_cards: collection.reduce((s, c) => s + (c.quantity as number), 0),
    unique_cards: collection.length,
    collection,
  });
}
