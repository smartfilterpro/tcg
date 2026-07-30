-- 037: our own copy of the card artwork.
--
-- The catalogue has always stored image URLs pointing at third-party hosts
-- (pokemontcg.io, TCGdex, the price tracker's CDN), which made every card
-- picture a render-time dependency on someone else's server — and
-- pokemontcg.io's bad days are already on record in this repo. Owner
-- decision: mirror the art into our own storage and rely on them less.
--
-- The mirror job (admin panel) downloads each card's images into this
-- bucket and repoints the row. The original URL is kept in source_image_*
-- so nothing is lost and a re-mirror can refresh from the source.

insert into storage.buckets (id, name, public)
values ('card-art', 'card-art', true)
on conflict (id) do nothing;

-- Anyone can view (the bucket serves card images to the app). No insert
-- policy: only the mirror job writes, with the service role.
drop policy if exists "card art public read" on storage.objects;
create policy "card art public read"
  on storage.objects for select
  using (bucket_id = 'card-art');

alter table public.cards
  add column if not exists source_image_small text,
  add column if not exists source_image_large text;
