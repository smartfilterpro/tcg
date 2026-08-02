import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCardById } from "@/lib/pokemontcg";
import { getTcgdexPriceById } from "@/lib/tcgdex";
import { poketraceEnabled, searchPoketraceCard, getPoketracePrices } from "@/lib/poketrace";
import { priceTrackerEnabled, priceTrackerMarketPrice } from "@/lib/priceTracker";
import { getBattleDataById } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { fetchAllRows } from "@/lib/fetchAll";

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
  /** Held price changes. Carries enough of the card to DECIDE — a name and
   *  two numbers can't answer "is $0.23 right for this Quaxly?", but the
   *  picture, set and collector number can. */
  suspicious: Array<{
    id: string;
    name: string;
    /** Printing details, topped up at read time when a stale run left
     *  them blank — a name and two numbers can't settle a price. */
    set?: string | null;
    number?: string | null;
    image?: string | null;
    rarity?: string | null;
    old: number;
    next: number;
  }>;
  /** PokeTrace source stats (present only when POKETRACE_API_KEY is set). */
  pt?: {
    matched: number;
    unmatched: number;
    priced: number;
    requests: number;
    error?: string;
  } | null;
  /** Cards whose printed text/combat data was cached this run. */
  textWarmed?: number;
  /** Priced by the paid tracker after the free sources had nothing. */
  trackerPriced?: number;
  /** Set when the run failed partway — shown in the admin panel. */
  error?: string;
}

const STATE_KEY = "price_refresh";

/** How long between runs once every owned card has a price. Prices move
 *  slowly; a daily pass is plenty for maintenance. */
const MIN_HOURS_BETWEEN_RUNS = 20;

/** …and how long while cards are still sitting with NO price at all. That
 *  is a backlog, not maintenance — a card someone scanned today showing no
 *  value is the app looking broken, and waiting a day per 400 cards to fix
 *  it is the wrong trade. Clears itself: once nothing is unpriced the loop
 *  falls back to the daily gap above. */
const BACKLOG_HOURS_BETWEEN_RUNS = 1;

/** @param limit how many stale cards to re-price this run.
 *  @param opts.ptBudget PokeTrace requests allowed. Its free plan caps the
 *    day, so a scheduled run takes a larger share than a manual one while
 *    still leaving room for someone pressing the button afterwards.
 *  @param opts.textBudget how many cards get their printed text warmed —
 *    the cache the deck builder, deck review and battles all read. */
