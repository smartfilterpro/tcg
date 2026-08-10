-- Let a household see each other's decks.
--
-- A family plan is one household on one bill, and the decks are the reason
-- most of them are here. A parent helping a nine-year-old pick between two
-- builds shouldn't have to ask them to share it first, and the sharing
-- controls that exist — everyone, pals only, direct share — are all aimed at
-- people outside the house. Inside it, "share this with your dad" is
-- friction standing in front of the thing the plan was bought for.
--
-- Read-only, and only within the group. Nothing here grants insert, update
-- or delete: those policies still say user_id = auth.uid(), so a sibling can
-- admire a deck and cannot touch it.
--
-- SECURITY DEFINER for the same reason migration 022 needed it: a policy on
-- decks that reads family_members, while family_members has policies of its
-- own, is how you get "infinite recursion in policy for relation decks" and
-- every deck in the app appearing to vanish. The function bypasses RLS
-- internally, so neither table's policy can re-enter the other.

create or replace function public.shares_family_with(other uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.family_members mine
    join public.family_members theirs
      on theirs.group_id = mine.group_id
     and theirs.user_id <> mine.user_id
    where mine.user_id = auth.uid()
      and theirs.user_id = other
  );
$$;

-- Permissive SELECT policies are OR'd together, so this widens what can be
-- read without disturbing the owner-only and share-scope policies already
-- there.
drop policy if exists "family decks viewable" on public.decks;
create policy "family decks viewable" on public.decks
  for select to authenticated
  using (public.shares_family_with(user_id));

comment on function public.shares_family_with(uuid) is
  'True when the caller and the given user are different members of the same family group.';
