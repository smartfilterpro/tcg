-- Clear prices that two different cards are somehow sharing.
--
-- 063 cleared bulk rarities over $50 and got most of them, but it was aiming
-- at the wrong thing. Mismagius #86 survived at $170.55 because it is a Rare
-- rather than a Common — and rarity was never what was wrong with it.
--
-- What IS wrong with it is the thing every one of these has in common: two
-- different cards in one set holding a byte-identical price. Shuppet #90 and
-- Mega Dragonite ex #290 at $706.96. Togetic #81 and Team Rocket's Mewtwo ex
-- #281 at $383.97. Mismagius #86 and, presumably, #286 at $170.55. That is a
-- card wearing another card's product, and it is visible in our own data
-- without needing to know which upstream mapping went wrong or what any
-- given card's rarity implies.
--
-- Two real cards landing on the same market price to the cent is close to
-- impossible above a few dollars, and the cost of being wrong is a re-fetch.
-- So this is a far more precise instrument than a rarity ceiling: it makes no
-- assumption about what a Rare is worth, in a modern set or a vintage one.
--
-- Above $5 only. Cheap cards share prices constantly and legitimately — half
-- a set's commons sit at $0.12 — and those collisions mean nothing.
--
-- Both sides of the pair are cleared, deliberately. One of the two numbers is
-- probably right, but nothing here can tell which, and keeping a coin-flip is
-- worse than admitting we don't know. The refresh re-derives both.

update public.cards c
set market_price = null
where c.market_price > 5
  and exists (
    select 1
    from public.cards other
    where other.id <> c.id
      and other.set_name is not distinct from c.set_name
      and other.market_price = c.market_price
  );
