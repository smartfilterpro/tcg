// The competitive meta, joined against what a member actually owns.
//
// meta_decks (migration 068) holds one row per archetype — real tournament
// results pulled nightly, or rows an admin curated by hand. This module is
// the read side: it resolves each archetype's card names against the
// catalogue and the member's collection, so the trending page can say the
// only genuinely useful sentence in this feature: "you own 43 of the 60
// cards, the missing 17 cost about $31, and two of them are sitting in your
// household already."
//
// Names, not card ids, throughout. A meta deck is "4 Charizard ex" — any
// printing satisfies it — so everything joins on the same normalized name
// key the scanner uses (migration 066), with a graceful degrade to
// no-prices when that migration hasn't run yet.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/fetchAll";
import { normalizeForSearch } from "@/lib/text";
import { buyLinkFor } from "@/lib/buyLink";

export interface MetaCoreCard {
  name: string;
  count: number;
  category?: "pokemon" | "trainer" | "energy";
}

export interface MetaDeckRow {
  id: string;
  archetype: string;
  format: string;
  share: number | null;
  placements: number | null;
  core_cards: MetaCoreCard[];
  source: "curated" | "limitless";
  window_days: number | null;
  notes: string | null;
  updated_at: string;
}

export interface MetaCardView extends MetaCoreCard {
  /** Copies of this name the member owns, capped at the deck's count. */
  owned: number;
  /** Cheapest catalogue market price for any printing of the name. */
  price: number | null;
  image: string | null;
  /** Household members / sharing friends holding copies, best two. */
  heldBy: Array<{ name: string; qty: number }>;
  /** Where to buy the missing copies (only set when some are missing). */
  buyUrl?: string;
}

export interface MetaDeckView {
  id: string;
  archetype: string;
  format: string;
  share: number | null;
  placements: number | null;
  source: "curated" | "limitless";
  windowDays: number | null;
  notes: string | null;
  updatedAt: string;
  cards: MetaCardView[];
  ownedCount: number;
  totalCount: number;
  missingCount: number;
  /** Dollars to buy every missing copy that has a known price. */
  missingCost: number;
  /** Missing copies with NO known price — shown so the cost is honest. */
  unpricedMissing: number;
}

/** "4 Charizard ex" / "3x Iono" / "Iono" — one card per line. Lines that
 *  don't parse are reported back rather than silently dropped: a curated
 *  meta deck with a missing card is wrong in a way nobody would notice. */
export function parseCardLines(text: string): { cards: MetaCoreCard[]; bad: string[] } {
  const cards: MetaCoreCard[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/i);
    const count = m ? parseInt(m[1], 10) : 1;
    const name = (m ? m[2] : line).trim();
    if (!name || count < 1 || count > 60) {
      bad.push(raw);
      continue;
    }
    cards.push({ name, count });
  }
  return { cards, bad };
}

const CHUNK = 100;

/** Cheapest known printing per name key, plus an image and the resolved
 *  card ids (for the who-else-owns-it join). Empty maps pre-066. */
async function catalogueByNameKey(
  admin: SupabaseClient,
  keys: string[]
): Promise<{
  price: Map<string, number>;
  image: Map<string, string>;
  idsByKey: Map<string, string[]>;
  keyById: Map<string, string>;
  tcgpIdByKey: Map<string, string>;
}> {
  const price = new Map<string, number>();
  const image = new Map<string, string>();
  const idsByKey = new Map<string, string[]>();
  const keyById = new Map<string, string>();
  const tcgpIdByKey = new Map<string, string>();
  try {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const { data, error } = await admin
        .from("cards")
        .select("id, name, market_price, image_small, tcgplayer_id")
        .in("name_key", keys.slice(i, i + CHUNK))
        .limit(1000);
      if (error) throw error;
      for (const row of data ?? []) {
        const k = normalizeForSearch((row.name as string) ?? "");
        const p = row.market_price as number | null;
        const priced = p != null && p > 0 && (!price.has(k) || p < price.get(k)!);
        if (priced) price.set(k, p!);
        if (!image.has(k) && row.image_small) image.set(k, row.image_small as string);
        // The buy link follows the price: when this printing supplied the
        // number shown, its product page is the page that number came from.
        if (row.tcgplayer_id != null && (priced || !tcgpIdByKey.has(k))) {
          tcgpIdByKey.set(k, String(row.tcgplayer_id));
        }
        const list = idsByKey.get(k);
        if (list) list.push(row.id as string);
        else idsByKey.set(k, [row.id as string]);
        keyById.set(row.id as string, k);
      }
    }
  } catch {
    // Pre-066: no name_key column. Coverage still works off the member's
    // own collection names; prices and helpers just stay blank.
  }
  return { price, image, idsByKey, keyById, tcgpIdByKey };
}

/** People whose collections may cover a gap: the member's household, plus
 *  members sharing their collection. Returns id → display name. */
