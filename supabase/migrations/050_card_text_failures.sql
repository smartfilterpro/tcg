-- Remembering which cards can't be read from their own picture.
--
-- Card text reaches the app from pokemontcg.io or TCGdex, and neither
-- catalogues everything — promo bundles, brand-new sets and the printings
-- only TCGplayer sells arrive with a name, a price and a photograph and
-- nothing about what the card does. For those the picture is the only
-- source, so a vision model transcribes it once and the result is kept in
-- battle_data forever.
--
-- That works when the read succeeds. When it fails — a thumbnail too small
-- to resolve attack text, a photograph at an angle, artwork the model
-- reports as unreadable — nothing is written, so the next question about
-- that card pays for the same failed read again. A card nobody can read is
-- precisely the card that will be asked about repeatedly, because it never
-- gains the text that would stop the asking.
--
-- Same two columns as the art mirror's, for the same reason and with the
-- same meaning:
--   text_attempts  — how many times reading this card's picture has failed
--   text_failed_at — when it last failed
--
-- A cool-off rather than a tombstone: a card whose art is later replaced by
-- a better scan becomes readable, and the timestamp ages out so it gets
-- another go. Both reset the moment a read succeeds.

alter table public.cards
  add column if not exists text_attempts int not null default 0,
  add column if not exists text_failed_at timestamptz;

create index if not exists cards_text_failed_idx
  on public.cards (text_failed_at)
  where text_attempts > 0;

comment on column public.cards.text_attempts is
  'Consecutive failed vision reads of this card''s printed text. Reset to 0 on success.';
comment on column public.cards.text_failed_at is
  'When the last vision read failed. Used as a cool-off before retrying.';
