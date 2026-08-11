-- Clear prices no card of that rarity could carry.
--
-- Commons and uncommons in a current set were showing hundreds of dollars
-- each. The database says why: in Ascended Heroes, Shuppet (#90, Common) and
-- Mega Dragonite ex (#290, a secret rare) both held $706.96 — identical to
-- the cent — and Togetic (#81) matched Team Rocket's Mewtwo ex (#281) at
-- $383.97. Cards two hundred apart in the numbering, sharing a price exactly.
-- That is a card wearing another card's product, somewhere upstream of us.
--
-- The guard added alongside this migration stops such a number being written
-- again — it goes to the admin review queue instead. But a guard on the write
-- path cannot touch what is already stored, and these are already stored, on
-- every affected card, in everybody's collection total.
--
-- So: clear them. Not "correct" them — we don't know the right number, and
-- inventing one would be the same mistake in a different direction. Nulling
-- market_price puts the card back to "no price yet", which the collection
-- page already handles, counts and can filter by. The next refresh re-derives
-- it, and anything still implausible is held for review rather than applied.
--
-- Scoped to bulk rarities over $50 so it cannot touch a genuinely valuable
-- card. A Common worth more than that exists — some do — and the cost of
-- catching one is that it gets re-fetched and, if the sources agree it really
-- is worth that, reviewed once. Cheap, next to a collection total that is
-- wrong by four figures.
--
-- Deliberately does NOT clear price_updated_at. The queue is ordered by it,
-- so wiping it would send every affected card to the front and starve the
-- rest of the collection; leaving it means they refresh in their normal turn.
-- Pressing "Refresh prices" reaches them immediately either way.

update public.cards
set market_price = null
where market_price > 50
  and lower(trim(coalesce(rarity, ''))) in ('common', 'uncommon');
