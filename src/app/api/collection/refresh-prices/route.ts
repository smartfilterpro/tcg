import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { getCardById } from "@/lib/pokemontcg";
import { priceTrackerEnabled, priceTrackerCard } from "@/lib/priceTracker";
import { findTcgdexImage } from "@/lib/tcgdex";

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
      .select(
        "card_id, card:cards(id, name, number, set_name, price_updated_at, image_small, image_locked, tcgplayer_id)"
      )
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
            image_small: string | null;
            image_locked: boolean | null;
            tcgplayer_id: string | null;
          }
      )
      .filter((c) => c && (!c.price_updated_at || new Date(c.price_updated_at).getTime() < cutoff))
      .slice(0, MAX_PER_RUN);

    let updated = 0;
    let artFilled = 0;
    for (const card of stale) {
      const external = card.id.startsWith("custom-") || card.id.startsWith("tcgdex-");

      // A card with no picture looks as broken as one with no price, and the
      // free source can often supply it. Asked first, and asked here rather
      // than only in the nightly job, so pressing the button fixes both.
      let needsArt = !card.image_small && card.image_locked !== true;
      if (needsArt && !card.id.startsWith("custom-")) {
        const free = await findTcgdexImage({ name: card.name, number: card.number });
        if (free) {
          await supabase
            .from("cards")
            .update({ image_small: free, image_large: free })
            .eq("id", card.id);
          needsArt = false;
          artFilled++;
        }
      }

      const fresh = external ? null : await getCardById(card.id);
      let priced = false;
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
        priced = true;
      }

      // The free sources had nothing — for the price, the picture, or both.
      // Same fallback the nightly refresher uses, so the button and the
      // background job give the same answer rather than the button giving a
      // worse one. One credit answers both questions, so it is spent only
      // when something is still missing after the free attempts.
      if ((!priced || needsArt) && priceTrackerEnabled()) {
        const found = await priceTrackerCard({
          name: card.name,
          setName: card.set_name,
          number: card.number,
        });
        const patch: Record<string, unknown> = {};
        if (!priced && found.market != null) {
          patch.market_price = found.market;
          patch.price_updated_at = new Date().toISOString();
        }
        if (needsArt && found.image) {
          patch.image_small = found.image;
          patch.image_large = found.image;
        }
        if (found.tcgPlayerId && !card.tcgplayer_id) patch.tcgplayer_id = found.tcgPlayerId;
        if (Object.keys(patch).length > 0) {
          await supabase.from("cards").update(patch).eq("id", card.id);
          if (patch.market_price != null) updated++;
          if (patch.image_small) artFilled++;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      updated,
      artFilled,
      remainingStale: Math.max(0, stale.length - updated),
    });
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
