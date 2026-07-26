-- Store the deck builder's upgrade suggestions with saved decks.
-- Run this in the Supabase SQL editor after 005_card_photos.sql.

alter table public.decks
  add column if not exists suggestions jsonb not null default '[]';
