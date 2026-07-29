-- 026: plans + the credit ledger.
--
-- 1 credit = $0.01 of real AI cost. Balances are DERIVED by summing the
-- ledger — there is deliberately no mutable balance column anywhere, so the
-- books can always be re-audited and a crashed request can never leave a
-- balance half-updated.

-- ===== plan + per-profile trade board permission =====
alter table public.profiles
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'pro', 'family')),
  add column if not exists trade_board_enabled boolean not null default true;

-- The self-update policy on profiles covers every column, and both of these
-- must only change server-side: plan via Stripe webhooks, trade_board_enabled
-- via a parent's settings. Without this revoke a kid could re-enable the
-- trade board themselves with a direct PostgREST call.
revoke update (plan, trade_board_enabled) on public.profiles from authenticated;

-- ===== the ledger =====
create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,      -- credits: positive = grant/purchase, negative = spend
  reason text not null,        -- signup_grant | monthly_grant | boost | scan | deck_build | grade | ...
  ref_id text,                 -- idempotency key: cycle date, stripe id, ai_usage id
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_idx
  on public.credit_ledger (user_id, created_at);

-- What makes lazy granting safe: the same grant (user, reason, cycle) can be
-- attempted from two racing requests and only one row can exist.
create unique index if not exists credit_ledger_once_idx
  on public.credit_ledger (user_id, reason, ref_id) where ref_id is not null;

alter table public.credit_ledger enable row level security;

-- Read your own history. All writes are service-role only: no insert/update/
-- delete policies exist, which under RLS means clients simply cannot.
create policy "own ledger rows" on public.credit_ledger
  for select to authenticated using (user_id = auth.uid());

-- ===== boost packs =====
create table if not exists public.boost_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  pack text not null,                -- '250' | '750' | '2000'
  credits integer not null,
  amount_cents integer not null,
  stripe_payment_intent text,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'refunded', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists boost_purchases_user_idx
  on public.boost_purchases (user_id, created_at);

alter table public.boost_purchases enable row level security;
create policy "own boosts" on public.boost_purchases
  for select to authenticated using (user_id = auth.uid());

-- ===== family =====
create table if not exists public.family_groups (
  id uuid primary key default gen_random_uuid(),
  owner_user uuid not null unique references public.profiles(id) on delete cascade,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  group_id uuid not null references public.family_groups(id) on delete cascade,
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  role text not null default 'kid' check (role in ('parent', 'kid')),
  credit_cap integer,                -- per-cycle spend cap in credits; null = uncapped
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.family_groups enable row level security;
alter table public.family_members enable row level security;

-- A member policy that queries family_members from family_members recurses
-- (the same trap migration 022 fixed for decks), so membership is resolved
-- through a security-definer function that bypasses RLS.
create or replace function public.my_family_group() returns uuid
language sql security definer set search_path = public stable as $$
  select group_id from public.family_members where user_id = auth.uid() limit 1;
$$;

create policy "family group visible to members" on public.family_groups
  for select to authenticated
  using (id = public.my_family_group() or owner_user = auth.uid());

create policy "family members visible to members" on public.family_members
  for select to authenticated
  using (group_id = public.my_family_group());
-- Writes (create group, add member, set caps) are service-role only, via the
-- settings API where the parent is verified.
