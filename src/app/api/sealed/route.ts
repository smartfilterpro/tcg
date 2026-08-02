import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { SEALED_CONDITIONS, SEALED_KINDS, priceProduct } from "@/lib/sealed";

export const maxDuration = 60;

/** The message a missing migration should produce, rather than a raw
 *  Postgres string about a relation nobody has heard of. */
const NOT_SET_UP =
  "Sealed product isn't set up yet — run supabase/migrations/045_sealed_product.sql.";

function missingTable(message: string | undefined): boolean {
  return /sealed_products|sealed_items/i.test(message ?? "");
}

/** GET: everything this member holds sealed, newest first. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sealed_items")
      .select("*, product:sealed_products(*)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) {
      if (missingTable(error.message)) {
        return NextResponse.json({ migrated: false, items: [] });
      }
      throw error;
    }
    return NextResponse.json({ migrated: true, items: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: add sealed product to the collection.
 *  Body: { name, kind?, setName?, year?, quantity?, condition? }
 *
 *  The catalogue row is found or created on the member's behalf, using the
 *  admin client — sealed_products is shared data that members can read but
 *  not write, exactly like `cards`. Matching is case-insensitive on the
 *  name, so two people adding the same box share one row and therefore one
 *  price lookup rather than splitting into near-duplicates. */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json()) as {
      name?: string;
      kind?: string;
      setName?: string;
      year?: number;
      quantity?: number;
      condition?: string;
      /** From a suggestion out of the paid catalogue. An IDENTIFIER only —
       *  never a price. sealed_products is shared, so a value posted by one
       *  member would become everyone's market price; the server fetches
       *  the number itself using this. */
      tcgPlayerId?: string;
    };

    const name = (body.name ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 200) {
      return NextResponse.json(
        { error: "Give the product a name (up to 200 characters)." },
        { status: 400 }
      );
    }
    const kind = SEALED_KINDS.includes(body.kind as never) ? body.kind! : "other";
    const condition = SEALED_CONDITIONS.includes(body.condition as never)
      ? body.condition!
      : "sealed";
    const quantity =
      Number.isInteger(body.quantity) && body.quantity! > 0 && body.quantity! <= 9999
        ? body.quantity!
        : 1;

    const admin = createAdminClient();

    // Find first, case-insensitively, so "Surging Sparks Booster Box" and
    // "surging sparks booster box" don't become two products the way the
    // card duplicates did.
    const { data: found, error: findErr } = await admin
      .from("sealed_products")
      .select("*")
      .ilike("name", name)
      .maybeSingle();
    if (findErr && missingTable(findErr.message)) {
      return NextResponse.json({ error: NOT_SET_UP }, { status: 400 });
    }

    let product = found;
    if (!product) {
      const { data: created, error: insErr } = await admin
        .from("sealed_products")
        .insert({
          name,
          kind,
          set_name: (body.setName ?? "").trim() || null,
          tcgplayer_id:
            typeof body.tcgPlayerId === "string" && body.tcgPlayerId.trim()
              ? body.tcgPlayerId.trim()
              : null,
          release_year:
            Number.isInteger(body.year) && body.year! > 1995 && body.year! < 2100
              ? body.year
              : null,
        })
        .select("*")
        .single();
      if (insErr) {
        if (missingTable(insErr.message)) {
          return NextResponse.json({ error: NOT_SET_UP }, { status: 400 });
        }
        throw insErr;
      }
      product = created;
    }

    // Owning more of something already held adds to it rather than failing
    // on the unique index — the same behaviour as adding a duplicate card.
    const supabase = await createClient();
    const { data: existing } = await supabase
      .from("sealed_items")
      .select("id, quantity")
      .eq("user_id", user.id)
      .eq("product_id", product.id)
      .eq("condition", condition)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("sealed_items")
        .update({
          quantity: (existing.quantity as number) + quantity,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("sealed_items").insert({
        user_id: user.id,
        product_id: product.id,
        condition,
        quantity,
      });
      if (error) throw error;
    }

    // Price it if we don't already have one. Detached: nobody waits on a
    // price lookup to see the thing they just added.
    if (product.market_price == null) void priceProduct(product.id, name, kind);

    return NextResponse.json({ ok: true, product });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const msg = err instanceof Error ? err.message : "Request failed";
  return NextResponse.json({ error: missingTable(msg) ? NOT_SET_UP : msg }, { status: 500 });
}
