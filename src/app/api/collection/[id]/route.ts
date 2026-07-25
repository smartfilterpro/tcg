import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: update quantity (0 deletes), variant, and/or notes.
 *  Body: { quantity?, variant?, notes? } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { quantity, variant, notes, priceOverride } = (await req.json()) as {
      quantity?: number;
      variant?: string;
      notes?: string | null;
      priceOverride?: number | null;
    };

    const supabase = await createClient();

    if (quantity !== undefined) {
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
        return NextResponse.json({ error: "Invalid quantity" }, { status: 400 });
      }
      if (quantity === 0) {
        const { error } = await supabase
          .from("collection_items")
          .delete()
          .eq("id", id)
          .eq("user_id", user.id);
        if (error) throw error;
        return NextResponse.json({ ok: true, deleted: true });
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (quantity !== undefined) patch.quantity = quantity;
    if (variant !== undefined) {
      if (typeof variant !== "string" || variant.length === 0 || variant.length > 40) {
        return NextResponse.json({ error: "Invalid variant" }, { status: 400 });
      }
      patch.variant = variant;
    }
    if (notes !== undefined) {
      if (notes !== null && (typeof notes !== "string" || notes.length > 500)) {
        return NextResponse.json({ error: "Notes too long (max 500 chars)" }, { status: 400 });
      }
      patch.notes = notes || null;
    }
    if (priceOverride !== undefined) {
      if (
        priceOverride !== null &&
        (typeof priceOverride !== "number" || !Number.isFinite(priceOverride) ||
          priceOverride < 0 || priceOverride > 1_000_000)
      ) {
        return NextResponse.json({ error: "Invalid value" }, { status: 400 });
      }
      patch.price_override = priceOverride;
    }

    const { error } = await supabase
      .from("collection_items")
      .update(patch)
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      // Unique violation: changing variant collided with an existing row
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json(
          { error: "You already have this card in that finish — adjust quantities instead." },
          { status: 409 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    const { error } = await supabase
      .from("collection_items")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
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
