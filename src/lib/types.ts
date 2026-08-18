// Shared types across the app

/** A normalized card summary — this is what we store in the `cards` table
 *  and pass around the UI. Derived from pokemontcg.io responses. */
export interface CardSummary {
  id: string; // pokemontcg.io id, e.g. "sv8pt5-42"
  name: string;
  supertype: string | null; // Pokémon | Trainer | Energy
  subtypes: string[]; // e.g. ["Basic"], ["Item"], ["Special Illustration Rare"-ish live in rarity]
  types: string[]; // energy types, e.g. ["Fire"]
  hp: string | null;
  number: string; // collector number
  rarity: string | null; // e.g. "Special Illustration Rare"
  setId: string;
  setName: string; // e.g. "Perfect Order"
  setSeries: string | null;
  setPrintedTotal: number | null;
  releaseDate: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
  marketPrice: number | null; // USD, best-effort from TCGplayer/cardmarket
  /** Per-finish USD prices from TCGplayer, e.g. { normal, holofoil, reverseHolofoil }.
   *  The keys double as the list of finishes that exist for this card. */
  prices: Record<string, number | null> | null;
  /** Attacks, abilities, rules text, weakness, resistance, retreat and
   *  format legality — everything about how the card PLAYS.
   *
   *  Optional because not every source carries it and not every caller
   *  builds one. Present means keep it; absent means this source had none,
   *  never that the card has none. */
  battleData?: unknown;
}

/** What Claude vision extracts from a photo for each card it sees. */
export interface DetectedCard {
  name: string;
  collectorNumber: string | null; // e.g. "042"
  setTotal: string | null; // the total after the slash, e.g. "191"
  setNameHint: string | null;
  rarityHint: string | null;
  confidence: "high" | "medium" | "low";
}

/** One entry in the scan result: what was detected + best DB match + alternatives. */
export interface ScanMatch {
  detected: DetectedCard;
  match: CardSummary | null;
  candidates: CardSummary[];
  /** Finish learned from past member corrections of this card — takes
   *  precedence over the scanner's own guess when present. */
  suggestedVariant?: string | null;
  /** How many of this card the scanner's owner already had, before this
   *  scan. Drives "NEW" versus "×3 NOW" on the results screen — the one
   *  thing someone reviewing a pile actually wants to know, and free to
   *  answer while we're already holding the matched ids. */
  owned?: number;
}

export interface CollectionItem {
  id: string;
  user_id: string;
  card_id: string;
  quantity: number;
  variant: string; // finish: normal | holofoil | reverseHolofoil | pcStamp | ...
  price_override: number | null; // owner-set value (stamped promos, graded cards)
  notes: string | null;
  created_at: string;
  updated_at: string;
  card: CardSummaryRow;
}

/** The value of one copy: the owner's custom value if set, else the
 *  market price for its finish. */
export function itemPrice(item: {
  price_override?: number | null;
  variant?: string;
  card: { prices?: Record<string, number | null> | null; market_price?: number | null };
}): number | null {
  if (item.price_override != null) return item.price_override;
  return priceForVariant(item.card, item.variant ?? "normal");
}

/** The card columns a collection LIST actually renders.
 *
 *  `card:cards(*)` shipped every column of every card — including
 *  battle_data (attacks, abilities, rules text) and effects (the compiled
 *  battle script), two fat jsonb blobs the grid never reads. Across a
 *  1,700-row collection that is most of the payload, which is most of the
 *  load time. The card sheet's text panel fetches its own via /api/cards
 *  when opened, so nothing here loses data — it stops shipping data nobody
 *  asked for yet.
 *
 *  One constant rather than three hand-typed lists, so the collection, the
 *  family view and the friend view cannot drift apart column by column. */
export const CARD_SUMMARY_COLUMNS =
  "id, name, supertype, subtypes, types, hp, number, rarity, set_id, set_name, " +
  "set_series, set_printed_total, release_date, image_small, image_large, " +
  "market_price, prices, price_updated_at";

