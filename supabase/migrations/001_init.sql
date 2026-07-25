-- PokéDeck initial schema
-- Run this in the Supabase SQL editor (or `supabase db push`).

-- ============ profiles ============
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Everyone signed in can see who else is in the group (needed for sharing).
create policy "profiles are viewable by authenticated users"
  on public.profiles for select to authenticated using (true);

create policy "users can update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Auto-create a profile on signup. The very first user becomes admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  member_count int;
begin
  select count(*) into member_count from public.profiles;
  insert into public.profiles (id, email, role)
  values (
    new.id,
    coalesce(new.email, ''),
    case when member_count = 0 then 'admin' else 'member' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Helper for admin-only policies
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- ============ cards (shared reference cache from pokemontcg.io) ============
create table public.cards (
  id text primary key, -- pokemontcg.io id e.g. "sv8pt5-42"
  name text not null,
  supertype text,          -- Pokémon | Trainer | Energy
  subtypes text[] default '{}',
  types text[] default '{}', -- energy types e.g. {Fire}
  hp text,
  number text not null,
  rarity text,             -- e.g. "Special Illustration Rare"
  set_id text not null,
  set_name text not null,  -- e.g. "Perfect Order"
  set_series text,
  set_printed_total int,
  release_date text,
  image_small text,
  image_large text,
  market_price numeric,    -- USD best-effort
  price_updated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.cards enable row level security;

create policy "cards are viewable by authenticated users"
  on public.cards for select to authenticated using (true);
-- Cards are a shared cache; any signed-in user can add/refresh entries.
create policy "cards insert by authenticated"
  on public.cards for insert to authenticated with check (true);
create policy "cards update by authenticated"
  on public.cards for update to authenticated using (true) with check (true);

create index cards_name_idx on public.cards using gin (to_tsvector('simple', name));
create index cards_set_idx on public.cards (set_id);

-- ============ collection_items ============
create table public.collection_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  card_id text not null references public.cards (id) on delete cascade,
  quantity int not null default 1 check (quantity > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, card_id)
);

alter table public.collection_items enable row level security;

-- Owners manage their own collection; other members can view (sharing).
create policy "collections viewable by authenticated users"
  on public.collection_items for select to authenticated using (true);
create policy "insert own collection items"
  on public.collection_items for insert to authenticated with check (user_id = auth.uid());
create policy "update own collection items"
  on public.collection_items for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own collection items"
  on public.collection_items for delete to authenticated using (user_id = auth.uid());

create index collection_user_idx on public.collection_items (user_id);

-- ============ decks ============
create table public.decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  strategy text,
  cards jsonb not null default '[]', -- [{name, quantity, category, card_id, reason}]
  created_at timestamptz not null default now()
);

alter table public.decks enable row level security;

create policy "decks viewable by authenticated users"
  on public.decks for select to authenticated using (true);
create policy "insert own decks"
  on public.decks for insert to authenticated with check (user_id = auth.uid());
create policy "update own decks"
  on public.decks for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own decks"
  on public.decks for delete to authenticated using (user_id = auth.uid());

-- ============ play_profiles (deck-builder personalization) ============
create table public.play_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  style_notes text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.play_profiles enable row level security;

create policy "own play profile"
  on public.play_profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ invites (invite-only signup, managed by admin) ============
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;

create policy "admins manage invites"
  on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============ api_tokens (Claude Cowork / export access) ============
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.api_tokens enable row level security;

create policy "own api tokens"
  on public.api_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
