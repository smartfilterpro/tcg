-- 043: a moderator role.
--
-- Admin is all-or-nothing: the member list, billing, credit grants, the
-- business dashboard, deleting accounts. That is the wrong price of entry
-- for someone whose job is "watch the names and take down the bad posts",
-- and handing a helper the billing panel to get content removal is exactly
-- the sort of over-granting that ends badly.
--
-- A moderator can: remove trade posts and replies, rename or unshare a
-- deck, reset a display name, switch off one member's sharing or trade
-- posting, and suspend (reversible). A moderator cannot: see billing or the
-- business view, grant credits, change anyone's role, set AI budgets,
-- reset passwords, or delete a member — every one of those is either money
-- or irreversible.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'moderator', 'member'));

-- The content-moderation test, used by RLS wherever an admin could already
-- remove someone else's content. is_admin() is left exactly as it was, so
-- everything gated on real admin (billing, member management) is untouched
-- by the existence of moderators.
create or replace function public.is_moderator()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'moderator')
  );
$$;

-- Trade board: same rule, widened from admin to moderator.
drop policy if exists "owners and admins delete trade posts" on public.trade_posts;
create policy "owners and admins delete trade posts"
  on public.trade_posts for delete to authenticated
  using (user_id = auth.uid() or public.is_moderator());

drop policy if exists "owners and admins delete trade comments" on public.trade_post_comments;
create policy "owners and admins delete trade comments"
  on public.trade_post_comments for delete to authenticated
  using (user_id = auth.uid() or public.is_moderator());
