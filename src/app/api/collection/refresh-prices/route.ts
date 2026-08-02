import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { getCardById } from "@/lib/pokemontcg";
import { priceTrackerEnabled, priceTrackerCard } from "@/lib/priceTracker";

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
      .select("card_id, card:cards(id, name, number, set_name, price_updated_at)")
      .eq("user_id", user.id);
    if (error) throw error;

    const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
    // Every stale card, INCLUDING tcgdex- and custom- ones.
    //
    // This used to exclude them because pokemontcg.io can't refresh them —
    // which meant the button did nothing for precisely the cards most
    // likely to lack a price, and a member pressing "Refresh prices" on a
    // collection of promos watched it report zero. The paid tracker
    // searches by name and number, so it can answer for any card.
    const stale = (items ?? [])
      .map(
        (i) =>
          i.card as unknown as {
            id: string;
            name: string;
            number: string | null;
            set_name: string | null;
            price_updated_at: string | null;
          }
      )
      .filter((c) => c && (!c.price_updated_at || new Date(c.price_updated_at).getTime() < cutoff))
      .slice(0, MAX_PER_RUN);

    let updated = 0;
    for (const card of stale) {
      const external = card.id.startsWith("custom-") || card.id.startsWith("tcgdex-");
      const fresh = external ? null : await getCardById(card.id);
      if (fresh?.marketPrice != null || fresh?.prices) {
        await supabase
          .from("cards")
          .update({
            market_price: fresh.marketPrice,
            prices: fresh.prices,
            price_updated_at: new Date().toISOString(),
          })
          .eq("id", card.id);
        updated++;
        continue;
      }
      // The free source had nothing (or couldn't be asked). Same fallback
      // the nightly refresher uses, so the button and the background job
      // give the same answer rather than the button giving a worse one.
      if (priceTrackerEnabled()) {
        const found = await priceTrackerCard({
          name: card.name,
          setName: card.set_name,
          number: card.number,
        });
        if (found.market != null) {
          await supabase
            .from("cards")
            .update({ market_price: found.market, price_updated_at: new Date().toISOString() })
            .eq("id", card.id);
          updated++;
        }
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