export async function refreshStalePrices(
  // Raised from 120, which was sized for constraints that have since gone:
  // PokeTrace's free 250-a-day cap (still respected, but it is now one
  // source of four and capped separately), and an admin REQUEST timeout
  // that stopped applying when this moved onto the background loop. The
  // real limits now are politeness to the free APIs and wall-clock, and
  // 400 cards at four at a time with a breath between batches is a few
  // minutes of a process that has all night.
  limit = 400,
  opts?: { ptBudget?: number; textBudget?: number }
): Promise<PriceRefreshSummary> {
  const admin = createAdminClient();
  const summary: PriceRefreshSummary = {
    ranAt: new Date().toISOString(),
    checked: 0,
    updated: 0,
    unpriced: 0,
    suspicious: [],
  };

  try {
  // Only cards someone actually owns are worth refreshing. Paged — Supabase
  // caps responses at 1000 rows, which was hiding most owned cards from the
  // refresh rotation.
  const { data: owned, error: ownedErr } = await fetchAllRows(() =>
    admin.from("collection_items").select("card_id").order("created_at").order("id")
  );
  if (ownedErr) throw ownedErr;
  const ownedIds = [...new Set((owned ?? []).map((r) => r.card_id as string))].filter(
    // Custom entries have no API price source — unless PokeTrace can try a
    // name+number search for them.
    (id) => !id.startsWith("custom-") || poketraceEnabled()
  );
  if (ownedIds.length === 0) return summary;

  // select("*") — poketrace_id/graded_prices only exist after migration 023.
  // Chunked: a single .in() with thousands of ids overruns the URL limit and
  // the response would be capped at 1000 rows anyway.
  const cardChunks = [];
  const CHUNK = 200;
  for (let i = 0; i < ownedIds.length; i += CHUNK) {
    const { data: chunk, error: cardsErr } = await admin
      .from("cards")
      .select("*")
      .in("id", ownedIds.slice(i, i + CHUNK));
    if (cardsErr) throw cardsErr;
    cardChunks.push(chunk ?? []);
  }
  const cards = cardChunks.flat();

  // Stalest first; never-priced cards lead.
  const queue = (cards ?? [])
    .sort((a, b) => (a.price_updated_at ?? "").localeCompare(b.price_updated_at ?? ""))
    .slice(0, limit);

  // PokeTrace usage budget per run: with the free plan's 1-req/2s pacing,
  // ~80 requests ≈ 3 minutes — fits the admin route's time limit and stays
  // far inside the 250/day cap even with a manual run on top of the nightly.
  const PT_BUDGET = opts?.ptBudget ?? 80;
  const pt = poketraceEnabled()
    ? { matched: 0, unmatched: 0, priced: 0, requests: 0, error: undefined as string | undefined }
    : null;

  const BATCH = 4;
  for (let i = 0; i < queue.length; i += BATCH) {
    // A breath between batches. pokemontcg.io and TCGdex are free services
    // doing us a favour; a hundred back-to-back batches is not how to say
    // thank you, and the delay costs a background job nothing.
    if (i > 0) await new Promise((r) => setTimeout(r, 250));
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

          // Last resort, and the reason a scanned card stops sitting at no
          // price: the paid tracker. It was wired in for the set-by-set
          // sweep and for artwork but never consulted per card, so a card
          // the free sources don't price stayed blank until the sweep
          // happened to reach its set — which for a new set is weeks. One
          // credit each, against 20,000 a day.
          if (nextMarket == null && priceTrackerEnabled()) {
            const tracked = await priceTrackerMarketPrice({
              name: card.name as string,
              setName: (card.set_name as string | null) ?? null,
              number: (card.number as string | null) ?? null,
            });
            if (tracked != null) {
              nextMarket = tracked;
              summary.trackerPriced = (summary.trackerPriced ?? 0) + 1;
            }
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
              set: (card.set_name as string | null) ?? null,
              number: (card.number as string | null) ?? null,
              image: (card.image_small as string | null) ?? null,
              rarity: (card.rarity as string | null) ?? null,
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

  // Pre-warm printed card text / combat data for owned cards that don't
  // have it yet — the deck builder, deck review, and battles all read this
  // cache, and a warm cache means no build-time fetching and no AI
  // guessing what a card does. A slice per night covers whole collections
  // within days. (battle_data column exists after migration 019.)
  try {
    const needsText = (cards ?? [])
      .filter(
        (c) =>
          "battle_data" in c &&
          c.battle_data == null &&
          !(c.id as string).startsWith("custom-")
      )
      .slice(0, opts?.textBudget ?? 30);
    summary.textWarmed = 0;
    for (let i = 0; i < needsText.length; i += 5) {
      await Promise.all(
        needsText.slice(i, i + 5).map(async (c) => {
          const bd = (c.id as string).startsWith("tcgdex-")
            ? await getTcgdexBattleDataById(c.id as string)
            : await getBattleDataById(c.id as string);
          if (bd) {
            const { error } = await admin.from("cards").update({ battle_data: bd }).eq("id", c.id);
            if (!error) summary.textWarmed = (summary.textWarmed ?? 0) + 1;
          }
        })
      );
    }
  } catch {
    // Warming is best-effort.
  }
  } catch (err) {
    // A failed run must still RECORD itself — otherwise the admin panel
    // shows nothing and the failure reason is lost.
    summary.error = err instanceof Error ? err.message : String(err);
    console.error("price refresh failed", err);
  }

  // Remember the run for the admin dashboard (best-effort — app_state exists
  // after migration 022).
  await admin
    .from("app_state")
    .upsert({ key: STATE_KEY, value: summary, updated_at: new Date().toISOString() })
    .then(() => {});

  return summary;
}

/** Fill in a held card's picture and printing details.
 *
 *  The held list is written by the run that flagged it, and runs from
 *  before those fields existed left rows carrying nothing but a name and
 *  two numbers — which is exactly the information you cannot decide a price
 *  from. Rather than migrate the stored blobs, top them up at read time
 *  from the cards table, which is the source of truth anyway and may have
 *  gained artwork since the flag was raised. */
async function enrichSuspicious(
  admin: SupabaseClient,
  rows: PriceRefreshSummary["suspicious"]
): Promise<PriceRefreshSummary["suspicious"]> {
  const needy = rows.filter((r) => r.id && (!r.image || !r.set));
  if (needy.length === 0) return rows;
  const { data } = await admin
    .from("cards")
    .select("id, name, number, set_name, rarity, image_small")
    .in("id", needy.map((r) => r.id));
  type Row = {
    id: string;
    name: string;
    number: string | null;
    set_name: string | null;
    rarity: string | null;
    image_small: string | null;
  };
  const byId = new Map(((data ?? []) as unknown as Row[]).map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = byId.get(r.id);
    if (!c) return r;
    return {
      ...r,
      name: r.name || c.name,
      set: r.set ?? c.set_name,
      number: r.number ?? c.number,
      rarity: r.rarity ?? c.rarity,
      image: r.image ?? c.image_small,
    };
  });
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
      suspicious: await enrichSuspicious(
        admin,
        Array.isArray(value.suspicious) ? value.suspicious : []
      ),
      pt: value.pt ?? null,
      textWarmed: value.textWarmed ?? 0,
      trackerPriced: value.trackerPriced ?? 0,
      ...(value.error ? { error: value.error } : {}),
    };
  } catch {
    return null;
  }
}

