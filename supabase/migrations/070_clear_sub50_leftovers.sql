-- 070: the leftovers that slipped under the last cleanup's bar.
--
-- Migration 063 cleared bulk-rarity prices over $50. The bar was set high
-- to be safe, and the cost of that safety is now visible: a Wailmer common
-- from a current set showing $47.96 — corruption-era numbers that ducked
-- under the ceiling and have been compounding collection totals since
-- (×2 owned = ~$96 of phantom value on one card).
--
-- Two bars, because age changes the verdict:
--   - Provably modern (release date 2023+): over $20 is cleared. A modern
--     common above $20 is rarer than the mapping errors that put it there.
--   - No release date on file: usually a fresh import, but sometimes a
--     vintage row from the price sync — and OLD commons genuinely reach
--     real money. Those keep 063's conservative $50 bar, so no vintage
--     card's honest price is destroyed by a cleanup aimed at corruption.
--
-- This time the per-finish price map goes too — 063 left `prices` in
-- place, and priceForVariant reads the map FIRST, which is why a few cards
-- kept showing the bad number after their market_price was cleared.
--
-- Same philosophy as 063: cleared, not corrected — we don't know the right
-- number, and inventing one repeats the mistake in the other direction. A
-- blank price sorts to the FRONT of the refresh queue, so these re-price
-- within the next run — and the write path now discards impossible claims
-- on known-recent cards and holds everything questionable on unknown-age
-- ones, so what comes back is either right or reviewed.
--
-- price_updated_at deliberately kept, same as 063: the blank price alone
-- already prioritises them without disturbing the queue's ordering.

update public.cards
set market_price = null,
    prices = null
where lower(trim(coalesce(rarity, ''))) in ('common', 'uncommon')
  and (
    (
      release_date >= '2023-01-01'
      and (
        market_price > 20
        or exists (
          select 1 from jsonb_each_text(coalesce(prices, '{}'::jsonb)) as p(k, v)
          where v ~ '^[0-9.]+$' and v::numeric > 20
        )
      )
    )
    or (
      release_date is null
      and (
        market_price > 50
        or exists (
          select 1 from jsonb_each_text(coalesce(prices, '{}'::jsonb)) as p(k, v)
          where v ~ '^[0-9.]+$' and v::numeric > 50
        )
      )
    )
  );
