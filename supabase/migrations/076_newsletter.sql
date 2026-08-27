-- 076: newsletter consent.
--
-- Explicit opt-IN, defaulting to false: nobody is subscribed by signing
-- up, which is both the polite reading of consent law (CAN-SPAM/GDPR) and
-- the cheap one — a list of people who asked to hear from you outperforms
-- a list of people who forgot to untick a box. The toggle lives in
-- Account settings; every send carries a one-click tokenized unsubscribe
-- that flips this back without a login.

alter table public.profiles
  add column if not exists newsletter_opt_in boolean not null default false;

-- The send query is "everyone opted in" — worth an index only because the
-- profiles table is walked for nothing else this shape.
create index if not exists profiles_newsletter_idx
  on public.profiles (newsletter_opt_in) where newsletter_opt_in;
