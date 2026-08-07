import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";

/** Token-authenticated collection export for Claude Cowork / external tools.
 *
 *  GET /api/export — no session required (the token IS the auth), supplied
 *  either as `Authorization: Bearer <token>` or as `?token=…`.
 *
 *  The header is preferred and the query string is kept because it has to
 *  be: this link's whole purpose is to be pasted into a tool that fetches a
 *  URL, and such a tool has nowhere to put a header. A credential in a query
 *  string is written into logs and, historically, into Referer — the latter
 *  now closed by the Referrer-Policy header, the former the reason anything
 *  that can send a header should. Security audit finding M4. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = bearer ?? url.searchParams.get("token");
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

  // Leave a trace. Not for us — for the member, whose Settings page shows
  // this and is the only way they would ever notice a link being used from
  // somewhere they have never been.
  void admin
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token", token)
    .then(() => {});

  const [{ data: profile }, { data: items }, { data: playProfile }] = await Promise.all([
    // Display name only. The email used to be the fallback here, which put
    // an address into a payload that travels to whatever tool holds the
    // link — and the deck builder on the other end needs a name to greet
    // somebody by, not a way to reach them.
    admin.from("profiles").select("display_name").eq("id", tokenRow.user_id).single(),
    fetchAllRows(() =>
      admin
        .from("collection_items")
        .select("quantity, variant, notes, price_override, card:cards(*)")
        .eq("user_id", tokenRow.user_id)
        .order("created_at")
        .order("id")
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

  return NextResponse.json(
    {
      owner: profile?.display_name || "unknown",
      exported_at: new Date().toISOString(),
      play_style: playProfile?.style_notes ?? null,
      total_cards: collection.reduce((s, c) => s + (c.quantity as number), 0),
      unique_cards: collection.length,
      collection,
    },
    {
      headers: {
        // Somebody's whole collection, reachable with a URL: not a thing to
        // leave in a shared cache or a search index.
        "Cache-Control": "no-store, private",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }
  );
}
