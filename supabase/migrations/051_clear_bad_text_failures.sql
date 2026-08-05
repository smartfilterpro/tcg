-- Forget the failures a broken reader recorded.
--
-- 050 gave the app a memory of which cards can't be read from their own
-- picture: two failed reads and the card rests for a week, so an unreadable
-- card isn't re-read on every question about it. That is the right rule.
--
-- It was recording the wrong thing. Every vision read in the app was failing
-- before it started, on a schema the API refuses:
--
--   400 output_config.format.schema: For 'array' type, property 'maxItems'
--       is not supported
--
-- The request never reached a model. The card was never looked at. But the
-- failure was counted against the CARD, so a perfectly legible Haunter has a
-- record saying it can't be read — and would go on saying so for a week
-- after the fix, on cards nobody ever actually tried.
--
-- So the counters go back to zero. Nothing else is touched: battle_data that
-- was successfully read stays, and the cool-off machinery keeps working for
-- the genuine failures it was built for. A card that really is unreadable
-- will earn its record back on the next attempt, honestly this time.

update public.cards
   set text_attempts = 0,
       text_failed_at = null
 where text_attempts > 0
    or text_failed_at is not null;
