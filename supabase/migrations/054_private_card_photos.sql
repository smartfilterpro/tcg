-- Close the card-photos bucket.
--
-- 005 created it public, with a "card photos public read" policy that let
-- anyone select any object in it. The URLs are long and unguessable and
-- nothing in the app lists them, so this was never an active leak — but it
-- meant that every photo a member ever took, including the front and back
-- of a card they submitted for grading (with whatever else was on the
-- table), was readable by anybody who came by the address, signed in or
-- not. Security audit finding H2.
--
-- After this, nothing in the bucket is reachable by URL. The app serves
-- these photos through /api/photo, which authenticates the viewer, decides
-- whether they may see that particular object, and redirects to a signed
-- link that expires within the hour.
--
-- Existing objects are untouched: their stored URLs stay exactly as they
-- are, because those URLs are the identifier the catalogue and the grade
-- reports were written with. They simply stop resolving on their own.
--
-- The sibling bucket card-art (037) stays public on purpose — it holds
-- mirrored artwork from the card databases, which is public information
-- that was public at its source.

update storage.buckets set public = false where id = 'card-photos';

drop policy if exists "card photos public read" on storage.objects;

-- Reads now go through the service role, which is what /api/photo uses
-- after it has decided the request is allowed — so this policy is not on
-- the path the app takes. It is here so that a direct client-side read,
-- with a member's own token, can still only ever reach that member's own
-- folder. Defence in depth for the day somebody adds one.
create policy "card photos read own folder"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