/** DB row shape of the cards table (snake_case). */
export interface CardSummaryRow {
  id: string;
  name: string;
  supertype: string | null;
  subtypes: string[] | null;
  types: string[] | null;
  hp: string | null;
  number: string;
  rarity: string | null;
  set_id: string;
  set_name: string;
  set_series: string | null;
  set_printed_total: number | null;
  release_date: string | null;
  image_small: string | null;
  image_large: string | null;
  market_price: number | null;
  prices: Record<string, number | null> | null;
  price_updated_at: string | null;
  /** How the card plays. Only after migration 019. */
  battle_data?: unknown;
  /** Failed attempts to read the text off the card's picture, and when the
   *  last one was. Only after migration 050 — absent means never tried. */
  text_attempts?: number | null;
  text_failed_at?: string | null;
}

// ===== Variant (finish) helpers =====

export const VARIANT_LABELS: Record<string, string> = {
  normal: "Normal",
  holofoil: "Holo",
  reverseHolofoil: "Reverse Holo",
  "1stEditionNormal": "1st Edition",
  "1stEditionHolofoil": "1st Ed. Holo",
  unlimitedHolofoil: "Unlimited Holo",
  pcStamp: "Pokémon Center Stamp",
  prereleaseStamp: "Prerelease Stamp",
  staffStamp: "Staff Stamp",
  pokeBall: "Poké Ball pattern",
  masterBall: "Master Ball pattern",
  friendBall: "Friend Ball pattern",
  loveBall: "Love Ball pattern",
};

/** Stamped versions exist physically but not as separate database entries —
 *  the databases key on set+number, and a stamp doesn't change the number.
 *  We track them as finishes; prices fall back to the unstamped market value. */
export const STAMP_VARIANTS = ["pcStamp", "prereleaseStamp", "staffStamp"] as const;

/** Reverse holos whose foil carries a repeating ball pattern.
 *
 *  Physically a different card and priced as one — a Master Ball Pikachu can
 *  be worth many times the plain reverse holo — but the collector number is
 *  identical, so the card databases we read hold ONE entry for all of them.
 *  TCGplayer splits them into separate products ("Pikachu (Friend Ball)"),
 *  which is why a search here returns a single result for something that is
 *  visibly several different cards on their site.
 *
 *  THE FALLBACK, not the good path. When the paid source's own row for the
 *  printing exists — "Pikachu (Friend Ball)", carrying that product's real
 *  market price — picking THAT is strictly better, and a deep search will
 *  find and keep it. These finishes are for printings no source lists at
 *  all: the price falls back to the plain card and is shown as an estimate
 *  rather than a measurement (see variantPrice), because a fallback dressed
 *  as a fact is worse than an honest approximation.
 *
 *  The list grows: Poké Ball and Master Ball came with Scarlet & Violet,
 *  Friend Ball with Mega Evolution. Adding one is a line here and a label
 *  above. */
export const PATTERN_VARIANTS = ["pokeBall", "masterBall", "friendBall", "loveBall"] as const;

/** Every finish a member can record that no database will ever list for
 *  them. Offered in the pickers on top of whatever the card's price map
 *  knows about. */
export const MANUAL_VARIANTS = [...STAMP_VARIANTS, ...PATTERN_VARIANTS] as const;

/** Is this card row ALREADY a specific printing in its own right?
 *
 *  The paid source sells each one as its own product and names it so —
 *  "Pikachu (Friend Ball)", "N's Zekrom (Pokémon Center)" — and those rows
 *  carry that printing's real price rather than the plain card's. When one
 *  exists, picking it is strictly better than recording a finish against the
 *  plain card, because the finish has no price of its own.
 *
 *  So the manual finishes are hidden on a row that is already one of them.
 *  Offering "Friend Ball pattern" on a card called "Pikachu (Friend Ball)"
 *  invites a copy filed as a pattern of a pattern, which is both wrong and
 *  worth less than what it actually is. */
export function isSpecificPrinting(name: string): boolean {
  // ANY parenthetical, not a list of the ones I could think of.
  //
  // The first version enumerated ball types plus Pokémon Center, prerelease
  // and staff — which is a list that is wrong the day a new one ships, and
  // they ship every set. Poké Ball and Master Ball arrived with Scarlet &
  // Violet, Friend Ball with Mega Evolution, and there is no reason to
  // believe that stopped.
  //
  // The general signal is the shape itself: card names do not contain
  // parentheses, and the paid source uses them for exactly one purpose —
  // naming which printing a product is. Reading the shape rather than
  // matching a vocabulary means the next one works without a code change.
  return /\(.+\)/.test(name);
}

