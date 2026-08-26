-- 070: the leftovers that slipped under the last cleanup's bar.
--
-- Migration 063 cleared bulk-rarity prices over $50. The bar was set high
-- to be safe, and the cost of that safety is now visible: a Wailmer common
-- from a current set showing $47.96 — corruption-era numbers that ducked
-- under the ceiling and have been compounding collection totals since
-- (×2 owned = ~$96 of phantom value on one card).
--
-- A common or uncommon from the modern era worth more than $20 essentially
-- does not exist; the handful of famous exceptions are all old enough to
-- have real release dates well before the window below. So: rarity, recency
-- and $20, and this time the per-finish price map goes too — 063 left
-- `prices` in place, and priceForVariant reads the map FIRST, which is why
-- a few cards kept showing the bad number after their market_price was
-- cleared.
--
-- Same philosophy as 063: cleared, not corrected — we don't know the right
-- number, and inventing one repeats the mistake in the other direction. A
-- blank price sorts to the FRONT of the refresh queue, so these re-price
-- within the next run — and the write path now discards impossible claims
-- and holds implausible ones, so what comes back is either right or
-- reviewed.
--
-- price_updated_at deliberately kept, same as 063: the blank price alone
-- already prioritises them without disturbing the queue's ordering.

update public.cards
set market_price = null,
    prices = null
where lower(trim(coalesce(rarity, ''))) in ('common', 'uncommon')
  and (release_date is null or release_date >= '2023-01-01')
  and (
    market_price > 20
    or exists (
      select 1 from jsonb_each_text(coalesce(prices, '{}'::jsonb)) as p(k, v)
      where v ~ '^[0-9.]+$' and v::numeric > 20
    )
  );
