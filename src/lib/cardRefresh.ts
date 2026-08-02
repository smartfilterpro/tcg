// Re-fetching one card, on demand.
//
// The background jobs get to everything eventually — the nightly refresher
// works the stalest owned cards, the sweep walks set by set — but "wait for
// tonight" is a bad answer to "this card I just scanned has no price". This
// is the same chain those jobs use, aimed at a single card and runnable from
// the card itself.
//
// The order is the order everywhere else in the app:
//
//   1. the card's own database (pokemontcg.io, or TCGdex for tcgdex- ids)
//   2. TCGdex art, free, for a missing picture
//   3. the paid tracker, for whatever is still missing after that
//
// It never blanks anything. A source with no answer leaves the existing
// value alone, because an empty field is worse than a stale one and a member
// pressing Refresh is not asking to lose data.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCardById } from "@/lib/pokemontcg";
import { getTcgdexPriceById, findTcgdexImage } from "@/lib/tcgdex";
import { priceTrackerEnabled, priceTrackerCard } from "@/lib/priceTracker";

/** How long a card must wait between refreshes.
 *
 *  Each refresh can cost a paid credit, and the button is one tap. Without a
 *  floor, a member idly pressing it twenty times spends twenty credits on a
 *  card whose price did not change in the meantime. Short enough that a
 *  genuine retry after a failure isn't blocked. */
const COOLDOWN_MS = 60_000;

export interface CardRefreshResult {
  ok: boolean;
  /** What actually changed, for telling the member something true. */
  priceFound: boolean;
  imageFound: boolean;
  /** Set when nothing was attempted because the card was just refreshed. */
  cooledDown?: boolean;
  /** Plain-language outcome, shown as-is. */
  message: string;
  card?: Record<string, unknown>;
}

export async function refreshCard(
  admin: SupabaseClient,
  cardId: string
): Promise<CardRefreshResult> {
  const { data: card, error } = await admin
    .from("cards")
    .select("*")
    .eq("id", cardId)
    .maybeSingle();
  if (error || !card) {
    return { ok: false, priceFound: false, imageFound: false, message: "Card not found." };
  }

  const hadPrice = card.market_price != null;
  const lastChecked = card.price_updated_at ? Date.parse(card.price_updated_at as string) : 0;
  if (Number.isFinite(lastChecked) && Date.now() - lastChecked < COOLDOWN_MS) {
    return {
      ok: true,
      priceFound: hadPrice,
      imageFound: !!card.image_small,
      cooledDown: true,
      message: hadPrice
        ? "Just checked — this price is current."
        : "Just checked, and no source had a price for this card yet.",
      card,
    };
  }

  const id = card.id as string;
  const patch: Record<string, unknown> = { price_updated_at: new Date().toISOString() };

  // 1. The card's own database.
  let market: number | null = null;
  if (id.startsWith("tcgdex-")) {
    market = await getTcgdexPriceById(id);
  } else if (!id.startsWith("custom-")) {
    const fresh = await getCardById(id);
    if (fresh?.marketPrice != null) market = fresh.marketPrice;
    if (fresh?.prices) patch.prices = fresh.prices;
  }

  // 2. Free art, if the picture is missing. Admin-locked art and member
  // photos are never touched — those exist because the stock image was
  // wrong or absent, and replacing them is the opposite of a fix.
  const memberPhoto = ((card.image_small as string | null) ?? "").includes("/card-photos/");
  const wantsArt = !card.image_small && card.image_locked !== true && !memberPhoto;
  if (wantsArt && !id.startsWith("custom-")) {
    const free = await findTcgdexImage({
      name: card.name as string,
      number: (card.number as string | null) ?? null,
    });
    if (free) {
      patch.image_small = free;
      patch.image_large = free;
    }
  }

  // 3. Pay only for what is still missing.
  const stillNeedsArt = wantsArt && !patch.image_small;
  if ((market == null || stillNeedsArt) && priceTrackerEnabled()) {
    const found = await priceTrackerCard({
      name: card.name as string,
      setName: (card.set_name as string | null) ?? null,
      number: (card.number as string | null) ?? null,
    });
    if (market == null && found.market != null) market = found.market;
    if (stillNeedsArt && found.image) {
      patch.image_small = found.image;
      patch.image_large = found.image;
    }
    if (found.tcgPlayerId && !card.tcgplayer_id) patch.tcgplayer_id = found.tcgPlayerId;
  }

  if (market != null) patch.market_price = market;

  const { data: updated } = await admin
    .from("cards")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  const priceFound = market != null;
  const imageFound = !!patch.image_small;

  // Say what happened, specifically. "Refreshed" tells a member nothing
  // when the thing they wanted is still blank.
  let message: string;
  if (priceFound && imageFound) message = "Found a price and a picture.";
  else if (priceFound) message = hadPrice ? "Price updated." : "Found a price.";
  else if (imageFound) message = "Found a picture, but no source has a price for this card.";
  else if (hadPrice) message = "No newer price available — keeping the one we have.";
  else {
    message =
      "No source has a price for this card yet. Newly released and very obscure cards " +
      "can take a while to appear; the nightly refresh keeps trying.";
  }

  return { ok: true, priceFound, imageFound, message, card: updated ?? card };
}
