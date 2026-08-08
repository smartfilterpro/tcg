-- What a call actually cost, and how hard it was told to think.
--
-- The Anthropic API reports input tokens in three parts — fresh input,
-- tokens written to the prompt cache, and tokens read back from it — and
-- this table recorded only the first. That is not a rounding error: the
-- assistant deliberately puts the account digest in a cached block because
-- it is the largest part of the request, so the largest part of every chat
-- request was being logged as zero and debited as free.
--
-- Cache reads are cheap (a tenth of the input rate) and cache writes are
-- dear (a quarter again on top), but neither is nothing, and the gap was
-- widest for exactly the members who chat most.
--
-- effort records which thinking depth a call ran at. Without it the only
-- way to tell whether lowering effort helped is to compare either side of
-- a deploy timestamp and hope nothing else moved.

alter table public.ai_usage
  add column if not exists cache_write_tokens int not null default 0,
  add column if not exists cache_read_tokens int not null default 0,
  add column if not exists effort text;

-- Rows written before this migration have zeros, which is what they always
-- effectively claimed. They are not back-fillable — the counts were never
-- recorded — so any comparison across this date is comparing two different
-- measurements, not two different costs.
comment on column public.ai_usage.cache_write_tokens is
  'Tokens written to the prompt cache. Zero on rows predating migration 057.';
comment on column public.ai_usage.cache_read_tokens is
  'Tokens served from the prompt cache. Zero on rows predating migration 057.';
