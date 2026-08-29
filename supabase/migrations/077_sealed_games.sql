-- 077: sealed product learns which game it belongs to.
--
-- Cards got their game column in 072; sealed product now needs the same,
-- because the pricing path branches on it: a Pokémon box asks the paid
-- tracker first and eBay with "pokemon" in the query, a Magic box has no
-- paid catalogue and searches eBay as "magic the gathering". Without the
-- column a Bloomburrow Collector Booster Box would be priced from a search
-- that filters FOR Pokémon listings — the one set of results it can't be in.
--
-- Default 'pokemon' grandfathers every existing row correctly: everything
-- added before Magic support existed is Pokémon product.

alter table public.sealed_products
  add column if not exists game text not null default 'pokemon'
  check (game in ('pokemon', 'mtg'));
