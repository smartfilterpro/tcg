-- 074: trending decks learn which game they belong to.
--
-- The Pokémon meta comes from Limitless nightly; Magic has no keyless
-- equivalent, so its trending decks are CURATED — written by the admin from
-- whatever source they trust, never scraped from a site that could change
-- shape under us. Both kinds share meta_decks, split by game exactly the
-- way cards and decks already are.
--
-- The uniqueness key grows the game column: "standard" is a format name in
-- BOTH games, so (format, archetype) alone would let a Magic Standard
-- archetype collide with a Pokémon one.

alter table public.meta_decks
  add column if not exists game text not null default 'pokemon';

drop index if exists public.meta_decks_format_archetype_key;

create unique index if not exists meta_decks_game_format_archetype_key
  on public.meta_decks (game, format, lower(archetype));
