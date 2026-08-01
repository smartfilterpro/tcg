-- 041: when was this deck shared?
--
-- The admin dashboard's "N decks newly shared this week — skim the names"
-- alert had to guess, using the deck's CREATION date as a proxy because
-- nothing recorded the moment sharing was switched on. That misses the case
-- the alert exists for: an old deck renamed to something objectionable and
-- shared today never tripped it.
--
-- Backfilled to created_at for decks already shared, which is the same
-- guess the alert was making — no worse than today, and exact from here.

alter table public.decks
  add column if not exists shared_at timestamptz;

update public.decks
set shared_at = created_at
where shared = true and shared_at is null;

create index if not exists decks_shared_at_idx
  on public.decks (shared_at desc) where shared = true;
