import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCardById } from "@/lib/pokemontcg";
import { getTcgdexPricesById, findTcgdexImage } from "@/lib/tcgdex";
import { poketraceEnabled, searchPoketraceCard, getPoketracePrices } from "@/lib/poketrace";
import { priceTrackerEnabled, priceTrackerCard, backgroundBudgetOk } from "@/lib/priceTracker";
import { getBattleDataById } from "@/lib/pokemontcg";
import { getTcgdexBattleDataById } from "@/lib/tcgdex";
import { fetchAllRows } from "@/lib/fetchAll";
import { mergePrices } from "@/lib/cardWrite";

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
    /** Null when the card had no price at all — an uncorroborated eBay
     *  claim on a blank card is exactly the case worth reviewing. */
    old: number | null;
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
  /** Given artwork by TCGdex, free, before any credit was spent. */
  freeArt?: number;
  /** Priced by the paid tracker after the free sources had nothing. */
  trackerPriced?: number;
  /** Given artwork by the paid tracker, on the same lookups. */
  trackerArt?: number;
  /** How many of the held rows THIS run added (the rest are carried from
   *  earlier runs, still waiting on a decision). */
  newlyHeld?: number;
  /** Set when the run failed partway — shown in the admin panel. */
  error?: string;
}

const STATE_KEY = "price_refresh";

/** How far a price may move before a human should look at it. Five-fold in
 *  either direction is well past any real market move over one night. */
const SWING_RATIO = 5;

/** …and how many dollars it has to move as well, so the queue isn't filled
 *  with bulk commons wobbling between 2c and 15c. */
const SWING_FLOOR_USD = 1;

/** The most an UNCORROBORATED eBay completed-sales average may assert on its
 *  own. Above this it goes to review instead of straight onto the card: eBay
 *  averages sweep in bulk lots and graded slabs, and a confidently wrong $700
 *  is worse for someone valuing a collection than an honest blank. */
const EBAY_TRUST_CEILING = 20;

/** Rarities a set prints in quantity. Plain "rare" belongs here: the modern
 *  black-star rare is a filler slot, not a chase card — the chase cards wear
 *  "Double Rare", "Illustration Rare", "Special Illustration Rare" and the
 *  rest, and none of those are listed. */
const BULK_RARITIES = new Set(["common", "uncommon", "rare"]);

/** …but only for recent sets. A 1999 Rare can genuinely be worth hundreds —
 *  vintage non-holos from Base Set are exactly that — while a Rare from a
 *  set that came out this year is a bulk card by construction, however the
 *  market feels about it. Without this the guard would start refusing real
 *  prices on the oldest and most valuable cards in the app. */
const BULK_RARITY_MAX_AGE_YEARS = 3;

/** What a bulk-rarity card may be worth before the number is more likely to
 *  be a mismatch than a market.
 *
 *  This one is a heuristic and says so. It exists because the failures seen
 *  so far are not all attributable to one source: a Shuppet common and a
 *  Mega Dragonite ex secret rare in the same set held the identical price to
 *  the cent — $706.96 — which is a card wearing another card's product, and
 *  no amount of preferring TCGplayer over eBay catches that. Whatever
 *  upstream mapped them together, a Common at $706 is worth a human's glance
 *  before it becomes what someone's collection is "worth". */
