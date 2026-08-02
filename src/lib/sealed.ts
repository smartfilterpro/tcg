// Sealed product: types, and what one is worth.
//
// Pricing sealed is a different problem from pricing a card, and the card
// path cannot be reused for it. eBay's card search deliberately EXCLUDES
// titles containing "booster box", "tin", "bundle" — those words mean "not
// the single card you asked for". Pointing that filter at a booster box
// rejects every correct result and keeps only the wrong ones.
//
// So this has its own search and its own exclusions, built around the ways a
// sealed listing lies: an empty box, a box "opened but complete", a lone
// promo card pulled from the product, a code card.

import { ebayEnabled, ebayFetch, marketplace, SCOPE_BASE } from "@/lib/ebay";
import { trackerSealedById, trackerSealedByName } from "@/lib/sealedTracker";

export const SEALED_KINDS = [
  "booster_box",
  "etb",
  "booster_bundle",
  "booster_pack",
  "tin",
  "collection_box",
  "blister",
  "other",
] as const;

export type SealedKind = (typeof SEALED_KINDS)[number];

export function sealedKindLabel(kind: string): string {
  switch (kind) {
    case "booster_box":
      return "Booster box";
    case "etb":
      return "Elite Trainer Box";
    case "booster_bundle":
      return "Booster bundle";
    case "booster_pack":
      return "Booster pack";
    case "tin":
      return "Tin";
    case "collection_box":
      return "Collection box";
    case "blister":
      return "Blister pack";
    default:
      return "Other";
  }
}

export const SEALED_CONDITIONS = ["sealed", "opened", "damaged"] as const;

export interface SealedProduct {
  id: string;
  name: string;
  kind: string;
  set_name: string | null;
  release_year: number | null;
  image_url: string | null;
  market_price: number | null;
  price_updated_at: string | null;
  price_source: string | null;
}

export interface SealedItem {
  id: string;
  user_id: string;
  product_id: string;
  quantity: number;
  condition: string;
  price_override: number | null;
  notes: string | null;
  created_at: string;
  product: SealedProduct;
}

/** What one of these is worth to its owner: their own figure if they set
 *  one, otherwise the market price. Same rule as cards, so the two totals
 *  mean the same thing. */
export function sealedItemPrice(item: {
  price_override?: number | null;
  product?: { market_price?: number | null } | null;
}): number | null {
  if (item.price_override != null) return item.price_override;
  return item.product?.market_price ?? null;
}

/* ------------------------------------------------------------- pricing */

/** Titles that are not the sealed product, however well they match the
 *  name. Each of these is a real way a sealed search goes wrong. */
const NOT_SEALED = [
  /\bempty\b/i,
  /\bno\s+(?:packs?|cards?|booster)/i,
  /\bbox\s+only\b/i,
  /\bopened\b/i,
  /\bresealed\b/i,
  /\bcode\s+cards?\b/i,
  /\bproxy\b/i,
  /\bcustom\b/i,
  /\bpromo\s+card\s+only\b/i,
  // A lot of five boxes prices five boxes, not one.
  /\blot\s+of\b/i,
  /\bx\s?[2-9]\d*\b/i,
  /\b[2-9]\d*\s?x\b/i,
];

const MIN_CREDIBLE = 1;

