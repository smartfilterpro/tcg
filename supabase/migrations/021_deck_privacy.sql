-- 021: make deck visibility actually respect sharing settings.
-- The original schema (001) let EVERY signed-in member read EVERY deck
-- ("decks viewable by authenticated users" using (true)), which silently
-- defeats both the shared flag and the new pals-only scope from 020.
-- Replace it with owner-only reads; sharing visibility comes from the
-- scope-aware policy created in 020 (or 008's policy if 020 isn't run yet).

drop policy if exists "decks viewable by authenticated users" on public.decks;

create policy "own decks viewable" on public.decks
  for select to authenticated using (user_id = auth.uid());