const BULK_RARITY_CEILING_USD = 50;

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
  // What earlier runs already put in front of a human. A held card is
  // waiting on a DECISION, not on another lookup — re-checking it buys the
  // same answer we already refused to write. These used to stay in the
  // rotation: a flagged card was never stamped, so it sat at the front of
  // the stale queue and was re-fetched (sometimes on paid budget) and
  // re-flagged every single run — the same ~65 cards, hourly. Worse, a
  // BLANK card whose only claim was untrusted could never be priced at
  // all, so it kept the backlog non-zero and the whole loop on the hourly
  // cadence forever.
  const heldAlready = await readHeldList(admin);
  const heldIds = new Set(heldAlready.map((s) => s.id));

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
    (id) =>
      (!id.startsWith("custom-") || poketraceEnabled()) && !heldIds.has(id)
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

  // Cards with NO price lead, then stalest first.
  //
  // This used to sort on price_updated_at alone, on the assumption that a
  // never-priced card carries a null stamp and therefore sorts first. That
  // assumption held only while nothing else wrote the column. The catalogue
  // import stamped it on every card it touched, priced or not, so a card it
  // had just blanked looked freshly checked and sank to the back of a queue
  // 400 long — the one card guaranteed to be showing the owner nothing.
  //
  // Sorting on the price itself can't be undermined that way: it asks the
  // question that actually matters instead of a proxy for it.
  const queue = (cards ?? [])
    .sort((a, b) => {
      const aBlank = a.market_price == null ? 0 : 1;
      const bBlank = b.market_price == null ? 0 : 1;
      if (aBlank !== bBlank) return aBlank - bBlank;
      return (a.price_updated_at ?? "").localeCompare(b.price_updated_at ?? "");
    })
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
          // PokeTrace is LAST-ISH, and only where it adds something.
          //
          // It used to run first, for every card. That was backwards on two
          // counts: its free tier paces one request per two seconds, so it
          // was the wall-clock cost of the entire run (80 requests = nearly
          // three minutes of waiting), and it spent a scarce 250-a-day
          // budget on cards pokemontcg.io prices for free and instantly.
          //
          // What it uniquely provides is GRADED prices — PSA/BGS numbers no
          // other source here carries — and those only matter for a card
          // worth grading. So it is asked when the graded data is missing
          // and the card is worth something, or when nothing else priced
          // the card at all. Everything else gets the free sources.
          const knownValue = (card.market_price as number | null) ?? null;
          const hasGraded =
            "graded_prices" in card && card.graded_prices != null;
          const gradedWorthAsking = !hasGraded && (knownValue == null || knownValue >= 5);
          let ptMarket: number | null = null;
          let ptSource: "tcgplayer" | "ebay" | null = null;
          if (pt && !pt.error && pt.requests < PT_BUDGET && gradedWorthAsking) {
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
                  ptSource = prices.marketSource;
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
            const fresh = await getTcgdexPricesById(card.id as string);
            nextMarket = fresh.market;
            nextPrices = fresh.prices;
          } else if (!(card.id as string).startsWith("custom-")) {
            const fresh = await getCardById(card.id as string);
            nextMarket = fresh?.marketPrice ?? null;
            nextPrices = fresh?.prices ?? null;
          }
          // PokeTrace's daily-updated market number wins when it exists —
          // but not blindly, and not when it came from eBay.
          //
          // It used to win unconditionally, which meant an eBay completed-
          // sales average could overwrite a perfectly good free-source
          // price. For a card TCGplayer hasn't listed yet — everything in a
          // set released last month — that average is dominated by bulk lots
          // and slabs, and commons from a current set were showing hundreds
          // of dollars each.
          //
          // So the two sources check each other. A TCGplayer number still
          // wins outright. An eBay one only wins if nothing else priced the
          // card, or if it broadly agrees with what did.
          let ptUnverified = false;
          if (ptMarket != null) {
            if (ptSource === "tcgplayer") {
              nextMarket = ptMarket;
            } else if (nextMarket == null) {
              // Nothing to check it against. Small numbers are worth having
              // even unverified; a large one is a claim, and a wrong large
              // one is worse than an honest blank.
              if (ptMarket <= EBAY_TRUST_CEILING) nextMarket = ptMarket;
              else ptUnverified = true;
            } else if (ptMarket <= nextMarket * SWING_RATIO && ptMarket >= nextMarket / SWING_RATIO) {
              nextMarket = ptMarket;
            }
            // Else: the free source and eBay disagree wildly. Keep the free
            // source, which is a per-single price by construction.
          }

          // Last resort, and the reason a scanned card stops sitting at no
          // price: the paid tracker. It was wired in for the set-by-set
          // sweep and for artwork but never consulted per card, so a card
          // the free sources don't price stayed blank until the sweep
          // happened to reach its set — which for a new set is weeks. One
          // credit each, against 20,000 a day.
          const needsArt = !(card.image_small as string | null) && card.image_locked !== true;

          // Artwork, free source first. TCGdex carries the promos and older
          // printings that are exactly the cards sitting here with no
          // picture, and asking costs nothing — so it is tried BEFORE the
          // paid credit, not after it. Custom entries are skipped: there is
          // no real card behind the name to find.
          let freeArt = false;
          if (needsArt && !(card.id as string).startsWith("custom-")) {
            const free = await findTcgdexImage({
              name: card.name as string,
              number: (card.number as string | null) ?? null,
              setName: (card.set_name as string | null) ?? null,
            });
            if (free) {
              const { error: freeErr } = await admin
                .from("cards")
                .update({ image_small: free, image_large: free })
                .eq("id", card.id);
              if (!freeErr) {
                freeArt = true;
                summary.freeArt = (summary.freeArt ?? 0) + 1;
              }
            }
          }
          const stillNeedsArt = needsArt && !freeArt;

          // The reserve applies here. This is a background sweep of up to
          // 400 cards an hour, each one a paid lookup — left unchecked it
          // eats exactly the credits held back so that somebody pressing a
          // button gets an answer.
          if ((nextMarket == null || stillNeedsArt) && priceTrackerEnabled() && backgroundBudgetOk()) {
            const found = await priceTrackerCard({
              name: card.name as string,
              setName: (card.set_name as string | null) ?? null,
              number: (card.number as string | null) ?? null,
            });
            if (nextMarket == null && found.market != null) {
              nextMarket = found.market;
              summary.trackerPriced = (summary.trackerPriced ?? 0) + 1;
            }
            // The same credit already bought the artwork. A card with no
            // picture is as broken-looking as one with no price, and the
            // art mirror copies whatever lands here into our own storage
            // on its next sweep.
            if (stillNeedsArt && found.image) {
              const { error: artErr } = await admin
                .from("cards")
                .update({ image_small: found.image, image_large: found.image })
                .eq("id", card.id);
              if (!artErr) summary.trackerArt = (summary.trackerArt ?? 0) + 1;
            }
            // And their catalogue id, which came back in the same response.
            // It is the join key for their bulk datasets and there is no
            // other way to get one — dropping it means paying again later
            // for something already in our hands.
            if (found.tcgPlayerId && "tcgplayer_id" in card && !card.tcgplayer_id) {
              await admin
                .from("cards")
                .update({ tcgplayer_id: found.tcgPlayerId })
                .eq("id", card.id)
                .then(() => {});
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
          // A swing worth a human's attention, or a claim nothing corroborated.
          //
          // The ratio test used to be gated on `old >= 1`, so it only watched
          // cards that were already worth a pound — and a 12-cent common
          // jumping to $706 sailed straight through, unflagged, which is the
          // exact shape of the bug this now catches. Cheap cards are where a
          // bad source match is most likely AND most obvious.
          //
          // The dollar floor replaces what `old >= 1` was clumsily doing:
          // keeping penny noise out of the queue. 2c to 15c is a 7x move and
          // means nothing; 12c to $706 is the same ratio and means everything.
          const swung =
            old != null &&
            nextMarket != null &&
            Math.abs(nextMarket - old) >= SWING_FLOOR_USD &&
            (nextMarket > old * SWING_RATIO || nextMarket < old / SWING_RATIO);
          // An unverified eBay claim never became nextMarket, so the number
          // under review is the one it wanted to write.
          const proposed = nextMarket ?? ptMarket;
          // A bulk-rarity card from a recent set priced like a chase card,
          // whichever source said so. Unknown release date counts as recent:
          // the cards with no release_date are the ones freshly imported from
          // a set nobody has catalogued yet, which is exactly when the
          // upstream mappings are least settled.
          const releasedAt = Date.parse((card.release_date as string | null) ?? "");
          const recent =
            Number.isNaN(releasedAt) ||
            Date.now() - releasedAt < BULK_RARITY_MAX_AGE_YEARS * 365 * 86_400_000;
          const implausible =
            proposed != null &&
            proposed > BULK_RARITY_CEILING_USD &&
            recent &&
            BULK_RARITIES.has(((card.rarity as string | null) ?? "").trim().toLowerCase());
          if ((ptUnverified || swung || implausible) && proposed != null) {
            summary.suspicious.push({
              id: card.id as string,
              name: card.name as string,
              old,
              next: proposed,
              set: (card.set_name as string | null) ?? null,
              number: (card.number as string | null) ?? null,
              image: (card.image_small as string | null) ?? null,
              rarity: (card.rarity as string | null) ?? null,
            });
            // Stamped as checked even though nothing was written: the card
            // now waits on the review queue, not the refresh rotation. The
            // review buttons re-stamp on decision either way, and a "keep"
            // means the feed's claim can resurface once the card is stale
            // again — days from now, not next hour.
            await admin
              .from("cards")
              .update({ price_updated_at: new Date().toISOString() })
              .eq("id", card.id)
              .then(() => {});
            return; // don't auto-apply a wild swing
          }

          const patch: Record<string, unknown> = {
            price_updated_at: new Date().toISOString(),
          };
          if (nextMarket != null) patch.market_price = nextMarket;
          // MERGED into what the card already holds. Whichever source
          // answered here lists only the finishes IT knows, and assigning
          // the map wholesale deletes the rest — so a card priced tonight by
          // a source that carries Normal alone loses the Reverse Holo price
          // another source found, and every Reverse Holo in somebody's
          // collection quietly falls back to the Normal's number.
          if (nextPrices) {
            const merged = mergePrices(card.prices, nextPrices);
            if (merged) patch.prices = merged;
          }
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

  // The held list is CARRIED, not replaced. Each run used to overwrite the
  // summary with only its own flags, which is why flagged cards had to stay
  // artificially stale to remain visible — the churn this run no longer
  // pays. Read the stored list again HERE, not at the start: an admin who
  // resolved rows while this run was fetching keeps their decisions.
  summary.newlyHeld = summary.suspicious.length;
  const stillHeld = await readHeldList(admin);
  const newIds = new Set(summary.suspicious.map((s) => s.id));
  summary.suspicious = [
    ...summary.suspicious,
    ...stillHeld.filter((s) => !newIds.has(s.id)),
  ].slice(0, 400); // bounded: the blob rides in one app_state row

  // Remember the run for the admin dashboard (best-effort — app_state exists
  // after migration 022).
  await admin
    .from("app_state")
    .upsert({ key: STATE_KEY, value: summary, updated_at: new Date().toISOString() })
    .then(() => {});

  return summary;
}

/** The held rows as currently stored — the review queue's source of truth.
 *  Empty on any failure: pre-migration-022 there is nowhere to store them,
 *  and a transient read error only means one run re-checks a few cards. */
async function readHeldList(
  admin: SupabaseClient
): Promise<PriceRefreshSummary["suspicious"]> {
  try {
    const { data } = await admin
      .from("app_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    const value = data?.value as Partial<PriceRefreshSummary> | null;
    return Array.isArray(value?.suspicious) ? value.suspicious : [];
  } catch {
    return [];
  }
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
      freeArt: value.freeArt ?? 0,
      trackerPriced: value.trackerPriced ?? 0,
      trackerArt: value.trackerArt ?? 0,
      ...(value.newlyHeld != null ? { newlyHeld: value.newlyHeld } : {}),
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
    // A blank card whose only claim is sitting in the review queue is not a
    // backlog the refresh can clear — counting it kept the loop on the
    // hourly cadence indefinitely, re-running a full 400-card pass for
    // cards only a human can resolve.
    const held = new Set((await readHeldList(admin)).map((s) => s.id));
    const { data: owned } = await fetchAllRows<{ card_id: string }>(() =>
      admin.from("collection_items").select("card_id").order("card_id")
    );
    const ids = [...new Set((owned ?? []).map((r) => r.card_id))].filter(
      (id) => !held.has(id)
    );
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
          `${summary.suspicious.length} held for review (${summary.newlyHeld ?? 0} new), ` +
          `${summary.unpriced} without data` +
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
