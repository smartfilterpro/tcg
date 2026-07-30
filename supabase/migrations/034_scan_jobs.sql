-- 034: a scan is a job, not a request.
--
-- Scanning was one fetch that the client awaited. If the phone slept, the
-- browser backgrounded the tab, or the connection dropped in a lift, the
-- request died with it — and the model had already run, so the credits were
-- already spent. The person paid for a scan and got nothing, with no way to
-- find it again. That is the worst failure in the app: it takes money and
-- returns an error.
--
-- Now the work is recorded server-side as it happens. Cards land in `cards`
-- one at a time as the model reads them, so a client that reconnects — after
-- a sleep, a refresh, or a walk between rooms — picks up exactly where it
-- was rather than starting over. Nothing about the model call is tied to the
-- browser still listening.
--
-- This also replaces a lie in the UI: the old progress bar advanced on a
-- 3.5-second timer regardless of what was happening. `expected` and the
-- length of `cards` make "4 of 6" a real number.

create table if not exists public.scan_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'done', 'error', 'cancelled')),
  -- How many cards the model says are in the photo, committed early so the
  -- progress bar has a denominator before the reading finishes.
  expected integer,
  -- Cards read so far, appended as each one is parsed out of the stream.
  cards jsonb not null default '[]'::jsonb,
  error text,
  -- Cheap telemetry the scan page already reports.
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scan_jobs_user_idx
  on public.scan_jobs (user_id, created_at desc);

-- Finding a job worth resuming: the most recent unfinished one.
create index if not exists scan_jobs_running_idx
  on public.scan_jobs (user_id, updated_at desc) where status = 'running';

alter table public.scan_jobs enable row level security;

-- Read your own. Every write goes through the API with the service role —
-- a client that could update its own job could mark a scan done with cards
-- it invented, and those cards go straight into a collection.
drop policy if exists "own scan jobs" on public.scan_jobs;
create policy "own scan jobs" on public.scan_jobs
  for select using (user_id = auth.uid());
