-- Play style is per GAME, not per person. "Fast Fire decks, keep combos
-- simple" is a Pokémon sentence — feeding it to a Commander build steered
-- Magic decks with the wrong game's preferences. The existing column
-- keeps its Pokémon meaning (that's what everyone wrote in it); Magic
-- gets its own.
alter table public.play_profiles
  add column if not exists mtg_style_notes text not null default '';
