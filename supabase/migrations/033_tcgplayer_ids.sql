-- 033: somewhere to put a TCGplayer id.
--
-- Every Pokémon Price Tracker dataset — the card dump, the per-printing
-- dump, the eBay graded sales, the GemRate populations — joins on
-- tcgPlayerId. Our card ids are pokemontcg.io ids, so without this column
-- none of those files can be matched to our catalogue at all, and the
-- fallback is fuzzy-matching on name plus set plus number: the same problem
-- we solved for eBay listings and would rather not solve twice.
--
-- Added now rather than at launch because it has time value. /cards returns
-- the id on every response and the image fallback already calls that
-- endpoint, so from today every lookup quietly records one more mapping. By
-- the time the bulk exports arrive, the reconciliation is that much smaller.

alter table public.cards
  add column if not exists tcgplayer_id text;

-- Unique where present: two of our cards mapping to one TCGplayer product
-- means one of them is wrong, and a dump join would silently double-count.
create unique index if not exists cards_tcgplayer_id_idx
  on public.cards (tcgplayer_id) where tcgplayer_id is not null;

-- Finding what still needs mapping, cheaply, when the backfill runs.
create index if not exists cards_tcgplayer_missing_idx
  on public.cards (id) where tcgplayer_id is null;
