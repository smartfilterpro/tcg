-- Variant (finish) tracking: holo / reverse holo / normal / 1st edition…
-- Run this in the Supabase SQL editor after 001_init.sql.

-- Per-variant market prices, e.g. {"normal": 0.25, "reverseHolofoil": 1.10}
alter table public.cards add column if not exists prices jsonb;

-- Each collection row is now (card, finish) — you can own the same card
-- in multiple finishes with separate quantities.
alter table public.collection_items
  add column if not exists variant text not null default 'normal';

alter table public.collection_items
  drop constraint if exists collection_items_user_id_card_id_key;

alter table public.collection_items
  add constraint collection_items_user_card_variant_key
  unique (user_id, card_id, variant);
