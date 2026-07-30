# Pokémon Price Tracker — what the Business plan unlocks

Captured at the point of deciding, not at the point of building. We're on the
Personal plan today (20,000 credits/day, `/cards` and `/sets`); the plan is to
upgrade at launch. Three endpoints are Business-only and each replaces
something we currently do worse.

Nothing here is built. This is the brief for when it is.

---

## 1. `/export` — daily bulk price dumps

Gzipped CSV of the whole catalogue, regenerated 06:00 UTC. **Zero API credits**
— a separate quota of 2 downloads/day.

This is the big one. It replaces `src/lib/priceRefresh.ts` outright.

Today that cron walks the catalogue stalest-first, a few hundred cards a run,
one lookup each. The last run in production checked 120 cards and found **51
with no price data at all** — not because the data doesn't exist, but because
we only ever ask about a sliver of the catalogue per day. One export prices
everything, every morning, for nothing.

### Use `type=printings`, not `type=cards`

`cards` emits one row per card, showing only its *primary* printing — and the
primary printing is not necessarily the valuable one. About **29% of the
catalogue has other printings whose prices are simply absent** from that file.

We model per-finish prices already: `cards.prices` is a
`Record<string, number|null>` keyed by finish, and `collection_items.variant`
records which finish someone owns. So `type=cards` would leave every reverse
holo, 1st Edition and Unlimited Holofoil in the app unpriced — the exact gap
we have now, re-imported daily and looking authoritative.

`printings` uses identical columns and is a strict superset. Key on
`tcgPlayerId + printing`.

One wrinkle: `sellers` is card-level, so it's populated on the primary-printing
row and blank on the others. Don't read a blank as zero.

### Operational notes

- 302 → a Vercel Blob URL that **changes daily**. Follow the redirect; never
  cache or hardcode the blob URL.
- `.csv.gz` — decompress before parsing.
- Before 06:00 UTC the new dump may not exist: **503 with `Retry-After`**
  (default 1 hour), and a 503 does *not* count against the quota.
- `X-Dump-Generated-At` confirms today's data; `X-Export-Downloads-Remaining`
  tracks quota.
- Two downloads a day means: **one scheduled pull, one retry.** Not a polling
  loop. Our cron already runs daily, so this fits as-is.

## 2. `/population` — GemRate grading populations

PSA / BGS / CGC / SGC counts, gem rate, and the full grade distribution
(`g1`…`g10`, `pristine`, `perfect`) per card. 2 credits per card via the API,
or free in the daily `population` export.

This is what makes the grading value table real. `computeGradeValue` currently
answers "is it worth grading?" from raw price versus graded price, with no
notion of **how likely that grade is**. Gem rate is exactly the missing term:
a card with a 4% PSA 10 rate is a different proposition from one at 45%, at
identical prices.

## 3. `/ebay` export — graded sales

`grade, salesCount, averagePrice, medianPrice, smartMarketPrice,
smartMarketConfidence, marketPrice7Day, marketTrend, salesVelocityWeekly`, per
card per grade.

**This likely makes the pending eBay Marketplace Insights application
unnecessary.** That application exists to get sold graded comps, which is
precisely this file — without the restricted-access approval, without writing
a matcher against listing titles, and with a confidence figure and a sales
count we would otherwise have to derive ourselves.

Worth deciding deliberately rather than by accident: if the Business plan is
happening anyway, the eBay integration's remaining value is the *buy-list*
asking prices we already ship, not valuations.

---

## The one thing to do before then

**We don't store `tcgPlayerId`.** Every dataset above joins on it, and our
`cards.id` is a pokemontcg.io id. Without that column, none of these files can
be matched to our catalogue.

`/cards` returns `tcgPlayerId` on every response, and `src/lib/priceTracker.ts`
already calls it as an image fallback. Capturing the id whenever we happen to
get one costs nothing and would mean a meaningful head start on the mapping by
the time the exports arrive. The alternative is matching on name + set +
number after the fact, which is the same fuzzy-matching problem we solved for
eBay and would rather not solve twice.

Suggested when we pick this up: add `cards.tcgplayer_id text` with a unique
index, populate opportunistically from `findCard`, and backfill the remainder
from the `cards` export itself (it carries `name`, `setName`, `cardNumber` —
enough for a one-time reconciliation).
