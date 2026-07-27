-- 017: player-vs-player battles.
-- A battle is a live shared game board: the app shuffles, deals, and keeps
-- the table state (hands, bench, prizes, damage, log) while the two players
-- enforce the actual game rules themselves — like playing across a real table.

create table public.battles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,          -- short join code the host shares
  host_user uuid not null references public.profiles(id) on delete cascade,
  guest_user uuid references public.profiles(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  winner_user uuid,
  state jsonb not null default '{}',  -- full game state (server-side only; API redacts per player)
  version integer not null default 0, -- optimistic-concurrency guard for simultaneous moves
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index battles_host_idx on public.battles (host_user);
create index battles_guest_idx on public.battles (guest_user);

alter table public.battles enable row level security;

-- All reads and writes go through the app's API (service role), which
-- redacts hidden information (hands, deck order) per player — so members get
-- no direct read access to raw state. Participants may delete their battles.
create policy "battles participant delete" on public.battles
  for delete using (auth.uid() = host_user or auth.uid() = guest_user);
