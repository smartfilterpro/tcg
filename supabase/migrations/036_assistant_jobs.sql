-- 036: chat replies become jobs, closing out the phone-fell-asleep family
-- (scans in 034, grades in 035).
--
-- A chat answer is a 10-30 second model call the browser awaited in one
-- fetch. Lock the phone mid-reply and the fetch died: the model finished,
-- the credit was spent, and the answer was written to history — but the
-- panel showed "The chat failed" and re-armed the question, inviting the
-- user to pay for it again. Same cure as the others: record the work
-- server-side, poll for it, and let a reconnecting panel pick it up.

create table if not exists public.assistant_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'done', 'error')),
  -- { answer, refused } — the reply also lands in assistant_messages, but
  -- the job carries it too so the waiting client doesn't have to diff
  -- history to find out which message answered its question.
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_jobs_user_idx
  on public.assistant_jobs (user_id, created_at desc);
create index if not exists assistant_jobs_running_idx
  on public.assistant_jobs (user_id, updated_at desc) where status = 'running';

alter table public.assistant_jobs enable row level security;

-- Read your own; all writes go through the API with the service role, for
-- the same reason clients can't insert assistant_messages — a client that
-- could write its own job could plant a fabricated reply.
drop policy if exists "own assistant jobs" on public.assistant_jobs;
create policy "own assistant jobs" on public.assistant_jobs
  for select using (user_id = auth.uid());
