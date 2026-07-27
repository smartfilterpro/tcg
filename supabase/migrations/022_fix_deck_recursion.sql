-- 022: URGENT FIX — decks unreadable after migration 020.
-- 020's policies created a cycle: reading decks checks deck_shares, and
-- reading deck_shares checks decks. Postgres detects "infinite recursion in
-- policy for relation decks" and errors EVERY select on decks — which made
-- saved decks appear to vanish. Rows were never touched.
--
-- Fix: the cross-table checks move into SECURITY DEFINER helper functions,
-- which bypass row-level security internally, so neither policy re-enters
-- the other.

create or replace function public.owns_deck(d uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.decks where id = d and user_id = auth.uid());
$$;

create or replace function public.deck_shared_with_me(d uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.deck_shares where deck_id = d and user_id = auth.uid());
$$;

drop policy if exists "deck shares visible" on public.deck_shares;
create policy "deck shares visible" on public.deck_shares
  for select using (auth.uid() = user_id or public.owns_deck(deck_id));

drop policy if exists "deck shares managed by owner" on public.deck_shares;
create policy "deck shares managed by owner" on public.deck_shares
  for insert with check (public.owns_deck(deck_id));

drop policy if exists "deck shares removed by owner" on public.deck_shares;
create policy "deck shares removed by owner" on public.deck_shares
  for delete using (public.owns_deck(deck_id));

drop policy if exists "shared decks viewable by scope" on public.decks;
create policy "shared decks viewable by scope" on public.decks
  for select to authenticated
  using (
    (shared and share_scope = 'everyone')
    or (
      shared and share_scope = 'friends'
      and exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester = auth.uid() and f.addressee = decks.user_id)
            or (f.addressee = auth.uid() and f.requester = decks.user_id))
      )
    )
    or public.deck_shared_with_me(id)
  );

-- Tiny key-value store for background jobs (service-role only — no policies).
-- Used by the nightly price refresher to track its last run.
create table if not exists public.app_state (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;
