import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { refreshCard } from "@/lib/cardRefresh";

export const maxDuration = 60;

/** POST: re-fetch one card's price and picture, now.
 *
 *  Gated on owning the card, or being an admin. Not because the data is
 *  sensitive — it's the same public card data anyone can search — but
 *  because each call can spend a paid credit, and "any signed-in person can
 *  spend a credit on any of 40,000 cards, one tap at a time" is a bill
 *  waiting to happen. Owning the card ties the spend to a real need.
 *
 *  Writes through the admin client: the cards table is shared catalogue data
 *  that members cannot write directly, which is correct — the fix here is a
 *  server-side one on their behalf, not a widened policy. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, profile } = await requireUser();
    const { id } = await ctx.params;

    if (profile?.role !== "admin") {
      const supabase = await createClient();
      const { data: owned } = await supabase
        .from("collection_items")
        .select("id")
        .eq("user_id", user.id)
        .eq("card_id", id)
        .limit(1);
      if (!owned || owned.length === 0) {
        return NextResponse.json(
          { error: "You can refresh cards in your own collection." },
          { status: 403 }
        );
      }
    }

    const result = await refreshCard(createAdminClient(), id);
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 }
    );
  }
}
