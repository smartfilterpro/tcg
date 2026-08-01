-- 042: a record of every name someone tried to use.
--
-- The AI screen (lib/moderation) refuses inappropriate usernames and deck
-- names at save time, which is prevention. This is detection, and the two
-- are not the same job:
--
--   * The screen deliberately fails OPEN — a moderation outage or a genuine
--     uncertainty lets a name through. Without a log, nobody ever learns
--     which names those were.
--   * A person testing the filter with fifteen variants of the same slur is
--     the clearest signal of intent the system will ever get, and every one
--     of those attempts was previously discarded the moment it was refused.
--
-- So both outcomes are recorded: what was refused (with the text, because
-- the text is the evidence) and what was accepted (so a human can skim what
-- actually went live).

create table if not exists public.name_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('display name', 'deck name')),
  attempted text not null,
  allowed boolean not null,
  /** The screen's reason when it refused; null when it allowed. */
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists name_audit_recent_idx
  on public.name_audit (created_at desc);
create index if not exists name_audit_refused_idx
  on public.name_audit (user_id, created_at desc) where allowed = false;

alter table public.name_audit enable row level security;
-- No policies: admin-only, read through the service role. A member has no
-- business reading what other members tried to call themselves.
