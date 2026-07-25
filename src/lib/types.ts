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
  notes: string | null;
  created_at: string;
  updated_at: string;
  card: CardSummaryRow;
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
  price_updated_at: string | null;
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

export interface Deck {
  id: string;
  user_id: string;
  name: string;
  strategy: string | null;
  cards: DeckCardEntry[];
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
    price_updated_at: new Date().toISOString(),
  };
}
