-- Per-copy custom value: lets stamped promos, graded cards, and other
-- special copies carry their real value instead of the generic market price.
-- Run this in the Supabase SQL editor after 003_ai_usage.sql.

alter table public.collection_items
  add column if not exists price_override numeric;
