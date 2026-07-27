-- Messages between the two participants of a trade request (negotiate while
-- pending, arrange the hand-off once accepted).
-- Run this in the Supabase SQL editor after 014_trade_cleanup.sql.

create table public.trade_offer_messages (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.trade_offers (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.trade_offer_messages enable row level security;

create policy "trade messages visible to participants"
  on public.trade_offer_messages for select to authenticated
  using (
    exists (
      select 1 from public.trade_offers o
      where o.id = offer_id and (o.from_user = auth.uid() or o.to_user = auth.uid())
    )
  );

create policy "participants message on their trades"
  on public.trade_offer_messages for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.trade_offers o
      where o.id = offer_id and (o.from_user = auth.uid() or o.to_user = auth.uid())
    )
  );

create index trade_offer_messages_offer_idx on public.trade_offer_messages (offer_id);
