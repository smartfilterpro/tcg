-- 066: make the scanner's catalogue lookup indexed and spelling-blind.
--
-- Every name lookup in the app is an ilike against cards.name, and the table
-- has no index that can serve one — the full-text GIN index from 001 serves
-- a to_tsvector query shape nothing has ever sent. So the scanner's "is this
-- card already ours?" check sequential-scans the whole catalogue, four at a
-- time, on every scan.
--
-- Worse than slow, it was blind: the query was byte-exact on the name, so a
-- stored "Flabébé" never answered a detected "Flabebe", "Team Rocket's
-- Mewtwo ex" never answered a scan that couldn't see the apostrophe on a
-- glossy card, and "Dragonair (Poké Ball Pattern)" — the only row a brand-new
-- set may have, because the paid sync names printings the TCGplayer way —
-- never answered "Dragonair". Each miss looks identical to "we don't have
-- this card" and sends the scan out to an external API for something sitting
-- in our own table.
--
-- The fix is the same one the search box already uses in JavaScript
-- (normalizeForSearch): compare names with accents, case and punctuation
-- removed. This puts that spelling into the table as a generated column so
-- it can be indexed and queried directly.

-- Accent folding that matches src/lib/text.ts normalizeForSearch closely
-- enough: the characters listed are the ones that occur in card names
-- (Pokémon, Flabébé, …). Immutable so a generated column may use it.
create or replace function public.card_name_key(txt text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    translate(
      lower(coalesce(txt, '')),
      'áàâäãåéèêëíìîïóòôöõúùûüýÿçñ',
      'aaaaaaeeeeiiiiooooouuuuyycn'
    ),
    '[^a-z0-9]', '', 'g'
  );
$$;

alter table public.cards
  add column if not exists name_key text
  generated always as (public.card_name_key(name)) stored;

-- text_pattern_ops so the scanner's prefix query (name_key like 'dragonair%',
-- which is how it finds the "(Poké Ball Pattern)" printings) is an index
-- range scan, not a walk of the table.
create index if not exists cards_name_key_idx
  on public.cards (name_key text_pattern_ops);

-- Dead weight: only ever usable by textSearch()/@@ queries, and no code path
-- sends one. It has been taxing every card write since 001 for nothing.
drop index if exists public.cards_name_idx;

-- Two indexes the API audit found missing on hot paths that scan today:
-- every deck-list load filters decks by owner, and the battles lobby orders
-- a participant's battles by recency.
create index if not exists decks_user_idx on public.decks (user_id);
create index if not exists battles_updated_idx on public.battles (updated_at desc);
