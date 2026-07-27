-- Trade requests: send a proposed trade to a friend; they accept or decline.
-- Run this in the Supabase SQL editor after 012_analytics.sql.

create table public.trade_offers (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  -- Lines: [{label, qty, value}] — labels are snapshots, cards aren't moved
  give jsonb not null default '[]',  -- what from_user offers
  get jsonb not null default '[]',   -- what from_user wants in return
  message text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.trade_offers enable row level security;

create policy "participants see their trade offers"
  on public.trade_offers for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());

create policy "members send their own trade offers"
  on public.trade_offers for insert to authenticated
  with check (from_user = auth.uid());

create policy "participants update their trade offers"
  on public.trade_offers for update to authenticated
  using (from_user = auth.uid() or to_user = auth.uid())
  with check (from_user = auth.uid() or to_user = auth.uid());

create index trade_offers_to_idx on public.trade_offers (to_user, status);
create index trade_offers_from_idx on public.trade_offers (from_user, status);
