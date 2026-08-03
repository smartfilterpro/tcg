-- A record of every card merge, so one can be undone.
--
-- Merging deletes a row and repoints whatever people owned onto the
-- survivor. Until now nothing was written down about it, which means a
-- wrong merge — and the grouping that drove it has been wrong, collapsing
-- "112a" onto "112" and treating a full art as a duplicate of its plain
-- version — was simply unrecoverable. The card could be re-imported; who
-- owned which printing could not.
--
-- So the whole twin row is kept, verbatim, along with the collection
-- entries that moved and what happened to each. That is enough to put
-- everything back: recreate the row from `twin`, then walk `items` and
-- restore each entry's card_id and quantity.
--
-- Deliberately NOT a foreign key to cards: the twin no longer exists, and
-- the survivor might later be merged itself. This is a log, and a log that
-- can be broken by later edits is not a log.

create table if not exists public.card_merges (
  id uuid primary key default gen_random_uuid(),
  merged_at timestamptz not null default now(),
  merged_by uuid references auth.users(id) on delete set null,
  -- Which tool did it: 'admin' for the dedupe panel, 'import' for the
  -- automatic tcgp- fold that runs on every imported page.
  source text not null default 'admin',
  survivor_id text not null,
  twin_id text not null,
  /** The deleted row exactly as it was. */
  twin jsonb not null,
  /** Every collection entry that moved: its id, owner, variant, the
   *  quantity before, and whether it was repointed or folded into an
   *  existing row. */
  items jsonb not null default '[]'::jsonb,
  /** Set once an undo has been applied, so the same merge is not reversed
   *  twice. */
  reverted_at timestamptz
);

create index if not exists card_merges_at_idx on public.card_merges (merged_at desc);
create index if not exists card_merges_twin_idx on public.card_merges (twin_id);

alter table public.card_merges enable row level security;

-- Admin-only, and written by the server (service role bypasses RLS).
drop policy if exists "admins read card merges" on public.card_merges;
create policy "admins read card merges"
  on public.card_merges for select
  using (public.is_admin());

comment on table public.card_merges is
  'Undo log for card merges. Holds the deleted row and the collection entries that moved.';
