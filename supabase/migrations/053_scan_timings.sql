-- Where a scan's time actually went.
--
-- scan_jobs already records duration_ms, which answers "was it slow?" and
-- nothing else. A nine-card scan taking 57 seconds could be the model
-- reading the photo, or the catalogue lookup, or two cards falling through
-- to an external API that was having a bad minute — and those have three
-- different fixes. Without the split, every answer is a guess, and this app
-- has spent a week paying for guesses.
--
-- So each scan keeps its own breakdown: how long the model took, how long
-- matching took, and per card which path answered — our own catalogue, the
-- primary API, or the TCGdex fallback — with the milliseconds against each.
-- The shape is deliberately loose (jsonb, not columns) because the pipeline
-- will change and a schema migration per stage is a tax on improving it.

alter table public.scan_jobs
  add column if not exists timings jsonb;

comment on column public.scan_jobs.timings is
  'Per-scan timing breakdown: { modelMs, matchMs, totalMs, cards: [{ name, ms, path, swapped }] }. Diagnostic only — nothing reads it but the admin panel.';
