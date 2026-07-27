-- 018: finish feedback — the scanner learns from corrections over time.
-- Every time a member corrects (or confirms) the finish the scanner guessed
-- for a card (normal / holo / reverse holo / stamp), we record it. Future
-- scans of the same card check this history first: once the same wrong guess
-- has been corrected twice, the scanner stops making it.

create table public.finish_feedback (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references public.cards (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  predicted text not null,  -- the finish the scanner suggested
  corrected text not null,  -- the finish the member saved (same value = confirmation)
  created_at timestamptz not null default now()
);

create index finish_feedback_card_idx on public.finish_feedback (card_id);

alter table public.finish_feedback enable row level security;

-- Community data (which finish a printing actually is), nothing personal —
-- every member's scans both contribute to and benefit from it.
create policy "finish feedback read" on public.finish_feedback
  for select using (auth.uid() is not null);
create policy "finish feedback insert own" on public.finish_feedback
  for insert with check (auth.uid() = user_id);
