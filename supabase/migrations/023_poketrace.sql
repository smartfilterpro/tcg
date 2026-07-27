-- 023: PokeTrace price-source integration.
-- poketrace_id caches the mapping from our card record to PokeTrace's card
-- id: one search per card EVER, then cheap direct lookups every refresh
-- (keeps the nightly pass well inside the free tier's daily request cap).
-- graded_prices stores the latest graded-market snapshot (PSA/BGS/CGC)
-- when the API provides one — used by the grading feature's value hints.

alter table public.cards add column if not exists poketrace_id text;
alter table public.cards add column if not exists graded_prices jsonb;
