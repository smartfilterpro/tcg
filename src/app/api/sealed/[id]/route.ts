import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { priceProduct } from "@/lib/sealed";

export const maxDuration = 60;

/** PATCH: change one holding — quantity, your own value, notes — or ask for
 *  a fresh price.
 *  Body: { quantity?, priceOverride?, notes?, repriceProduct?: true }
 *
 *  RLS scopes every one of these to the owner, so there is no ownership
 *  check here to forget to write: a member patching somebody else's row
 *  matches zero rows and changes nothing. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      quantity?: number;
      priceOverride?: number | null;
      notes?: string | null;
      repriceProduct?: boolean;
    };
    const supabase = await createClient();

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.quantity !== undefined) {
      if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 9999) {
        return NextResponse.json({ error: "Quantity must be between 1 and 9999." }, { status: 400 });
      }
      patch.quantity = body.quantity;
    }
    if (body.priceOverride !== undefined) {
      if (
        body.priceOverride !== null &&
        (!Number.isFinite(body.priceOverride) || body.priceOverride < 0)
      ) {
        return NextResponse.json({ error: "That value isn't a number." }, { status: 400 });
      }
      patch.price_override = body.priceOverride;
    }
    if (body.notes !== undefined) {
      patch.notes = (body.notes ?? "").slice(0, 2000) || null;
    }

    if (Object.keys(patch).length > 1) {
      const { error } = await supabase.from("sealed_items").update(patch).eq("id", id);
      if (error) throw error;
    }

    // A reprice is about the shared product, not this holding, so it is
    // done after the row-level edit and reported separately.
    let repriced: number | null = null;
    if (body.repriceProduct) {
      const { data: item } = await supabase
        .from("sealed_items")
        .select("product:sealed_products(id, name, kind)")
        .eq("id", id)
        .maybeSingle();
      const product = item?.product as unknown as
        | { id: string; name: string; kind: string }
        | undefined;
      if (product) repriced = await priceProduct(product.id, product.name, product.kind);
    }

    const { data: updated } = await supabase
      .from("sealed_items")
      .select("*, product:sealed_products(*)")
      .eq("id", id)
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      item: updated,
      repriced,
      // Said plainly, because "no price" and "we didn't look" are different
      // answers and only one of them is worth pressing again.
      message:
        body.repriceProduct && repriced == null
          ? "No credible sealed listings found for this one right now."
          : undefined,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: stop holding this. The shared product row stays — somebody else
 *  may hold it, and its price history is worth keeping either way. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const supabase = await createClient();
    const { error } = await supabase.from("sealed_items").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