function credible(title: string, name: string): boolean {
  if (NOT_SEALED.some((re) => re.test(title))) return false;
  // Every significant word of the product name has to appear, so a search
  // for a specific set's box doesn't settle on a different set's.
  const haystack = title.toLowerCase();
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .every((w) => haystack.includes(w));
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SealedPrice {
  median: number;
  low: number;
  count: number;
  currency: string;
  source: string;
  /** A picture of the product, from the same search. Costs nothing extra —
   *  eBay returns an image with every item summary, and we were discarding
   *  it. Taken from the listing NEAREST THE MEDIAN rather than the first or
   *  the cheapest: the cheapest listing is the one most likely to be a
   *  misdescribed single pack or a photo of an empty box, and its picture
   *  would be wrong in exactly the same way its price is. */
  image?: string | null;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: SealedPrice | null }>();

/** Asking prices for one sealed product.
 *
 *  The MEDIAN is what's kept, not the lowest. The cheapest listing for a
 *  booster box is very often a scam, a misdescribed single pack, or an
 *  auction-adjacent bait price, and sealed has fewer listings than cards so
 *  one bad one moves a minimum a long way. The median of credible listings
 *  is the number a person would actually pay.
 *
 *  Null when eBay is off, the search fails, or nothing survives filtering —
 *  all three mean "say nothing", never "show a zero". */
export async function sealedPrice(query: {
  name: string;
  kind?: string | null;
}): Promise<SealedPrice | null> {
  if (!ebayEnabled()) return null;

  const terms = ["pokemon", query.name, "sealed"].filter(Boolean).join(" ");
  const key = `${marketplace()}|${terms}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let items: Array<Record<string, unknown>> = [];
  try {
    const json = await ebayFetch("/buy/browse/v1/item_summary/search", {
      params: {
        q: terms,
        limit: 50,
        // Fixed price only: a running auction's current bid is not the price.
        filter: "buyingOptions:{FIXED_PRICE}",
      },
      scopes: [SCOPE_BASE],
    });
    items = (json.itemSummaries as Array<Record<string, unknown>>) ?? [];
  } catch {
    // Not cached — a transient failure shouldn't suppress pricing for six
    // hours.
    return null;
  }

  // Kept together so the image can be taken from the SAME listing that
  // sets the median, rather than from whichever credible one happened to
  // come back first.
  const credibleItems: Array<{ total: number; image: string | null }> = [];
  let currency = "USD";
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title : "";
    if (!title || !credible(title, query.name)) continue;
    const price = item.price as { value?: string; currency?: string } | undefined;
    const value = Number(price?.value);
    if (!Number.isFinite(value) || value < MIN_CREDIBLE) continue;
    const shipping = (item.shippingOptions as Array<{ shippingCost?: { value?: string } }>) ?? [];
    const ship = Math.min(
      ...shipping.map((s) => Number(s.shippingCost?.value)).filter((n) => Number.isFinite(n)),
      Infinity
    );
    const img = (item.image as { imageUrl?: string } | undefined)?.imageUrl;
    const thumb = (item.thumbnailImages as Array<{ imageUrl?: string }> | undefined)?.[0]?.imageUrl;
    credibleItems.push({
      total: value + (Number.isFinite(ship) ? ship : 0),
      image: typeof img === "string" ? img : typeof thumb === "string" ? thumb : null,
    });
    currency = price?.currency ?? currency;
  }
  const totals = credibleItems.map((c) => c.total);

  if (totals.length === 0) {
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
  const ranked = [...credibleItems].sort((a, b) => a.total - b.total);
  totals.sort((a, b) => a - b);
  // The middle listing: the one whose price we are quoting, so the picture
  // and the number describe the same thing.
  const middle = ranked[Math.floor(ranked.length / 2)];
  const result: SealedPrice = {
    median: Math.round(median(totals) * 100) / 100,
    low: Math.round(totals[0] * 100) / 100,
    count: totals.length,
    currency,
    source: "eBay listings",
    image: middle?.image ?? ranked.find((r) => r.image)?.image ?? null,
  };
  cache.set(key, { at: Date.now(), value: result });
  return result;
}

/* --------------------------------------------------- persisting a price */

/** Look a product's market value up and record it against the shared row.
 *
 *  Best-effort throughout: a product with no price is the status quo, not a
 *  failure, and nothing the caller is doing should fail because a price
 *  lookup did. Lives here rather than beside the route that first needed it
 *  — route files may only export request handlers, and a helper hiding in
 *  one is a helper nobody else can call. */
export async function priceProduct(
  productId: string,
  name: string,
  kind: string | null
): Promise<number | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: current } = await admin
      .from("sealed_products")
      .select("image_url, tcgplayer_id")
      .eq("id", productId)
      .maybeSingle();

    const patch: Record<string, unknown> = { price_updated_at: new Date().toISOString() };
    let value: number | null = null;
    let image: string | null = null;

    // THE PAID CATALOGUE FIRST, for sealed only.
    //
    // The opposite of the order used for cards, and for a reason rather
    // than by accident: free sources go first when they hold the SAME data,
    // and here they hold worse data. This is a TCGplayer market price and
    // an official product shot; eBay is asking prices and seller photos.
    //
    // Exact when we know their id — no name matching, so a reprice cannot
    // drift onto a different box.
    const existingId = (current?.tcgplayer_id as string | null) ?? null;
    const fromTracker = existingId
      ? await trackerSealedById(existingId)
      : await trackerSealedByName(name);

    if (fromTracker?.price != null) {
      value = fromTracker.price;
      image = fromTracker.image;
      patch.price_source = "TCGplayer via Pokémon Price Tracker";
      patch.source = "pricetracker";
      if (!existingId && fromTracker.tcgPlayerId) patch.tcgplayer_id = fromTracker.tcgPlayerId;
      if (fromTracker.setId) patch.set_id = fromTracker.setId;
      if (fromTracker.setName) patch.set_name = fromTracker.setName;
    } else {
      // Nothing there — fall back to what is actually being asked for on
      // eBay. Worse data, but a real number beats no number.
      const listings = await sealedPrice({ name, kind });
      if (listings) {
        value = listings.median;
        image = listings.image ?? null;
        patch.price_source = `${listings.source} (${listings.count} listings)`;
        patch.source = "ebay";
      }
    }

    if (value == null) return null;
    patch.market_price = value;

    // Only fill a picture we don't have. Repricing runs every time somebody
    // presses Check price, and swapping the image on each run would mean a
    // product's photo changing under its owner for no reason.
    if (!current?.image_url && image) {
      patch.image_url = (await mirrorSealedImage(productId, image)) ?? image;
    }

    await admin.from("sealed_products").update(patch).eq("id", productId);
    return value;
  } catch {
    return null;
  }
}

/** Copy a listing photo into our own storage.
 *
 *  eBay image URLs point at a listing, and listings END — in weeks, often.
 *  Hotlinking one means every sealed product quietly loses its picture on a
 *  schedule nobody controls, which is precisely the decay that left whole
 *  sets of cards showing broken images. So the bytes are taken once and
 *  kept.
 *
 *  Reuses the card-art bucket under a sealed/ prefix rather than minting a
 *  second one: it is already public, already backed by the same storage,
 *  and one bucket to reason about beats two.
 *
 *  Null on any failure, and the caller falls back to the source URL — a
 *  picture that may expire later still beats no picture now. */
async function mirrorSealedImage(productId: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "image/*", "User-Agent": "TrainerDeck sealed art" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1_000 || buffer.length > 8_000_000) return null;

    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const path = `sealed/${productId}.${ext}`;
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { error } = await admin.storage
      .from("card-art")
      .upload(path, buffer, { contentType, upsert: true });
    if (error) return null;
    return admin.storage.from("card-art").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

/** One row in the add-product suggestion list. */
export interface SealedSuggestion {
  name: string;
  kind: string;
  kindLabel: string;
  setName: string | null;
  year: number | null;
  /** Where the suggestion came from, and they mean different things:
   *  "catalogue" — a product someone here already holds, so adding it joins
   *  that row rather than creating a near-duplicate. "tracker" — a real
   *  product from the paid database that nobody here holds yet.
   *  "suggested" — a name BUILT from a real set, which may not name a
   *  product that exists. */
  source: "catalogue" | "tracker" | "suggested";
  marketPrice?: number | null;
  /** Only ever set for products already in the catalogue — a generated
   *  suggestion has no picture until somebody adds it and it gets priced. */
  image?: string | null;
  /** The paid catalogue's product id, when the suggestion came from there.
   *  Passed back on add so the price can be fetched EXACTLY rather than
   *  searched for by name — and so the price stored for everyone is one the
   *  server fetched, never one a browser supplied. */
  tcgPlayerId?: string | null;
}
