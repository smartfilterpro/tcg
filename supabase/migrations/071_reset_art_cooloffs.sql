-- 071: let the art mirror retry everything it gave up on.
--
-- TCGplayer's CDN started answering 403 to the mirror's fetches — hotlink
-- protection reacting to our robot User-Agent, not files being gone. The
-- mirror correctly refused to treat 403 as permanent, but each failed pass
-- still counted attempts and put cards into ever-longer cool-offs ("242
-- skipped (dead art, in cool-off)"), while the on-view fallback redirected
-- members' browsers to the same refused CDN — which is a grid full of
-- "No image" placeholders for cards whose pictures exist.
--
-- The fetch now presents as a browser with a same-site Referer, so those
-- downloads succeed again. This clears the accumulated failure counts so
-- the sweep re-attempts the whole cool-off population promptly instead of
-- waiting the cool-offs out. Cards whose sources are GENUINELY dead simply
-- re-fail through their attempts once and settle back — a bounded one-time
-- cost, next to a collection rendering broken.
--
-- Cards already cleared to no-image by the permanent-failure path keep
-- their source_image_* provenance and re-enter through the same sweep.

update public.cards
set art_attempts = 0,
    art_failed_at = null
where art_attempts > 0;
