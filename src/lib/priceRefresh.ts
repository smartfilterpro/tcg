import { createAdminClient } from "@/lib/supabase/admin";
import { getCardById } from "@/lib/pokemontcg";
import { getTcgdexPriceById } from "@/lib/tcgdex";

/** Background price refresher.
 *
 * Card prices were only ever fetched the day a card was first saved, so they
 * drift stale. This job re-checks the stalest prices of cards members
 * actually own, a slice per run, from the same legitimate sources we already
 * use (pokemontcg.io → TCGplayer/Cardmarket, TCGdex → Cardmarket). No
 * scraping, no AI cost.
 *
 * Wild price swings (>5× either way on a card worth $1+) are NOT applied
 * automatically — they're reported for the admin to eyeball, since a bad
 * API day shouldn't rewrite the group's collection values.
 */

export interface PriceRefreshSummary {
  ranAt: string;
  checked: number;
  updated: number;
  unpriced: number;
  suspicious: Array<{ id: string; name: string; old: number; next: number }>;
}

const STATE_KEY = "price_refresh";
const MIN_HOURS_BETWEEN_RUNS = 20;

export async function refreshStalePrices(limit = 120): Promise<PriceRefreshSummary> {
  const admin = createAdminClient();
  const summary: PriceRefreshSummary = {
    ranAt: new Date().toISOString(),
    checked: 0,
    updated: 0,
    unpriced: 0,
    suspicious: [],
  };

  // Only cards someone actually owns are worth refreshing.
  const { data: owned, error: ownedErr } = await admin
    .from("collection_items")
    .select("card_id")
    .limit(20000);
  if (ownedErr) throw ownedErr;
  const ownedIds = [...new Set((owned ?? []).map((r) => r.card_id as string))].filter(
    (id) => !id.startsWith("custom-") // custom entries have no price source
  );
  if (ownedIds.length === 0) return summary;

  const { data: cards, error: cardsErr } = await admin
    .from("cards")
    .select("id, name, market_price, price_updated_at")
    .in("id", ownedIds);
  if (cardsErr) throw cardsErr;

  // Stalest first; never-priced cards lead.
  const queue = (cards ?? [])
    .sort((a, b) => (a.price_updated_at ?? "").localeCompare(b.price_updated_at ?? ""))
    .slice(0, limit);

  const BATCH = 4;
  for (let i = 0; i < queue.length; i += BATCH) {
    await Promise.all(
      queue.slice(i, i + BATCH).map(async (card) => {
        try {
          let nextMarket: number | null = null;
          let nextPrices: Record<string, number | null> | null = null;
          if ((card.id as string).startsWith("tcgdex-")) {
            nextMarket = await getTcgdexPriceById(card.id as string);
          } else {
            const fresh = await getCardById(card.id as string);
            nextMarket = fresh?.marketPrice ?? null;
            nextPrices = fresh?.prices ?? null;
          }
          summary.checked += 1;

          const old = (card.market_price as number | null) ?? null;
          if (nextMarket == null && !nextPrices) {
            summary.unpriced += 1;
            // Still stamp the check so this card doesn't hog the queue.
            await admin
              .from("cards")
              .update({ price_updated_at: new Date().toISOString() })
              .eq("id", card.id);
            return;
          }
          if (
            old != null &&
            nextMarket != null &&
            old >= 1 &&
            (nextMarket > old * 5 || nextMarket < old / 5)
          ) {
            summary.suspicious.push({
              id: card.id as string,
              name: card.name as string,
              old,
              next: nextMarket,
            });
            return; // don't auto-apply a wild swing
          }

          const patch: Record<string, unknown> = {
            price_updated_at: new Date().toISOString(),
          };
          if (nextMarket != null) patch.market_price = nextMarket;
          if (nextPrices) patch.prices = nextPrices;
          const { error } = await admin.from("cards").update(patch).eq("id", card.id);
          if (!error) summary.updated += 1;
        } catch {
          // One bad card never stops the run.
        }
      })
    );
  }

  // Remember the run for the admin dashboard (best-effort — app_state exists
  // after migration 022).
  await admin
    .from("app_state")
    .upsert({ key: STATE_KEY, value: summary, updated_at: new Date().toISOString() })
    .then(() => {});

  return summary;
}

/** Read the last run's summary (null if never ran / table missing). */
export async function lastPriceRefresh(): Promise<PriceRefreshSummary | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("app_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    if (error || !data) return null;
    return data.value as PriceRefreshSummary;
  } catch {
    return null;
  }
}

/** Self-scheduling loop for the long-running Railway server: checks hourly,
 *  actually refreshes at most once per MIN_HOURS_BETWEEN_RUNS. A stamped
 *  claim in app_state keeps multiple instances from double-running. */
export function startPriceRefreshLoop() {
  const tick = async () => {
    try {
      const admin = createAdminClient();
      const cutoff = new Date(Date.now() - MIN_HOURS_BETWEEN_RUNS * 3600_000).toISOString();
      // Ensure the row exists, then claim it only if it's stale — zero rows
      // updated means another instance (or a recent run) beat us to it.
      await admin
        .from("app_state")
        .upsert({ key: STATE_KEY }, { onConflict: "key", ignoreDuplicates: true })
        .then(() => {});
      const { data: claimed, error } = await admin
        .from("app_state")
        .update({ updated_at: new Date().toISOString() })
        .eq("key", STATE_KEY)
        .lt("updated_at", cutoff)
        .select("key");
      if (error || !claimed || claimed.length === 0) return;
      const summary = await refreshStalePrices();
      console.log(
        `price refresh: checked ${summary.checked}, updated ${summary.updated}, ` +
          `${summary.suspicious.length} suspicious, ${summary.unpriced} without data`
      );
    } catch (err) {
      console.error("price refresh loop error", err);
    }
  };
  // First check shortly after boot, then hourly.
  setTimeout(tick, 90_000);
  setInterval(tick, 3600_000);
}
