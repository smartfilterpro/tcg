-- Support tickets + default usernames.
-- Run this in the Supabase SQL editor after 009_trade_board.sql.

-- ============ default usernames ============
-- Every profile gets a username (from the email's local part) so members
-- never see each other's email addresses.
update public.profiles
  set display_name = split_part(email, '@', 1)
  where display_name is null or display_name = '';

-- New signups get a default username too (keeps first-user-becomes-admin).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  member_count int;
begin
  select count(*) into member_count from public.profiles;
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    case when member_count = 0 then 'admin' else 'member' end
  );
  return new;
end;
$$;

-- ============ support tickets ============
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  subject text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;

create policy "tickets visible to owner and admins"
  on public.support_tickets for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "members create own tickets"
  on public.support_tickets for insert to authenticated
  with check (user_id = auth.uid());

create policy "owner and admins update tickets"
  on public.support_tickets for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create index support_tickets_user_idx on public.support_tickets (user_id);

create table public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.support_ticket_messages enable row level security;

create policy "ticket messages visible to ticket participants"
  on public.support_ticket_messages for select to authenticated
  using (
    exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and (t.user_id = auth.uid() or public.is_admin())
    )
  );

create policy "participants reply on visible tickets"
  on public.support_ticket_messages for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and (t.user_id = auth.uid() or public.is_admin())
    )
  );

create index support_ticket_messages_ticket_idx on public.support_ticket_messages (ticket_id);
