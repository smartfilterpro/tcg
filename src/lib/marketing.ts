// Marketing copy that is DATA rather than prose: the numbers, tiers and
// tables the landing and pricing pages render. Copy that is just sentences
// lives in the components.

import { BOOST_PACKS } from "@/lib/stripe";
import { MONTHLY_GRANT, SIGNUP_GRANT } from "@/lib/credits";

/** Hand-measured, hand-updated — the owner's decision over wiring these to
 *  live telemetry. The as-of date renders next to them, and the disclaimer
 *  is not optional: without it these read as guarantees. */
export const STATS = [
  { value: "97%", label: "of scanned cards matched correctly, first try" },
  { value: "3.4s", label: "average time to add one card, start to saved" },
  { value: "20+", label: "cards read from a single photo" },
] as const;

export const STATS_ASOF = "July 2026";
export const STATS_DISCLAIMER = `Measured on our own test scans, ${STATS_ASOF} — updated by hand as the scanner improves. Your photos, lighting and cards will vary.`;

/** What actions typically cost. Ranges, not fixed prices: the ledger debits
 *  what each call actually cost (1 credit = 1¢ of AI), so the honest table
 *  is a range. The mock's fixed menu predates that decision. */
export const CREDIT_COSTS = [
  { action: "Bulk scan (up to 20 cards)", cost: "2–4 credits" },
  { action: "Deck build", cost: "15–50 credits" },
  { action: "Deck review", cost: "5–15 credits" },
  { action: "Coach reply", cost: "1–3 credits" },
  { action: "Grading report", cost: "8–15 credits" },
] as const;

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
      f("Unlimited cards and decks"),
      f("Add cards by database search"),
      f("Collection value + weekly price refresh"),
      f("Two-player battles"),
      f("CSV export", false),
      f("Ongoing Trainer AI credits", false),
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
      f("Bulk camera scanning, 20+ cards a shot"),
      f("Trainer AI deck building + coaching"),
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

export const BOOSTS = Object.entries(BOOST_PACKS).map(([pack, spec]) => ({
  pack,
  credits: `${spec.credits.toLocaleString()} credits`,
  price: `$${(spec.cents / 100).toFixed(0)}`,
  note:
    pack === "250"
      ? "A weekend of scanning"
      : pack === "750"
        ? "Best value — a whole new set"
        : "Shoebox amnesty",
  best: pack === "750",
}));

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
    q: "Can I cancel or get a refund?",
    a: "Cancel any time from billing — you keep access to the end of the cycle. Unused boost credits are refundable within 14 days.",
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
