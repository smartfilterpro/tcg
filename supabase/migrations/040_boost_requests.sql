-- 040: a kid asks, a parent pays.
--
-- Boosts on a kid profile have always been refused outright ("ask a parent")
-- — correct, but a dead end: the kid had no way to ask inside the app and
-- the parent had nothing to approve. This is the ask.
--
-- The kid never reaches Stripe. They create a request; a parent in the same
-- family either declines it or takes it to checkout under THEIR OWN Stripe
-- customer, so the card on file is the parent's and the credits land in the
-- family pool the kid already spends from. No child ever enters payment
-- details, which is the whole point.

create table if not exists public.boost_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.family_groups (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  -- Which pack, by the key in lib/boosts.ts. Validated in the API against
  -- that table rather than stored as a price, so a stale row can never
  -- become a discount.
  pack text not null,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  /** The boost_purchases row a parent's approval created, once paid. */
  purchase_id uuid references public.boost_purchases (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists boost_requests_group_idx
  on public.boost_requests (group_id, created_at desc);
-- One live ask per kid: a child who taps three times has asked once.
create unique index if not exists boost_requests_one_pending
  on public.boost_requests (requested_by) where status = 'pending';

alter table public.boost_requests enable row level security;

-- Everyone in the family sees the family's requests; all writes go through
-- the API with the service role, so a kid cannot approve their own ask.
drop policy if exists "family sees boost requests" on public.boost_requests;
create policy "family sees boost requests" on public.boost_requests
  for select using (group_id = public.my_family_group());
