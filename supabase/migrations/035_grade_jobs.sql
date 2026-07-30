-- 035: grading is a job, for the same reason scanning became one (034).
--
-- A grade is a 20-40 second model call that the browser used to await in a
-- single fetch. Lock the phone — which people do constantly while waiting on
-- something slow — and the request died while the model ran on, so the
-- credits were spent and the report was lost. Scanning had the identical
-- disease and the identical cure: record the work server-side, let the
-- client poll, and let a reconnecting client pick the result up.

create table if not exists public.grade_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'done', 'error')),
  -- The finished report and value verdict, exactly as the old response body.
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grade_jobs_user_idx
  on public.grade_jobs (user_id, created_at desc);
create index if not exists grade_jobs_running_idx
  on public.grade_jobs (user_id, updated_at desc) where status = 'running';

alter table public.grade_jobs enable row level security;

-- Read your own; all writes go through the API with the service role. A
-- client that could write its own job could plant a fabricated grade report.
drop policy if exists "own grade jobs" on public.grade_jobs;
create policy "own grade jobs" on public.grade_jobs
  for select using (user_id = auth.uid());
