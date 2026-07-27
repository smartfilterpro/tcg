-- Terms of Service acceptance tracking.
-- Run this in the Supabase SQL editor after 015_trade_messages.sql.

alter table public.profiles
  add column if not exists tos_accepted_at timestamptz;