/** The ball motif a scan reported, as the words a product name would use.
 *  Null when the scan saw no ball. Shared so the scanner, the matcher and
 *  the finish list all agree on what counts as a pattern. */
export function ballPatternOf(hint: string | null | undefined): {
  /** The finish to record when the card has no separate row of its own.
   *  Null for a ball we have no finish for — then the printing's own row is
   *  the only way to record it, and a plain reverse holo is the fallback. */
  variant: string | null;
  /** How the printing's NAME would spell it, normalised. */
  words: string[];
} | null {
  const h = (hint ?? "").toLowerCase();
  if (h.includes("poke ball") || h.includes("poké ball")) {
    return { variant: "pokeBall", words: ["pokeball", "pokball"] };
  }
  if (h.includes("master ball")) return { variant: "masterBall", words: ["masterball"] };
  if (h.includes("friend ball")) return { variant: "friendBall", words: ["friendball"] };
  if (h.includes("love ball")) return { variant: "loveBall", words: ["loveball"] };
  // A ball the scanner recognised as a ball but couldn't name. The list of
  // ball patterns grows every set — Poké and Master with Scarlet & Violet,
  // Friend and Love since — so "some ball" still gets to find the printing's
  // own row, which is the answer that carries a real price.
  if (h.includes("ball pattern")) return { variant: null, words: ["ball"] };
  return null;
}

/** The finishes worth offering for this card. */
export function manualVariantsFor(card: { name: string }): string[] {
  return isSpecificPrinting(card.name) ? [] : [...MANUAL_VARIANTS];
}

