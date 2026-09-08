-- The rules library: the official game rules, on file and searchable, so
-- DeckAI answers rules questions from the actual text instead of memory.
-- MTG's Comprehensive Rules import as numbered sections; the Pokémon
-- rulebook imports as pasted text chunked by heading. Served to the
-- assistant through a lookup tool — never stuffed whole into a prompt.
create table if not exists public.rules_sections (
  id bigint generated always as identity primary key,
  game text not null check (game in ('pokemon', 'mtg')),
  section text not null default '',
  title text not null default '',
  body text not null,
  tsv tsvector generated always as (
    to_tsvector('english', coalesce(section, '') || ' ' || coalesce(title, '') || ' ' || body)
  ) stored,
  created_at timestamptz not null default now()
);

create index if not exists rules_sections_tsv_idx on public.rules_sections using gin (tsv);
create index if not exists rules_sections_game_idx on public.rules_sections (game, section);

-- Server-only: RLS on with no policies means only the service role reads
-- it, which is the assistant's lookup tool and the admin importer.
alter table public.rules_sections enable row level security;
