-- 039: the mail-in scanning service.
--
-- A customer mails their cards in; a feeder rig photographs the stack card
-- by card (pass 1), then again in reverse order (pass 2). The system reads
-- both photos of every card independently — two passes agreeing on the same
-- catalogue card is what earns "verified" with no human involved, which is
-- the whole economy of the service: on a 6,000-card job a person should
-- review the disagreements, not the stack.
--
-- Jobs are admin-only and belong to NO member account until the upload
-- step. The rig authenticates with the job's device key, not a session.

create table if not exists public.bulk_jobs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  created_by uuid references public.profiles (id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'ready', 'uploaded', 'cancelled')),
  -- The rig's credential, unique per job so two customers' stacks can run
  -- on two rigs at once without any way to cross-post.
  device_key text not null unique,
  expected_cards int,
  -- The service's own meter: model spend for this job, separate from every
  -- member's credits (this is billed to the customer at a premium).
  ai_cost_usd numeric not null default 0,
  uploaded_to uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz,
  -- What the upload wrote, exactly, so it can be undone:
  -- [{ item_id, action: 'created'|'merged', qty, card_id, variant }]
  upload_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bulk_cards (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.bulk_jobs (id) on delete cascade,
  -- Position in pass 1's feed order; pass 2 arrives reversed and is paired
  -- back onto these rows at finalize.
  seq int not null,
  pass1_path text,
  pass2_path text,
  pass1_read jsonb,
  pass2_read jsonb,
  -- The final answer: the catalogue card this physical card IS.
  card_id text references public.cards (id) on delete set null,
  variant text not null default 'normal',
  -- verified: both passes agreed, no human needed.
  -- review: passes disagree / a read failed / single pass — needs a person.
  -- corrected: a person reviewed it (and possibly changed the pick).
  confidence text check (confidence in ('verified', 'review', 'corrected')),
  reviewed boolean not null default false,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, seq)
);

create index if not exists bulk_cards_job_idx on public.bulk_cards (job_id, seq);

alter table public.bulk_jobs enable row level security;
alter table public.bulk_cards enable row level security;
-- No policies on purpose: only the service role touches these. Members
-- never see a job, including the one whose cards are in it, until the
-- cards land in their collection.

-- The photos. Private bucket — no public read policy; the admin UI views
-- them through short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('bulk-scans', 'bulk-scans', false)
on conflict (id) do nothing;
