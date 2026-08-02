-- Remembering which card art can't be fetched.
--
-- The art mirror retries every card it fails on, on every sweep, forever.
-- That is right for a source having a bad day and wrong for a URL that is
-- permanently gone: pokemontcg.io returns a hard 404 for whole sets it never
-- published images for (the McDonald's promo sets among them), and those
-- cards were consuming the per-batch attempt budget on every pass while
-- never being fixable.
--
-- Two columns, so a failure can be told from a bad day:
--   art_attempts  — how many times mirroring has failed for this card
--   art_failed_at — when it last failed
--
-- The mirror skips a card with several failures until the timestamp ages
-- out, so a source that comes back online is still picked up eventually —
-- it is a cool-off, not a tombstone. Both reset to zero the moment a mirror
-- succeeds.

alter table public.cards
  add column if not exists art_attempts int not null default 0,
  add column if not exists art_failed_at timestamptz;

-- The mirror's scan walks by id and filters on these; the partial index
-- keeps that filter cheap without indexing the whole catalogue.
create index if not exists cards_art_failed_idx
  on public.cards (art_failed_at)
  where art_attempts > 0;

comment on column public.cards.art_attempts is
  'Consecutive art-mirror failures. Reset to 0 on a successful mirror.';
comment on column public.cards.art_failed_at is
  'When art mirroring last failed, for the retry cool-off.';
