import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { ebayEnabled } from "@/lib/ebay";
import { listingPrices, type CardQuery } from "@/lib/ebayListings";

export const maxDuration = 45;

// Cap per request. A deck's buy-list is a dozen cards; anything larger is a
// caller doing something we didn't design for, and eBay's daily call budget
// is shared across every user of the app.
const MAX_CARDS = 12;

/** POST { cards: [{ name, number?, setName? }] } → asking prices per card.
 *
 *  ASKING prices, from active listings. Deliberately not exposed as a
 *  valuation: the caller renders these against cards someone is about to buy,
 *  where the ask is the honest number. Sold-price data needs eBay's
 *  Marketplace Insights, which this application does not have.
 *
 *  No credits. There is no model call here — it's a cached HTTP lookup, and
 *  charging for it would be charging for our own cache misses. */
export async function POST(req: Request) {
  try {
    await requireUser();

    if (!ebayEnabled()) {
      // Not an error: the whole feature is optional, and the client hides the
      // line rather than showing a failure the reader can do nothing about.
      return NextResponse.json({ enabled: false, prices: {} });
    }

    const body = (await req.json().catch(() => ({}))) as { cards?: unknown };
    const raw = Array.isArray(body.cards) ? body.cards : [];
    const cards: CardQuery[] = raw
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        name: typeof c.name === "string" ? c.name.trim() : "",
        number: typeof c.number === "string" ? c.number : null,
        setName: typeof c.setName === "string" ? c.setName : null,
      }))
      .filter((c) => c.name.length > 0)
      .slice(0, MAX_CARDS);

    if (cards.length === 0) {
      return NextResponse.json({ enabled: true, prices: {} });
    }

    return NextResponse.json({
      enabled: true,
      prices: await listingPrices(cards),
      truncated: raw.length > MAX_CARDS,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("listing prices error", err);
    return NextResponse.json({ error: "Couldn't fetch prices" }, { status: 500 });
  }
}
