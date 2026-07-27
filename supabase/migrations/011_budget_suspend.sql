-- Monthly AI spend caps + member suspension.
-- Run this in the Supabase SQL editor after 010_support_usernames.sql.

-- Every member gets a $10/month AI allowance by default; the admin can
-- adjust it per user from the Admin page. Admins themselves are never capped.
alter table public.profiles
  add column if not exists ai_budget_usd numeric not null default 10;

-- Suspended members can't sign in or use the app until unsuspended.
alter table public.profiles
  add column if not exists suspended boolean not null default false;
