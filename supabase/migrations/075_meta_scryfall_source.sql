-- 075: a third meta source — community popularity, via Scryfall.
--
-- Magic has no Limitless: the tournament sites are scraping-only, their
-- terms forbid it, and scraped HTML fails silently. What DOES exist,
-- keyless and stable, is Scryfall's edhrec_rank — how often each card is
-- built with across the EDHREC community. A nightly pull of the top-ranked
-- commanders fills the Magic trending tab with real popularity data,
-- labelled as popularity and never as tournament results.
--
-- 'scryfall' rows follow the limitless rules: replaced wholesale by each
-- successful pull, never allowed to overwrite a curated row.

alter table public.meta_decks drop constraint if exists meta_decks_source_check;
alter table public.meta_decks
  add constraint meta_decks_source_check
  check (source in ('curated', 'limitless', 'scryfall'));
