-- 030: what the card ACTUALLY graded.
--
-- Migration 024 said saved reports would let you "watch how your submissions
-- actually came back versus the estimate" — but it never added anywhere to
-- put the real grade, so that comparison was never possible.
--
-- This matters more than it looks. Exporting saved reports to improve the
-- grader gives you photos, measured centering, and the model's own opinion.
-- Training on your own predictions teaches a model to repeat its mistakes
-- more confidently; what makes a grading dataset worth anything is the label
-- a human grader put on the slab. These columns are that label.

alter table public.grade_reports
  -- The number on the slab: 1-10, halves allowed (PSA 8.5, BGS 9.5).
  add column if not exists actual_grade numeric
    check (actual_grade is null or (actual_grade >= 1 and actual_grade <= 10)),
  -- Who graded it — the scales are not interchangeable and a mixed dataset
  -- that forgets which is which is worse than a smaller clean one.
  add column if not exists actual_grader text
    check (actual_grader is null or actual_grader in ('PSA', 'BGS', 'CGC', 'SGC', 'other')),
  -- BGS-style subgrades where the grader gives them, as
  -- {"centering":9.5,"corners":9,"edges":9.5,"surface":9}.
  add column if not exists actual_subgrades jsonb,
  add column if not exists actual_cert text,
  add column if not exists actual_notes text,
  add column if not exists actual_recorded_at timestamptz;

-- Finding the rows that carry ground truth is the export's main query.
create index if not exists grade_reports_actual_idx
  on public.grade_reports (actual_grade) where actual_grade is not null;

-- The owner records their own outcome. Migration 024 gave grade_reports
-- select/insert/delete policies but no update, so without this nobody can
-- write the result back.
create policy "grade reports update own" on public.grade_reports
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
