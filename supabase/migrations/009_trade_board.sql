-- Trade board: post what you're looking for and what you'll trade for it.
-- Run this in the Supabase SQL editor after 008_sharing.sql.

create table public.trade_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  looking_for text not null,
  offering text not null,
  -- Optional card attachments for pictures: [{id, name, image, set_name, number}]
  looking_for_cards jsonb not null default '[]',
  offering_cards jsonb not null default '[]',
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.trade_posts enable row level security;

create policy "trade posts viewable by members"
  on public.trade_posts for select to authenticated using (true);

create policy "members create own trade posts"
  on public.trade_posts for insert to authenticated
  with check (user_id = auth.uid());

create policy "members update own trade posts"
  on public.trade_posts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "owners and admins delete trade posts"
  on public.trade_posts for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

create index trade_posts_created_idx on public.trade_posts (created_at desc);

create table public.trade_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.trade_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.trade_post_comments enable row level security;

create policy "trade comments viewable by members"
  on public.trade_post_comments for select to authenticated using (true);

create policy "members create own trade comments"
  on public.trade_post_comments for insert to authenticated
  with check (user_id = auth.uid());

create policy "owners and admins delete trade comments"
  on public.trade_post_comments for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

create index trade_post_comments_post_idx on public.trade_post_comments (post_id);
