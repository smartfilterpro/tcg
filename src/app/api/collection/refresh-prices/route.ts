import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { getCardById } from "@/lib/pokemontcg";

export const maxDuration = 120;

const STALE_HOURS = 12;
const MAX_PER_RUN = 60;

/** Refresh market prices for the user's cards whose price data is stale. */
export async function POST() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();

    const { data: items, error } = await supabase
      .from("collection_items")
      .select("card_id, card:cards(id, price_updated_at)")
      .eq("user_id", user.id);
    if (error) throw error;

    const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
    const stale = (items ?? [])
      .map((i) => i.card as unknown as { id: string; price_updated_at: string | null })
      // Manual and TCGdex-sourced cards aren't refreshable via pokemontcg.io
      .filter((c) => c && !c.id.startsWith("custom-") && !c.id.startsWith("tcgdex-"))
      .filter((c) => !c.price_updated_at || new Date(c.price_updated_at).getTime() < cutoff)
      .slice(0, MAX_PER_RUN);

    let updated = 0;
    for (const card of stale) {
      const fresh = await getCardById(card.id);
      if (fresh) {
        await supabase
          .from("cards")
          .update({
            market_price: fresh.marketPrice,
            prices: fresh.prices,
            price_updated_at: new Date().toISOString(),
          })
          .eq("id", card.id);
        updated++;
      }
    }

    return NextResponse.json({ ok: true, updated, remainingStale: Math.max(0, stale.length - updated) });
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
