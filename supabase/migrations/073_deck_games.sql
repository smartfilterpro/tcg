-- 073: decks know their game and format.
--
-- The deck builder now builds Magic: The Gathering decks (Commander and
-- Standard) alongside Pokémon ones, and everything downstream — the coach's
-- rules knowledge, the churn guard's "provably basic" list, the export
-- format (PTCG Live vs MTG Arena) — branches on which game a deck belongs
-- to. Stored on the deck rather than re-derived from its cards every time,
-- because an empty or half-edited deck still has a game.
--
-- format: 'commander' | 'standard' for MTG; Pokémon decks reuse the
-- existing convention (null = anything goes, 'standard' | 'expanded' noted
-- in strategy text). Nullable on purpose.

alter table public.decks
  add column if not exists game text not null default 'pokemon';

alter table public.decks
  add column if not exists format text;
