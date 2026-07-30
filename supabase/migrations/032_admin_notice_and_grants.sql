-- 032: a site-wide notice, and admin credit grants that leave a trail.
--
-- Two unrelated admin needs, one migration because neither is big enough to
-- deserve its own and both are pure additions.

-- ---------------------------------------------------------------- notices
--
-- "Upgrade tonight at 11." "Trainer AI is down." Today the only way to say
-- either is to ship a deploy, which is exactly the thing you cannot do when
-- the reason you need to say it is that a deploy is about to happen.
--
-- One row is live at a time. Not a queue: two banners stacked on a page is
-- worse than none, and the second one is never read.
create table if not exists public.site_notices (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  -- info: routine ("maintenance tonight"). warning: degraded but usable.
  -- outage: something is actually broken. Drives colour and nothing else —
  -- none of them block anything.
  level text not null default 'info' check (level in ('info', 'warning', 'outage')),
  active boolean not null default true,
  -- Set it and forget it: a maintenance notice for 11pm should stop being
  -- shown at midnight without anyone having to remember.
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  -- Whether a reader can dismiss it. An outage notice generally shouldn't be
  -- dismissible; a heads-up about Tuesday should.
  dismissible boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists site_notices_live_idx
  on public.site_notices (starts_at desc) where active;

alter table public.site_notices enable row level security;

-- Readable by anyone signed in, including before they've accepted the terms:
-- "the site is down for maintenance" is precisely the thing someone stuck on
-- a broken page needs to see. Writes are admin-only and go through the API
-- with the service role.
drop policy if exists "site notices: readable" on public.site_notices;
create policy "site notices: readable" on public.site_notices
  for select using (true);

-- ----------------------------------------------------------------- grants
--
-- Credits are already a ledger, so an admin grant is just another row —
-- no schema change needed for the credit itself. What is missing is who did
-- it and why, and for anything that mints value out of nothing that is the
-- only part that matters. Support goodwill, a comped refund and a mistake
-- all look identical in an untagged ledger.
create table if not exists public.credit_grant_audit (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid references public.credit_ledger (id) on delete set null,
  target_user uuid not null references public.profiles (id) on delete cascade,
  granted_by uuid not null references public.profiles (id) on delete restrict,
  delta integer not null,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists credit_grant_audit_target_idx
  on public.credit_grant_audit (target_user, created_at desc);

alter table public.credit_grant_audit enable row level security;
-- No policy at all: this is an audit trail, read by the API with the service
-- role and by nobody else. on delete restrict on granted_by is deliberate —
-- deleting an admin account must not quietly erase what they did.
