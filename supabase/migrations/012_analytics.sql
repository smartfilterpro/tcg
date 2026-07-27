-- Scan telemetry for admin analytics.
-- Run this in the Supabase SQL editor after 011_budget_suspend.sql.

create table public.scan_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  duration_ms int not null,        -- photo sent → results shown
  cards_detected int not null,     -- cards the AI saw in the photo
  cards_auto_matched int not null, -- of those, matched to a database card automatically
  cards_saved int not null,        -- rows actually saved to the collection
  cards_kept_match int not null,   -- saved WITHOUT the user changing the card (scan was right)
  created_at timestamptz not null default now()
);

alter table public.scan_events enable row level security;

create policy "members record own scans"
  on public.scan_events for insert to authenticated
  with check (user_id = auth.uid());

create policy "admins read scan analytics"
  on public.scan_events for select to authenticated
  using (public.is_admin());

create index scan_events_created_idx on public.scan_events (created_at desc);
