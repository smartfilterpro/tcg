// Marketing copy that is DATA rather than prose: the numbers, tiers and
// tables the landing and pricing pages render. Copy that is just sentences
// lives in the components.

import { BOOST_LIST, BOOSTS_NOTE } from "@/lib/boosts";
import { FREE_DECK_LIMIT } from "@/lib/limits";
import { CREDIT_MENU, MONTHLY_GRANT, SIGNUP_GRANT } from "@/lib/credits";

// STATS / STATS_ASOF / STATS_DISCLAIMER lived here as hand-measured
// constants. They are measured from scan_events now — see lib/liveStats.ts.
// A hand-maintained number decays: it stops moving while the thing it
// describes keeps changing, and nobody remembers to edit it.

/** The pricing page's cost table, from the same menu the in-app reference
 *  page reads. Two hand-kept lists of the same numbers had already drifted —
 *  this one was missing chat, trade advice and image search entirely. */
export const CREDIT_COSTS = CREDIT_MENU.map((m) => ({
  action: m.label,
  cost: `${m.cost} credits`,
}));

export const CREDIT_COSTS_NOTE =
  "Charged by what each request actually costs to run — bigger collections make bigger deck builds. Every charge shows in your history.";

export interface Tier {
  name: string;
  who: string;
  price: string;
  per: string;
  credits: string;
  creditsNote: string;
  featured: boolean;
  dark: boolean;
  features: Array<{ text: string; included: boolean }>;
  cta: string;
  /** Where the button goes; checkout wiring is the app's job post-signup. */
  href: string;
}

const f = (text: string, included = true) => ({ text, included });

export const TIERS: Tier[] = [
  {
    name: "Free",
    who: "Collect, catalogue, build by hand",
    price: "$0",
    per: "forever",
    credits: `${SIGNUP_GRANT} credits, one time`,
    creditsNote: "Enough for a few bulk scans and your first deck build",
    featured: false,
    dark: false,
    features: [
      // Driven by the constant the API actually enforces, not restated by
      // hand. This line read "Unlimited cards and decks" while the save gate
      // refused the fourth one — the worst kind of pricing copy, because
      // somebody finds out by being stopped.
      f(`Unlimited cards · up to ${FREE_DECK_LIMIT} saved decks`),
      f("Add cards by database search"),
      f("Collection value + weekly price refresh"),
      f("Two-player battles"),
      f("CSV export", false),
      f("Ongoing TrainerAI credits", false),
    ],
    cta: "Start free",
    href: "/signup",
  },
  {
    name: "Pro",
    who: "For players who actually play",
    price: "$9",
    per: "/ month",
    credits: `${MONTHLY_GRANT.pro} credits every month`,
    creditsNote: "≈ 140 bulk scans, a dozen deck builds, or hundreds of coach replies",
    featured: true,
    dark: true,
    features: [
      f("Everything in Free"),
      // Stated outright: "Everything in Free" otherwise carries Free's deck
      // cap with it, which is the opposite of what Pro is for.
      f("Unlimited saved decks"),
      f("Bulk camera scanning, 20+ cards a shot"),
      f("TrainerAI deck building + coaching"),
      f("Card grading reports"),
      f("Daily price refresh"),
      f("CSV export of your whole collection"),
    ],
    cta: "Go Pro",
    href: "/signup?plan=pro",
  },
  {
    name: "Family",
    who: "Up to 5 trainers, one bill",
    price: "$19",
    per: "/ month",
    credits: `${MONTHLY_GRANT.family.toLocaleString()} shared credits a month`,
    creditsNote: "Pooled across the household, with per-profile caps you set",
    featured: false,
    dark: false,
    features: [
      f("Everything in Pro, for 5 profiles"),
      f("Shared family binder"),
      f("Free trading inside the family"),
      f("Parent approval for spending"),
      f("Per-profile credit limits"),
      f("Priority support"),
    ],
    cta: "Start a family plan",
    href: "/signup?plan=family",
  },
];

export const BOOSTS = BOOST_LIST.map((b) => ({ pack: b.id, ...b }));

export { BOOSTS_NOTE };

export const FAQS = [
  {
    q: "What happens when I run out of credits?",
    a: "Nothing breaks. Your collection, decks, values and trades all keep working — only new AI requests pause until your monthly credits refill or you buy a boost.",
  },
  {
    q: "Do unused credits roll over?",
    a: "Monthly plan credits reset each billing cycle. Boost credits you paid for don't expire while your plan is active.",
  },
  {
    q: "Why credits instead of unlimited?",
    a: "Because a deck build costs real money to run, and 'unlimited' plans either get throttled quietly or priced for the heaviest user. Metering keeps Pro at $9.",
  },
  {
    q: "What happens if I cancel?",
    a: "Cancel any time from billing and you keep access to the end of the cycle you've paid for — there's no partial refund for the rest of it. Your monthly credits end with the plan; boost credits you bought stay on your account and keep working on the free plan. Payments are final, and deleting your account forfeits any credits left, including boosts.",
  },
  {
    q: "Is this affiliated with Pokémon?",
    a: "No. It's an independent fan-made tool. Card data and prices come from public databases, and we don't sell cards.",
  },
  {
    q: "Are prices and AI output guaranteed?",
    a: "No — market values are best-effort estimates and AI suggestions are suggestions. Never treat either as an appraisal or a tournament ruling.",
  },
] as const;