export function variantLabel(variant: string): string {
  return (
    VARIANT_LABELS[variant] ??
    variant.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

/** The order finishes are offered in, so a dropdown doesn't reshuffle itself
 *  as price data arrives. Anything unrecognised keeps its own order after. */
const FINISH_ORDER = ["normal", "holofoil", "reverseHolofoil"];

/** Finishes that exist for a card.
 *
 *  A PRICE KEY IS NOT THE SAME QUESTION. This read the keys of the price map
 *  and answered with those, which conflates "finishes we have a price for"
 *  with "finishes this card was printed in" — and the two came apart the
 *  moment the paid source started pricing cards. That source returns ONE
 *  number and the printing it belongs to, so a card it priced ends up with
 *  {normal: 0.06} and nothing else, and the dropdown stopped offering
 *  Reverse Holo for an ordinary Rare that plainly has one. Cards got worse
 *  options as the pricing got better, which is the wrong way round.
 *
 *  So the price keys are a hint, added to what the RARITY implies:
 *
 *    Common / Uncommon / Rare  → Normal and Reverse Holo
 *    Holo Rare                 → Holofoil and Reverse Holo (no plain)
 *
 *  Everything above that — ex, V, full arts, illustration and secret rares —
 *  comes in one finish, so nothing is added and the keys stand alone. Named
 *  printings ("(Poké Ball Pattern)") are their own product and get nothing
 *  added either; the name IS the finish.
 *
 *  Erring toward offering one finish too many is deliberate. An option
 *  nobody picks costs a line in a menu; a missing one means somebody cannot
 *  record the card they are holding. */
export function availableVariants(card: {
  prices?: Record<string, number | null> | null;
  rarity?: string | null;
  name?: string;
}): string[] {
  const out = new Set<string>(card.prices ? Object.keys(card.prices) : []);

  const named = typeof card.name === "string" && isSpecificPrinting(card.name);
  const r = (card.rarity ?? "").toLowerCase();
  if (!named && r) {
    const reverse = !/reverse/.test(r);
    if (/holo/.test(r) && !/reverse/.test(r)) {
      out.add("holofoil");
      if (reverse) out.add("reverseHolofoil");
    } else if (/^(common|uncommon|rare)$/.test(r.trim())) {
      out.add("normal");
      out.add("reverseHolofoil");
    }
  }

  if (out.size === 0) return [...FINISH_ORDER];
  return [...out].sort((a, b) => {
    const ai = FINISH_ORDER.indexOf(a);
    const bi = FINISH_ORDER.indexOf(b);
    return (ai < 0 ? FINISH_ORDER.length : ai) - (bi < 0 ? FINISH_ORDER.length : bi);
  });
}

/** Best default finish given the card + what the scanner thought it saw. */
export function defaultVariantFor(
  card: {
    prices?: Record<string, number | null> | null;
    rarity?: string | null;
    /** Used only to tell a named printing from a plain card — the manual
     *  finishes are meaningless on a row that IS one of them. */
    name?: string;
  },
  rarityHint?: string | null
): string {
  const avail = availableVariants(card);
  const hint = (rarityHint ?? "").toLowerCase();
  // Stamped versions take priority — the stamp is the defining feature
  if (hint.includes("center") || hint.includes("pokemon center")) return "pcStamp";
  if (hint.includes("prerelease")) return "prereleaseStamp";
  if (hint.includes("staff")) return "staffStamp";
  // A ball-pattern reverse holo, when the scanner read one and the card has
  // no separate row of its own. On a card that DOES have one, the scan swaps
  // to that row before this runs and the name carries the printing instead.
  if (hint.includes("poke ball") || hint.includes("poké ball")) return "pokeBall";
  if (hint.includes("master ball")) return "masterBall";
  if (hint.includes("friend ball")) return "friendBall";
  if (hint.includes("love ball")) return "loveBall";
  // The scanner explicitly saw NO foil ("matte") — trust it when possible
  // "matte" is only believable on a card that HAS a plain printing. On a
  // full art or an ex it is the light, not the card.
  if (hint.includes("matte") && avail.includes("normal")) return "normal";
  if (hint.includes("matte") && avail.length === 1) return avail[0];
  if (hint.includes("reverse") && avail.includes("reverseHolofoil")) return "reverseHolofoil";
  if (hint.includes("holo") && avail.includes("holofoil")) return "holofoil";
  // Database veto: the scanner saw foil, but this printing only exists as
  // reverse holo — the shine it saw must be the reverse pattern.
  if (hint.includes("holo") && !avail.includes("holofoil") && avail.includes("reverseHolofoil"))
    return "reverseHolofoil";
  const rarity = (card.rarity ?? "").toLowerCase();
  if (rarity.includes("holo") && !avail.includes("normal") && avail.includes("holofoil"))
    return "holofoil";

  // THE CARD VETOES A FINISH IT DOESN'T COME IN.
  //
  // Glare is the scanner's hardest problem: a matte card under a bright
  // light and a foil card at the wrong angle look alike, and the model is
  // told to answer 'unknown' rather than guess. But the CARD often settles
  // it. An ultra rare has no plain printing, so "normal" on one is not a
  // reading, it is a missing reading — and answering with the only finish
  // that exists is right for the same reason a Rare Holo can't be normal.
  //
  // Only fires where there is exactly one candidate left. Two possible
  // finishes and an unreadable photo is a genuine question, and it goes to
  // the member as one.
  if (avail.length === 1) return avail[0];
  if (avail.includes("normal")) return "normal";
  return avail[0];
}

/** A finish's price, and whether it is actually THAT finish's price.
 *
 *  priceForVariant falls back to the card's headline number for any finish
 *  the price map doesn't cover, which is the right value to show — it is the
 *  best estimate available — but the UI was labelling it "Market (Reverse
 *  Holo)", stating a measurement the app does not have. A reverse holo
 *  routinely trades at several times a normal, so that mislabel is not a
 *  rounding error.
 *
 *  `exact` is false when the number came from the fallback, so a caller can
 *  say "across all finishes" instead of naming one. */
export function variantPrice(
  card: { prices?: Record<string, number | null> | null; market_price?: number | null },
  variant: string
): { value: number | null; exact: boolean } {
  const own = card.prices?.[variant];
  if (own != null) return { value: own, exact: true };
  return { value: card.market_price ?? null, exact: false };
}

/** USD price for a specific finish, falling back to the headline price. */
export function priceForVariant(
  card: { prices?: Record<string, number | null> | null; market_price?: number | null },
  variant: string
): number | null {
  return card.prices?.[variant] ?? card.market_price ?? null;
}

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "moderator" | "member";
  /** Opt-in: collection visible to other members (for browsing & trades). */
  share_collection?: boolean;
  /** Monthly AI spend cap in USD (admins are never capped). */
  ai_budget_usd?: number | null;
  /** Suspended members can't sign in or use the app. */
  suspended?: boolean;
  /** When the member accepted the Terms of Service (null = must accept at next login). */
  tos_accepted_at?: string | null;
  /** Billing (migrations 026/027). All optional — older databases lack them,
   *  and every reader falls back to the free plan. */
  plan?: "free" | "pro" | "family";
  trade_board_enabled?: boolean;
  /** Friend codes (migration 028). The code is how someone reaches you; the
   *  flag is whether anyone may, and it gates sending as well as receiving. */
  friend_code?: string | null;
  allow_friend_requests?: boolean;
  stripe_customer?: string | null;
  stripe_subscription?: string | null;
  /** Set while a cancellation is pending: paid access runs to this date. */
  plan_expires_at?: string | null;
  /** True when an admin granted the plan rather than it being paid for.
   *  Kept out of revenue: staff aren't customers. */
  plan_comped?: boolean;
  /** Stripe billing-period start; credit cycles anchor here once present. */
  billing_anchor?: string | null;
  created_at: string;
}

export interface DeckCardEntry {
  name: string;
  quantity: number;
  category: "pokemon" | "trainer" | "energy";
  card_id: string | null;
  reason: string | null;
}

export interface DeckSuggestion {
  name: string;
  quantity: number;
  reason: string;
  card?: CardSummary | null;
  /** Group members (sharing their collection) who own copies — trade
   *  before you buy. */
  owners?: Array<{ userId: string; name: string; qty: number }>;
  /** Where "buy it" points — a TCGplayer product/search URL, affiliate-
   *  wrapped when the program link is configured (see lib/buyLink). */
  buyUrl?: string;
}

export interface Deck {
  id: string;
  user_id: string;
  name: string;
  strategy: string | null;
  cards: DeckCardEntry[];
  suggestions?: DeckSuggestion[];
  /** Visible read-only to other members when true. */
  shared?: boolean;
  /** Who a shared deck is visible to: the whole group or accepted pals only. */
  share_scope?: "everyone" | "friends";
  /** Set only on decks belonging to someone else in your family, where the
   *  whole point is knowing whose it is. Never stored — the API fills it in. */
  owner_name?: string;
  created_at: string;
}

export function rowToSummary(row: CardSummaryRow): CardSummary {
  return {
    id: row.id,
    name: row.name,
    supertype: row.supertype,
    subtypes: row.subtypes ?? [],
    types: row.types ?? [],
    hp: row.hp,
    number: row.number,
    rarity: row.rarity,
    setId: row.set_id,
    setName: row.set_name,
    setSeries: row.set_series,
    setPrintedTotal: row.set_printed_total,
    releaseDate: row.release_date,
    imageSmall: row.image_small,
    imageLarge: row.image_large,
    marketPrice: row.market_price,
    prices: row.prices ?? null,
  };
}

/** Words that stay upper-case when a rarity is title-cased. */
const RARITY_ACRONYMS = new Set(["ace", "spec", "gx", "ex", "v", "vmax", "vstar", "lv"]);

/** The card databases disagree on capitalisation: pokemontcg.io writes
 *  "Double Rare" and "Illustration Rare", TCGdex writes "Double rare" and
 *  "Illustration rare". Stored verbatim they became separate entries in the
 *  rarity filter — two "Double Rare" options, each holding half the cards.
 *  One spelling wins so they group together. */
export function canonicalRarity(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  return s
    .split(" ")
    .map((word) =>
      RARITY_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(" ");
}

export function summaryToRow(c: CardSummary): Omit<CardSummaryRow, "price_updated_at"> & { price_updated_at: string } {
  return {
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    hp: c.hp,
    number: c.number,
    rarity: canonicalRarity(c.rarity),
    set_id: c.setId,
    set_name: c.setName,
    set_series: c.setSeries,
    set_printed_total: c.setPrintedTotal,
    release_date: c.releaseDate,
    image_small: c.imageSmall,
    image_large: c.imageLarge,
    market_price: c.marketPrice,
    prices: c.prices,
    price_updated_at: new Date().toISOString(),
    // Kept whenever the source supplied it. Stripped again by gapFill when
    // it is null, so a source with no text can never blank text another
    // source found.
    ...(c.battleData ? { battle_data: c.battleData } : {}),
  };
}
