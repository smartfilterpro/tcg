import { createAdminClient } from "@/lib/supabase/admin";
import { getCardById } from "@/lib/pokemontcg";
import { getTcgdexPriceById } from "@/lib/tcgdex";
import { poketraceEnabled, searchPoketraceCard, getPoketracePrices } from "@/lib/poketrace";

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
  /** PokeTrace source stats (present only when POKETRACE_API_KEY is set). */
  pt?: {
    matched: number;
    unmatched: number;
    priced: number;
    requests: number;
    error?: string;
  } | null;
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
    // Custom entries have no API price source — unless PokeTrace can try a
    // name+number search for them.
    (id) => !id.startsWith("custom-") || poketraceEnabled()
  );
  if (ownedIds.length === 0) return summary;

  // select("*") — poketrace_id/graded_prices only exist after migration 023
  const { data: cards, error: cardsErr } = await admin
    .from("cards")
    .select("*")
    .in("id", ownedIds);
  if (cardsErr) throw cardsErr;

  // Stalest first; never-priced cards lead.
  const queue = (cards ?? [])
    .sort((a, b) => (a.price_updated_at ?? "").localeCompare(b.price_updated_at ?? ""))
    .slice(0, limit);

  // PokeTrace usage budget per run: with the free plan's 1-req/2s pacing,
  // ~80 requests ≈ 3 minutes — fits the admin route's time limit and stays
  // far inside the 250/day cap even with a manual run on top of the nightly.
  const PT_BUDGET = 80;
  const pt = poketraceEnabled()
    ? { matched: 0, unmatched: 0, priced: 0, requests: 0, error: undefined as string | undefined }
    : null;

  const BATCH = 4;
  for (let i = 0; i < queue.length; i += BATCH) {
    await Promise.all(
      queue.slice(i, i + BATCH).map(async (card) => {
        try {
          // PokeTrace first (when configured): id cached on the card after
          // the one-time search, so steady state is one request per card.
          let ptMarket: number | null = null;
          if (pt && !pt.error && pt.requests < PT_BUDGET) {
            try {
              const hasIdColumn = "poketrace_id" in card;
              let pid = (card.poketrace_id as string | null | undefined) ?? null;
              if (!pid) {
                const found = await searchPoketraceCard(
                  card.name as string,
                  (card.number as string | null) ?? null,
                  (card.set_name as string | null) ?? null
                );
                pt.requests += found.requests;
                pid = found.id;
                if (pid) pt.matched += 1;
                else pt.unmatched += 1;
                if (hasIdColumn) {
                  await admin
                    .from("cards")
                    .update({ poketrace_id: pid ?? "unmatched" })
                    .eq("id", card.id)
                    .then(() => {});
                }
              }
              if (pid && pid !== "unmatched") {
                pt.requests += 1;
                const prices = await getPoketracePrices(pid);
                if (prices?.market != null) {
                  ptMarket = prices.market;
                  pt.priced += 1;
                }
                if (prices?.graded && "graded_prices" in card) {
                  await admin
                    .from("cards")
                    .update({ graded_prices: prices.graded })
                    .eq("id", card.id)
                    .then(() => {});
                }
              }
            } catch (e) {
              pt.error ??= e instanceof Error ? e.message : "PokeTrace error";
            }
          }

          let nextMarket: number | null = null;
          let nextPrices: Record<string, number | null> | null = null;
          if ((card.id as string).startsWith("tcgdex-")) {
            nextMarket = await getTcgdexPriceById(card.id as string);
          } else if (!(card.id as string).startsWith("custom-")) {
            const fresh = await getCardById(card.id as string);
            nextMarket = fresh?.marketPrice ?? null;
            nextPrices = fresh?.prices ?? null;
          }
          // PokeTrace's daily-updated market number wins when it exists.
          if (ptMarket != null) nextMarket = ptMarket;
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

  if (pt) summary.pt = pt;

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
    const value = data.value as Partial<PriceRefreshSummary> | null;
    // The loop's claim upsert creates the row with an EMPTY value before the
    // first run finishes — that's not a summary yet.
    if (!value || typeof value.ranAt !== "string") return null;
    return {
      ranAt: value.ranAt,
      checked: value.checked ?? 0,
      updated: value.updated ?? 0,
      unpriced: value.unpriced ?? 0,
      suspicious: Array.isArray(value.suspicious) ? value.suspicious : [],
      pt: value.pt ?? null,
    };
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
