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
};

/** Stamped versions exist physically but not as separate database entries —
 *  the databases key on set+number, and a stamp doesn't change the number.
 *  We track them as finishes; prices fall back to the unstamped market value. */
export const STAMP_VARIANTS = ["pcStamp", "prereleaseStamp", "staffStamp"] as const;

export function variantLabel(variant: string): string {
  return (
    VARIANT_LABELS[variant] ??
    variant.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

/** Finishes known to exist for a card (from TCGplayer price keys), with a
 *  sensible fallback when no price data exists. */
export function availableVariants(card: {
  prices?: Record<string, number | null> | null;
}): string[] {
  const keys = card.prices ? Object.keys(card.prices) : [];
  if (keys.length > 0) return keys;
  return ["normal", "holofoil", "reverseHolofoil"];
}

/** Best default finish given the card + what the scanner thought it saw. */
export function defaultVariantFor(
  card: { prices?: Record<string, number | null> | null; rarity?: string | null },
  rarityHint?: string | null
): string {
  const avail = availableVariants(card);
  const hint = (rarityHint ?? "").toLowerCase();
  // Stamped versions take priority — the stamp is the defining feature
  if (hint.includes("center") || hint.includes("pokemon center")) return "pcStamp";
  if (hint.includes("prerelease")) return "prereleaseStamp";
  if (hint.includes("staff")) return "staffStamp";
  if (hint.includes("reverse") && avail.includes("reverseHolofoil")) return "reverseHolofoil";
  if (hint.includes("holo") && avail.includes("holofoil")) return "holofoil";
  const rarity = (card.rarity ?? "").toLowerCase();
  if (rarity.includes("holo") && !avail.includes("normal") && avail.includes("holofoil"))
    return "holofoil";
  if (avail.includes("normal")) return "normal";
  return avail[0];
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
  role: "admin" | "member";
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
}

export interface Deck {
  id: string;
  user_id: string;
  name: string;
  strategy: string | null;
  cards: DeckCardEntry[];
  suggestions?: DeckSuggestion[];
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

export function summaryToRow(c: CardSummary): Omit<CardSummaryRow, "price_updated_at"> & { price_updated_at: string } {
  return {
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    types: c.types,
    hp: c.hp,
    number: c.number,
    rarity: c.rarity,
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
  };
}
