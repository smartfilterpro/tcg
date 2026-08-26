-- 072: one catalogue, two games.
--
-- Magic: The Gathering cards join the same cards table rather than getting
-- their own, because the collection, trades, families and the scanner all
-- join through cards — and because a bulk scan of a real shoebox contains
-- BOTH games in one photo. One table means one save path and one review
-- screen; the game column is what the per-game tabs and the game-specific
-- pipelines (price sources, text sweeps, deck building) filter on.
--
-- Every existing row is Pokémon, so the default backfills the whole table
-- for free (a metadata-only change on modern Postgres). MTG rows arrive
-- with game='mtg' and ids prefixed 'scry-' (Scryfall's UUIDs), set ids
-- prefixed 'mtg-' so they can never collide with Pokémon set codes.

alter table public.cards
  add column if not exists game text not null default 'pokemon';

-- The Pokémon pipelines (paid price tracker, card-text sweep, price
-- refresh) all need "not mtg" cheaply, and the importer needs "all mtg".
create index if not exists cards_game_idx on public.cards (game);
