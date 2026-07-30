// The boost packs, in one place.
//
// This table used to live in lib/stripe.ts with the display copy hand-copied
// into the meter and the pricing page — three lists to keep in step, which is
// exactly how they fell out of step. It has no imports on purpose, so the
// server (checkout, webhook) and the client (meter, pricing) can both read
// the same numbers.
//
// PRICING RULE: a boost costs MORE per credit than a monthly plan. The plan
// is the committed rate; a top-up is convenience you pay for. Pro sells ~59
// credits per net dollar (after Stripe's 2.9% + 30¢), so every pack here must
// sit below that, and value must rise with pack size so bulk is genuinely the
// better buy. These land at 48 / 54 / 55.
//
// The previous packs inverted this — 96, 100 and 110 credits per net dollar —
// so a boost undercut the subscription it was meant to supplement, and at a
// 1¢ cost basis each one sold at or below cost.

export interface BoostPack {
  credits: number;
  cents: number;
  /** Shown on the Stripe line item. */
  label: string;
  /** One line under the pack in the meter and on the pricing page. */
  note: string;
  best?: boolean;
}

export const BOOST_PACKS: Record<string, BoostPack> = {
  "125": {
    credits: 125,
    cents: 300,
    label: "125 credits",
    note: "A weekend of scanning",
  },
  "400": {
    credits: 400,
    cents: 800,
    label: "400 credits",
    note: "A whole new set",
  },
  "1000": {
    credits: 1000,
    cents: 1900,
    label: "1,000 credits (best value)",
    note: "Shoebox amnesty — best value per credit",
    best: true,
  },
};

/** Ready to render, in the order they should appear. */
export const BOOST_LIST = Object.entries(BOOST_PACKS).map(([id, p]) => ({
  id,
  credits: `${p.credits.toLocaleString()} credits`,
  price: `$${(p.cents / 100).toFixed(0)}`,
  note: p.note,
  best: p.best === true,
}));

export const BOOSTS_NOTE =
  "Top-ups cost a little more per credit than a monthly plan — if you're buying " +
  "them often, upgrading is the cheaper way round.";
