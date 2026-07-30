-- 031: nobody joins a family without agreeing to it.
--
-- Adding a member was a single insert into family_members, keyed on an email
-- address the parent typed. Anyone who knew your email could pull your
-- account into their group, and the consequences of being in one are not
-- cosmetic: a parent can cap your monthly spending and switch your trade
-- board off, your AI usage starts drawing from their pool, and your usage is
-- itemised on their settings page. That is a lot to do to someone who never
-- agreed to any of it.
--
-- So an invitation is now a request that the invited person answers, exactly
-- like a pal request. The parent creates a pending row and gets a link. The
-- invited person accepts or declines — from their own account if they have
-- one, or by following the link, signing up, and then accepting. Membership
-- is only ever written by that acceptance.

create table if not exists public.family_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.family_groups (id) on delete cascade,
  invited_by uuid not null references public.profiles (id) on delete cascade,
  -- Stored lowercase. Matched against the accepting account's email so an
  -- invite meant for one person cannot be redeemed by another who was
  -- forwarded the link.
  email text not null,
  role text not null default 'kid' check (role in ('parent', 'kid')),
  -- The link. Long and random: it is the only credential someone arriving
  -- without an account can present.
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  -- Invitations should not sit open forever; a stale link is a standing key
  -- to someone's family group.
  expires_at timestamptz not null default now() + interval '14 days'
);

-- One live invitation per address per group. A parent clicking Add twice
-- should not create two rows that both have to be revoked.
create unique index if not exists family_invites_pending_idx
  on public.family_invites (group_id, lower(email)) where status = 'pending';

create index if not exists family_invites_email_idx
  on public.family_invites (lower(email)) where status = 'pending';

alter table public.family_invites enable row level security;

-- Readable by the two people it concerns: whoever sent it, and whoever it
-- was addressed to. Writes go through the API with the service role, so
-- there is no policy for insert or update — a client that could update its
-- own invite row could set status to 'accepted' without the API ever
-- checking the group's size or the caller's identity.
drop policy if exists "family invites: sender or invitee" on public.family_invites;
create policy "family invites: sender or invitee" on public.family_invites
  for select using (
    invited_by = auth.uid()
    or lower(email) = lower((select email from public.profiles where id = auth.uid()))
  );

-- Resolve a token for someone who may not have an account yet.
--
-- Security definer, and deliberately thin: it returns who is inviting and
-- which address the invitation is for, so the join page can say "Sam invited
-- you" and can tell a signed-in visitor that the invite belongs to a
-- different address. It returns nothing for an expired, answered or revoked
-- invitation, so a dead link cannot be distinguished from a wrong one.
create or replace function public.family_invite_by_token(t text)
returns table (
  id uuid,
  group_id uuid,
  email text,
  role text,
  inviter_name text,
  expires_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select i.id,
         i.group_id,
         i.email,
         i.role,
         coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)),
         i.expires_at
  from public.family_invites i
  join public.profiles p on p.id = i.invited_by
  where i.token = t
    and i.status = 'pending'
    and i.expires_at > now()
  limit 1;
$$;

grant execute on function public.family_invite_by_token(text) to anon, authenticated;
