-- Per-user AI token usage tracking (shown in the Admin portal).
-- Run this in the Supabase SQL editor after 002_variants.sql.

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null, -- 'scan' | 'deck_build' | 'coach'
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.ai_usage enable row level security;

-- Rows are written by the server on behalf of the signed-in user.
create policy "insert own ai usage"
  on public.ai_usage for insert to authenticated
  with check (user_id = auth.uid());

-- Users may see their own usage; admins see everyone's.
create policy "read own or admin ai usage"
  on public.ai_usage for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create index ai_usage_user_idx on public.ai_usage (user_id, created_at);
