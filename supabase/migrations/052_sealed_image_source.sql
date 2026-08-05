-- Where a sealed product's picture came from.
--
-- Sealed art has two sources and they are not equal. The paid catalogue
-- carries the official product shot — the box, straight on, on white. eBay
-- carries whatever the seller photographed, which is sometimes the box in a
-- car footwell at an angle with a thumb in shot. Both end up in image_url and
-- until now nothing recorded which was which.
--
-- That mattered because the picture is written once and never replaced: the
-- rule is "only fill a picture we don't have", so that a product's photo
-- doesn't change under its owner every time somebody presses Check price.
-- Sensible, except that a product priced from eBay before the paid catalogue
-- knew about it was stuck with the seller's photograph for ever, however good
-- a picture turned up later.
--
-- With the source recorded, one upgrade becomes possible and only one: a
-- listing photo may be replaced by an official product shot. Nothing replaces
-- an official shot, and nothing replaces a picture a person chose.

alter table public.sealed_products
  add column if not exists image_source text;

comment on column public.sealed_products.image_source is
  'Where image_url came from: pricetracker (official product shot), ebay (listing photo), or member (uploaded). Only an ebay picture may be upgraded.';

-- Backfill the ones we can infer. `source` records where the PRICE came from,
-- and until now the image always arrived on the same fetch, so for existing
-- rows it names the image's source too. Rows with a picture and no source
-- stay null, which the upgrade rule treats as "replaceable" — the same as
-- eBay, because an unknown provenance is not evidence of a good picture.
update public.sealed_products
   set image_source = source
 where image_url is not null
   and image_source is null
   and source in ('ebay', 'pricetracker');
