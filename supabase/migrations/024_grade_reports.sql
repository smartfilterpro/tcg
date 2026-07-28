-- 024: saved grading reports.
-- Grading used to be one-shot: you got an estimate, refreshed the page, and
-- it was gone. Keeping them means you can re-check a card later, watch how
-- your submissions actually came back versus the estimate, and give the
-- admin dashboard something to report on.
--
-- front_url/back_url point at the FLATTENED card images (background already
-- removed by the cropper), not the raw photos.

create table public.grade_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  card_id text references public.cards (id) on delete set null,
  card_name text,
  estimated_grade numeric,
  report jsonb not null,
  measurement jsonb,
  value jsonb,
  front_url text,
  back_url text,
  created_at timestamptz not null default now()
);

create index grade_reports_user_idx on public.grade_reports (user_id, created_at desc);
create index grade_reports_card_idx on public.grade_reports (card_id);

alter table public.grade_reports enable row level security;

-- Grades are personal: only the owner reads them. Admin views go through
-- the service role, which bypasses RLS.
create policy "grade reports select own" on public.grade_reports
  for select using (auth.uid() = user_id);
create policy "grade reports insert own" on public.grade_reports
  for insert with check (auth.uid() = user_id);
create policy "grade reports delete own" on public.grade_reports
  for delete using (auth.uid() = user_id);
