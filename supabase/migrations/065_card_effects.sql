-- What each card compiles to, so a battle never has to ask a model.
--
-- Kept apart from battle_data on purpose. battle_data is what is PRINTED on
-- the card — attacks, cost, damage, rules text — read once from the card
-- databases or the photo. This is what that text MEANS to the engine, and
-- the two have different lifetimes: a better compiler reruns against the
-- same printed text, and rereading a card's text should not throw away a
-- good compile. Separate columns keep either from dragging the other along.
--
-- Shared data, like the rest of the cards table: a card's rules do not vary
-- by who is holding it, so one compile serves every player forever. That is
-- what makes this affordable — the whole catalogue is a few dollars once,
-- not a model call per battle per turn.
--
-- effects_v carries the schema version the row was produced against, so a
-- later compiler can find exactly the rows that need redoing instead of
-- redoing all of them, and so a partly-migrated table is legible rather
-- than ambiguous.

alter table public.cards
  add column if not exists effects jsonb,
  add column if not exists effects_v integer,
  add column if not exists effects_at timestamptz;

-- The sweep's only query: cards that have printed text and no current
-- compile. Partial, because the compiled rows are the ones it never wants.
create index if not exists cards_effects_todo_idx
  on public.cards (id)
  where effects_v is null;

comment on column public.cards.effects is
  'Compiled effect script (see src/lib/cardEffects.ts). Executed deterministically; never produced during a battle.';
