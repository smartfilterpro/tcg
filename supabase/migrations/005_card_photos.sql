-- Storage bucket for user-taken card photos (used when the card databases
-- have no image — most promos, and all manually-entered cards).
-- Run this in the Supabase SQL editor after 004_price_override.sql.

insert into storage.buckets (id, name, public)
values ('card-photos', 'card-photos', true)
on conflict (id) do nothing;

-- Signed-in users upload into their own folder; anyone can view (the bucket
-- serves card images to the app).
create policy "card photos upload own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "card photos public read"
  on storage.objects for select
  using (bucket_id = 'card-photos');
