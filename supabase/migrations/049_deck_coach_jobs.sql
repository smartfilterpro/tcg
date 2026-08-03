-- 049: the deck coach's answer becomes a job.
--
-- Last of the phone-fell-asleep family (scans 034, grades 035, chat 036).
-- The coach was a single awaited fetch, which was survivable while it was one
-- 10-second model call. Then it gained the ability to propose a deck edit, and
-- a question ending in "ok, make that change" became two sequential model
-- calls — the proposal, then the reply explaining it — on top of reading the
-- whole collection. Long enough to outlive a locked screen, and long enough to
-- outlive the gateway: the browser saw a non-JSON timeout page and reported
-- "Something went wrong", while the model had finished and the credit was
-- spent.
--
-- Its own table rather than a row in assistant_jobs. The chat panel resumes by
-- looking for ANY running job of its own, and a coach job sitting in that
-- table would be picked up as a chat reply and rendered as one.

create table if not exists public.deck_coach_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Which deck was asked about. Kept so a returning client can tell whether
  -- the answer it is about to show belongs to the deck still on screen.
  deck_id uuid,
  status text not null default 'running'
    check (status in ('running', 'done', 'error')),
  -- { answer, edit } — the proposed edit rides with the answer so an approval
  -- card survives the reload that brought the client back.
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deck_coach_jobs_user_idx
  on public.deck_coach_jobs (user_id, created_at desc);

alter table public.deck_coach_jobs enable row level security;

-- Read your own; every write goes through the API with the service role. A
-- client that could write its own job could plant a deck edit and then approve
-- it, which is the one thing the propose/approve split exists to prevent.
drop policy if exists "own deck coach jobs" on public.deck_coach_jobs;
create policy "own deck coach jobs" on public.deck_coach_jobs
  for select using (user_id = auth.uid());
