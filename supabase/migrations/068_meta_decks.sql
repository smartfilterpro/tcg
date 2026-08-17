-- 068: the competitive meta, as data the app holds.
--
-- "What's winning right now" is a question every deck builder eventually
-- asks, and the answer has to come from real tournament results — never
-- invented. This table is where those results live once aggregated: one row
-- per archetype per format, refreshed by a nightly pull (LimitlessTCG's
-- public API) and editable by an admin, so the feature works the day it
-- ships and keeps working if the feed ever goes away.
--
-- The app's own pattern: fetched once into a shared table, read by
-- everyone, zero per-member cost. Members never call the external API.

create table if not exists public.meta_decks (
  id uuid primary key default gen_random_uuid(),
  -- "Charizard ex", "Gardevoir ex", "Lost Box" — the name players use.
  archetype text not null,
  format text not null default 'standard',
  -- Share of recent top finishes, 0–100. Null when a curated row simply
  -- doesn't claim one.
  share numeric,
  -- Top placements counted in the window, for "seen 14 times this month".
  placements integer,
  -- The list that DEFINES the deck: [{ name, count, category? }] ordered by
  -- how central the card is. Names, not card ids, on purpose — a meta deck
  -- is "4 Charizard ex", not one specific printing, and the coverage check
  -- resolves names against the catalogue at read time.
  core_cards jsonb not null default '[]',
  -- 'curated' rows are written by an admin and never touched by the sync;
  -- 'limitless' rows are replaced wholesale by each successful pull.
  source text not null default 'curated' check (source in ('curated', 'limitless')),
  -- How many days of results the share was computed over.
  window_days integer,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists meta_decks_format_archetype_key
  on public.meta_decks (format, lower(archetype));

alter table public.meta_decks enable row level security;

-- Readable by every signed-in member; written only by the service role
-- (the sync loop and the admin endpoint), which bypasses RLS — so no
-- insert/update/delete policies exist at all.
create policy "meta decks readable" on public.meta_decks
  for select to authenticated using (true);
