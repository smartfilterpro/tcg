-- The paid source's identifiers for sealed product.
--
-- Its /sealed-products endpoint keys everything on tcgPlayerId and can be
-- queried by it directly, which is the difference between "search for a
-- product whose name we hope matches" and "fetch this exact product". Once
-- recorded, every later reprice is exact and cannot drift onto a different
-- box.
--
-- Nullable and NOT unique, deliberately. The card catalogue's unique index
-- on tcgplayer_id turned every duplicate row into a rejected write that
-- silently discarded the price alongside it; there is no reason to build
-- the same trap twice. Duplicates here are worth knowing about, not worth
-- failing a price update over.

alter table public.sealed_products
  add column if not exists tcgplayer_id text,
  add column if not exists set_id text,
  -- Which database the product came from, so a hand-typed row and one
  -- resolved from the paid catalogue can be told apart.
  add column if not exists source text;

create index if not exists sealed_products_tcgplayer_idx
  on public.sealed_products (tcgplayer_id)
  where tcgplayer_id is not null;

comment on column public.sealed_products.tcgplayer_id is
  'TCGplayer product id. Lets a reprice fetch this exact product instead of searching by name.';
