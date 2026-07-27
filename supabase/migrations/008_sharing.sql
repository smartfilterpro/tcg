-- Sharing & trading: opt-in collection sharing and shareable decks.
-- Run this in the Supabase SQL editor after 007_image_curation.sql.

-- Opt-in: members can share their collection with the group (needed for trades)
alter table public.profiles
  add column if not exists share_collection boolean not null default false;

-- Decks can be shared with the group (read-only for everyone else)
alter table public.decks
  add column if not exists shared boolean not null default false;

-- Members can view collections whose owner has opted into sharing
create policy "shared collections viewable by members"
  on public.collection_items for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = collection_items.user_id and p.share_collection
    )
  );

-- Members can view decks marked shared
create policy "shared decks viewable by members"
  on public.decks for select to authenticated
  using (shared);
