import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { refreshCard } from "@/lib/cardRefresh";
import { errorJson } from "@/lib/apiError";

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
    // 200 whenever the card exists, even when the refresh went badly.
    //
    // A non-2xx made the browser treat a detailed answer as a bare
    // transport failure: the client throws on !res.ok and reads `error`,
    // which this body doesn't carry, so a carefully worded explanation
    // became the word "failed". The request DID succeed — what failed is
    // described inside it. `error` is mirrored anyway so any generic
    // handler still shows something true.
    if (result.notFound) {
      return NextResponse.json({ ...result, error: result.message }, { status: 404 });
    }
    return NextResponse.json(
      result.ok ? result : { ...result, error: result.message },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Refresh failed");
  }
}
