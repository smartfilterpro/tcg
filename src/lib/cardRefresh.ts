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
import { attachTcgPlayerId } from "@/lib/tcgPlayerId";

/** How long a card must wait between refreshes.
 *
 *  Each refresh can cost a paid credit, and the button is one tap. Without a
 *  floor, a member idly pressing it twenty times spends twenty credits on a
 *  card whose price did not change in the meantime. Short enough that a
 *  genuine retry after a failure isn't blocked. */
const COOLDOWN_MS = 60_000;

/** …and the shorter floor for a card that still has NO price.
 *
 *  A full minute is the wrong wall for the one case somebody is actively
 *  trying to fix: they press, nothing appears, they press again, and being
 *  told "just checked" is infuriating when the card is still blank. Short
 *  enough to allow a real retry, long enough that holding the button down
 *  can't spend a credit a tap. */
const UNPRICED_COOLDOWN_MS = 15_000;

export interface CardRefreshResult {
  ok: boolean;
  /** What actually changed, for telling the member something true. */
  priceFound: boolean;
  imageFound: boolean;
  /** Set when nothing was attempted because the card was just refreshed. */
  cooledDown?: boolean;
  /** True only when there is no such card. Everything else is an outcome
   *  the caller should show, not an HTTP failure to swallow. */
  notFound?: boolean;
  /** The database's own words when a write is refused, so a failure can be
   *  diagnosed from the screen instead of reproduced first. */
  detail?: string;
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
    return {
      ok: false,
      notFound: true,
      priceFound: false,
      imageFound: false,
      message: "Card not found.",
      ...(error ? { detail: error.message } : {}),
    };
  }

  const hadPrice = card.market_price != null;
  const lastChecked = card.price_updated_at ? Date.parse(card.price_updated_at as string) : 0;
  const floor = hadPrice ? COOLDOWN_MS : UNPRICED_COOLDOWN_MS;
  if (Number.isFinite(lastChecked) && Date.now() - lastChecked < floor) {
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
  let tcgPlayerId: string | null = null;

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
    tcgPlayerId = found.tcgPlayerId;
  }

  if (market != null) patch.market_price = market;

  const { error: writeError } = await admin.from("cards").update(patch).eq("id", id);

  // The bonus field, on its own and after the write that matters. It has a
  // unique index, so bundling it here meant one duplicate card in the
  // catalogue threw away a perfectly good price.
  let duplicateOfAnother = false;
  if (tcgPlayerId && !card.tcgplayer_id) {
    const attached = await attachTcgPlayerId(admin, id, tcgPlayerId);
    duplicateOfAnother = attached.conflict;
  }

  // Read the row back rather than trusting what the update returned.
  //
  // `.update(...).select().maybeSingle()` hands back a representation only
  // when PostgREST is asked for one, and a null there is indistinguishable
  // from "no such row" — so the old code fell back to the PRE-update copy
  // it already had in hand. That copy still has no price, which is how the
  // panel ended up printing "Found a price" directly above "No market price
  // yet": the message came from the lookup and the card came from before
  // the write. One extra cheap select removes the ambiguity entirely, and
  // what it returns is by definition what the card now is.
  const { data: updated } = await admin.from("cards").select("*").eq("id", id).maybeSingle();

  // THE SAVED ROW DECIDES, not what we set out to do.
  //
  // This reported success from intent: "did a source hand us a number?"
  // rather than "does the card have a price now?". Those come apart
  // whenever the write fails — a rejected value, a column that isn't there,
  // a constraint — and the result was the panel cheerfully saying "Found a
  // price" directly above "No market price yet". A claim about stored data
  // has to be read back from the store.
  const saved = (updated ?? null) as Record<string, unknown> | null;
  const priceFound = saved ? saved.market_price != null : false;
  const imageFound = saved ? !!saved.image_small && !card.image_small : false;

  if (writeError || (market != null && !priceFound)) {
    // Loud, because this is the case that used to lie. It lands in the
    // server log, which is now readable from the admin page.
    const dbDetail = writeError
      ? [writeError.message, (writeError as { code?: string }).code, (writeError as { details?: string }).details]
          .filter(Boolean)
          .join(" · ")
      : "the write reported success but the row is unchanged";
    console.error(
      `card refresh: ${id} ("${card.name}" #${card.number}) — found ${market ?? "no"} price ` +
        `but the row did not take it. ${dbDetail}. patch keys: ${Object.keys(patch).join(", ")}`
    );
    return {
      ok: false,
      priceFound: false,
      imageFound: false,
      message: `Found a price of $${market} but it didn't save — ${dbDetail}`,
      detail: dbDetail,
      card: saved ?? card,
    };
  }

  // Say what happened, specifically. "Refreshed" tells a member nothing
  // when the thing they wanted is still blank.
  let message: string;
  const dupNote = duplicateOfAnother
    ? " This card is a duplicate of another row in the catalogue — merge them in Admin, Catalogue, Merge duplicate cards."
    : "";
  if (priceFound && imageFound) message = "Found a price and a picture.";
  else if (priceFound) message = hadPrice ? "Price updated." : "Found a price.";
  else if (imageFound) message = "Found a picture, but no source has a price for this card.";
  else if (hadPrice) message = "No newer price available — keeping the one we have.";
  else {
    // Says what was ASKED and what came back, rather than asserting a fact
    // about the whole market. "No source has a price for this card" is a
    // claim about every price list in the world; what actually happened is
    // that two lookups on a name and a number found nothing, which is a very
    // different thing and fails in ways a member can sometimes see — a set
    // named differently at TCGplayer, a collector number written another way.
    const tried = priceTrackerEnabled()
      ? "the card database and the paid price service"
      : "the card database";
    message =
      `Looked up "${card.name}" #${card.number} from ${card.set_name ?? "an unknown set"} in ` +
      `${tried} and neither returned a price. Newly released cards can take a while to ` +
      `appear, and a set whose name is written differently at the source can be missed ` +
      `entirely — the nightly refresh keeps trying.`;
  }

  // One line per refresh, so the server log can answer "I pressed it and
  // nothing happened" without anyone having to reproduce it.
  console.log(
    `card refresh: ${id} ("${card.name}" #${card.number}, set "${card.set_name ?? "?"}") — ` +
      `price ${saved?.market_price ?? "none"}, art ${imageFound ? "found" : "unchanged"}`
  );

  return { ok: true, priceFound, imageFound, message: message + dupNote, card: saved ?? card };
}
