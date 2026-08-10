-- Let a household see each other's collections — and stop everyone else.
--
-- Two changes, and the second is the urgent one.
--
-- 1. Family visibility, matching what 060 did for decks. A parent working out
--    whether a trade is fair, or whether the card their kid wants is already
--    in the house, shouldn't have to ask them to flip a sharing switch first.
--
-- 2. Migration 001 created "collections viewable by authenticated users" with
--    using (true) — every signed-in account could read every other account's
--    entire collection. Migration 021 found and fixed exactly this for decks
--    and nobody did the same for collections, so it has been open the whole
--    time. It also makes the share_collection opt-in a decoration: 008 added
--    a policy for opted-in sharing, but permissive policies are OR'd, so the
--    blanket one granted everything the narrow one was carefully withholding.
--
--    Nothing in the app relied on it. Friends' collections are read through
--    /api/friends/[id]/collection, which checks share_collection itself and
--    is served by 008's policy; everything else reads either your own rows or
--    goes through the service role.
--
-- Read-only again: insert, update and delete still require user_id =
-- auth.uid(), so nobody can spend a sibling's cards or edit their quantities.

drop policy if exists "collections viewable by authenticated users"
  on public.collection_items;

drop policy if exists "family collections viewable" on public.collection_items;
create policy "family collections viewable"
  on public.collection_items for select to authenticated
  using (public.shares_family_with(user_id));

-- Required, not tidiness. The blanket policy dropped above was the ONLY one
-- letting you read your own rows: 008's covers opted-in sharing and the one
-- above covers family, and neither says "mine". Without this, the first
-- account to load its collection after running this migration would find it
-- empty — which is exactly the shape of the 022 incident, and the reason
-- that migration's header still shouts.
drop policy if exists "own collection viewable" on public.collection_items;
create policy "own collection viewable"
  on public.collection_items for select to authenticated
  using (user_id = auth.uid());
