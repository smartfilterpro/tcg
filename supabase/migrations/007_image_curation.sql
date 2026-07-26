-- Admin image curation: keep every submitted image as a candidate, let the
-- admin pick the correct one, and lock it against non-admin changes.
-- Run this in the Supabase SQL editor after 006_deck_suggestions.sql.

alter table public.cards
  add column if not exists image_locked boolean not null default false;

create table public.card_image_candidates (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references public.cards (id) on delete cascade,
  url text not null,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (card_id, url)
);

alter table public.card_image_candidates enable row level security;

create policy "candidates viewable by authenticated"
  on public.card_image_candidates for select to authenticated using (true);

create policy "submit own candidates"
  on public.card_image_candidates for insert to authenticated
  with check (uploaded_by = auth.uid());

create policy "admins manage candidates"
  on public.card_image_candidates for delete to authenticated
  using (public.is_admin());

create index card_image_candidates_card_idx on public.card_image_candidates (card_id);
