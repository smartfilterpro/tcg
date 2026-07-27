-- 019: cached battle data for cards (attacks, weakness, resistance, retreat).
-- Fetched from the card reference API the first time a card appears in a
-- battle, then cached here forever. Powers referee-mode attack buttons,
-- weakness/resistance math, and retreat costs.

alter table public.cards add column if not exists battle_data jsonb;