/** Owned cards with no price at all. The number that decides whether this
 *  is a backlog to clear or a routine to keep. Cheap: a HEAD count. */
async function unpricedOwnedCount(admin: SupabaseClient): Promise<number> {
  try {
    const { data: owned } = await fetchAllRows<{ card_id: string }>(() =>
      admin.from("collection_items").select("card_id").order("card_id")
    );
    const ids = [...new Set((owned ?? []).map((r) => r.card_id))];
    if (ids.length === 0) return 0;
    let missing = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const { count } = await admin
        .from("cards")
        .select("id", { count: "exact", head: true })
        .in("id", ids.slice(i, i + 200))
        .is("market_price", null);
      missing += count ?? 0;
    }
    return missing;
  } catch {
    return 0;
  }
}

/** Self-scheduling loop for the long-running Railway server: checks hourly,
 *  and refreshes hourly WHILE cards are unpriced, then once a day once they
 *  aren't. A stamped claim in app_state keeps multiple instances from
 *  double-running. */
export function startPriceRefreshLoop() {
  const tick = async () => {
    try {
      const admin = createAdminClient();
      // Backlog or maintenance? A card with no price is the app looking
      // broken to whoever just scanned it, so that case runs hourly until
      // it's cleared; steady state stays daily.
      const backlog = await unpricedOwnedCount(admin);
      const gapHours = backlog > 0 ? BACKLOG_HOURS_BETWEEN_RUNS : MIN_HOURS_BETWEEN_RUNS;
      const cutoff = new Date(Date.now() - gapHours * 3600_000).toISOString();
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
          `${summary.suspicious.length} suspicious, ${summary.unpriced} without data` +
          (backlog > 0 ? ` (backlog was ${backlog} unpriced, running hourly)` : "") +
          (summary.error ? ` — FAILED: ${summary.error}` : "")
      );
      if (summary.error) {
        // Release most of the claim window so the next hourly tick retries,
        // instead of a failed run blocking refreshes for a whole day.
        await admin
          .from("app_state")
          .update({
            updated_at: new Date(Date.now() - (gapHours - 0.5) * 3600_000).toISOString(),
          })
          .eq("key", STATE_KEY)
          .then(() => {});
      }
    } catch (err) {
      console.error("price refresh loop error", err);
    }
  };
  // First check shortly after boot, then hourly.
  setTimeout(tick, 90_000);
  setInterval(tick, 3600_000);
}