async function helperNames(
  admin: SupabaseClient,
  userId: string
): Promise<Map<string, string>> {
  const helpers = new Map<string, string>();
  const nameOf = (p: { display_name?: string | null; email?: string | null }) =>
    ((p.display_name ?? "").trim() || (p.email ?? "").split("@")[0]) as string;
  try {
    const { data: me } = await admin
      .from("family_members")
      .select("group_id")
      .eq("user_id", userId)
      .maybeSingle();
    const familyIds: string[] = [];
    if (me) {
      const { data: members } = await admin
        .from("family_members")
        .select("user_id")
        .eq("group_id", me.group_id);
      for (const m of members ?? []) {
        if (m.user_id !== userId) familyIds.push(m.user_id as string);
      }
    }
    const { data: sharers } = await admin
      .from("profiles")
      .select("id, display_name, email")
      .eq("share_collection", true)
      .neq("id", userId);
    const wanted = new Set([...familyIds, ...(sharers ?? []).map((s) => s.id as string)]);
    if (wanted.size === 0) return helpers;
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, display_name, email")
      .in("id", [...wanted]);
    for (const p of profiles ?? []) helpers.set(p.id as string, nameOf(p));
  } catch {
    // Helpers are a garnish — coverage and cost stand without them.
  }
  return helpers;
}

/** Every meta deck, with this member's coverage folded in. */
export async function metaDecksFor(userId: string): Promise<{
  decks: MetaDeckView[];
  hasLimitless: boolean;
}> {
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("meta_decks")
    .select("*")
    .order("share", { ascending: false, nullsFirst: false })
    .order("archetype");
  if (error) throw error;
  const decks = (rows ?? []) as unknown as MetaDeckRow[];
  if (decks.length === 0) return { decks: [], hasLimitless: false };

  // What the member owns, by name key: one paged query for the whole
  // collection, quantities summed across printings and finishes.
  const ownedByKey = new Map<string, number>();
  type OwnedRow = { quantity: number; card: { name: string } | Array<{ name: string }> | null };
  const { data: mine } = await fetchAllRows<OwnedRow>(
    () =>
      admin
        .from("collection_items")
        .select("quantity, card:cards(name)")
        .eq("user_id", userId)
        .order("created_at")
        .order("id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: OwnedRow[] | null;
          error: { message: string } | null;
        }>;
      }
  );
  for (const item of mine ?? []) {
    // supabase-js types the embedded relation as an array; at runtime a
    // to-one join is an object. Read either shape.
    const rel = item.card;
    const name = Array.isArray(rel) ? rel[0]?.name : rel?.name;
    if (!name) continue;
    const k = normalizeForSearch(name);
    ownedByKey.set(k, (ownedByKey.get(k) ?? 0) + (item.quantity ?? 0));
  }

  const allKeys = [
    ...new Set(
      decks.flatMap((d) =>
        (Array.isArray(d.core_cards) ? d.core_cards : []).map((c) => normalizeForSearch(c.name))
      )
    ),
  ].filter(Boolean);
  const { price, image, idsByKey, keyById, tcgpIdByKey } = await catalogueByNameKey(
    admin,
    allKeys
  );

  // Who else could cover a gap — household first, sharing friends after.
  const helpers = await helperNames(admin, userId);
  const heldByKey = new Map<string, Map<string, number>>(); // key → helperId → qty
  if (helpers.size > 0 && keyById.size > 0) {
    try {
      const cardIds = [...keyById.keys()];
      for (let i = 0; i < cardIds.length; i += CHUNK) {
        const { data: held } = await admin
          .from("collection_items")
          .select("user_id, card_id, quantity")
          .in("card_id", cardIds.slice(i, i + CHUNK))
          .in("user_id", [...helpers.keys()])
          .limit(1000);
        for (const h of held ?? []) {
          const k = keyById.get(h.card_id as string);
          if (!k) continue;
          const perHelper = heldByKey.get(k) ?? new Map<string, number>();
          perHelper.set(
            h.user_id as string,
            (perHelper.get(h.user_id as string) ?? 0) + ((h.quantity as number) ?? 0)
          );
          heldByKey.set(k, perHelper);
        }
      }
    } catch {
      // Same stance as helperNames: never the reason the page fails.
    }
  }

  const views = decks.map((d): MetaDeckView => {
    const cards = (Array.isArray(d.core_cards) ? d.core_cards : []).map(
      (c): MetaCardView => {
        const k = normalizeForSearch(c.name);
        const owned = Math.min(c.count, ownedByKey.get(k) ?? 0);
        const holders = [...(heldByKey.get(k) ?? new Map<string, number>()).entries()]
          .filter(([, qty]) => qty > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([id, qty]) => ({ name: helpers.get(id) ?? "A member", qty }));
        return {
          ...c,
          owned,
          price: price.get(k) ?? null,
          image: image.get(k) ?? null,
          heldBy: holders,
          ...(owned < c.count
            ? { buyUrl: buyLinkFor({ tcgplayerId: tcgpIdByKey.get(k) ?? null, name: c.name }) }
            : {}),
        };
      }
    );
    const totalCount = cards.reduce((s, c) => s + c.count, 0);
    const ownedCount = cards.reduce((s, c) => s + c.owned, 0);
    let missingCost = 0;
    let unpricedMissing = 0;
    for (const c of cards) {
      const gap = c.count - c.owned;
      if (gap <= 0) continue;
      if (c.price != null) missingCost += gap * c.price;
      else unpricedMissing += gap;
    }
    return {
      id: d.id,
      archetype: d.archetype,
      format: d.format,
      share: d.share == null ? null : Number(d.share),
      placements: d.placements,
      source: d.source,
      windowDays: d.window_days,
      notes: d.notes,
      updatedAt: d.updated_at,
      cards,
      ownedCount,
      totalCount,
      missingCount: totalCount - ownedCount,
      missingCost: Math.round(missingCost * 100) / 100,
      unpricedMissing,
    };
  });

  return { decks: views, hasLimitless: decks.some((d) => d.source === "limitless") };
}
