-- 025: one capitalisation per rarity.
--
-- The two card databases disagree: pokemontcg.io writes "Double Rare" and
-- "Illustration Rare", TCGdex writes "Double rare" and "Illustration rare".
-- Both spellings were stored verbatim, so the collection's rarity filter
-- listed each one twice with the cards split between the two entries.
--
-- New saves are normalised in the app; this brings existing rows into line.
-- initcap() title-cases each word, then ACE SPEC is restored — it's an
-- acronym, not a word.
--
-- Idempotent: re-running changes nothing once the rows are canonical.

update public.cards
set rarity = replace(initcap(rarity), 'Ace Spec', 'ACE SPEC')
where rarity is not null
  and rarity <> replace(initcap(rarity), 'Ace Spec', 'ACE SPEC');
