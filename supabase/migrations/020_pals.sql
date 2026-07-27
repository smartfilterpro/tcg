-- 020: Pokémon Pals — a friendship tier above group-wide sharing.
-- Pals are mutual (request + accept). Being pals unlocks direct messaging
-- and lets decks be shared to "pals only" or to one specific pal, instead
-- of the whole group.

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester <> addressee)
);

-- One friendship per pair, whichever direction it was requested in
create unique index friendships_pair_idx on public.friendships
  (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

create policy "friendships visible to participants" on public.friendships
  for select using (auth.uid() = requester or auth.uid() = addressee);
create policy "friendships request" on public.friendships
  for insert with check (auth.uid() = requester);
create policy "friendships answer" on public.friendships
  for update using (auth.uid() = addressee or auth.uid() = requester);
create policy "friendships remove" on public.friendships
  for delete using (auth.uid() = requester or auth.uid() = addressee);

-- Direct messages between pals (thread per friendship)
create table public.friend_messages (
  id uuid primary key default gen_random_uuid(),
  friendship_id uuid not null references public.friendships (id) on delete cascade,
  sender uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index friend_messages_thread_idx on public.friend_messages (friendship_id, created_at);

alter table public.friend_messages enable row level security;

create policy "friend messages visible to participants" on public.friend_messages
  for select using (
    exists (
      select 1 from public.friendships f
      where f.id = friend_messages.friendship_id
        and (f.requester = auth.uid() or f.addressee = auth.uid())
    )
  );
create policy "friend messages send" on public.friend_messages
  for insert with check (
    sender = auth.uid()
    and exists (
      select 1 from public.friendships f
      where f.id = friend_messages.friendship_id
        and f.status = 'accepted'
        and (f.requester = auth.uid() or f.addressee = auth.uid())
    )
  );

-- Deck sharing scope: who a shared deck is visible to
alter table public.decks
  add column if not exists share_scope text not null default 'everyone'
  check (share_scope in ('everyone', 'friends'));

-- Direct grants: share a deck with one specific person
create table public.deck_shares (
  deck_id uuid not null references public.decks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);

alter table public.deck_shares enable row level security;

create policy "deck shares visible" on public.deck_shares
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.decks d where d.id = deck_shares.deck_id and d.user_id = auth.uid())
  );
create policy "deck shares managed by owner" on public.deck_shares
  for insert with check (
    exists (select 1 from public.decks d where d.id = deck_shares.deck_id and d.user_id = auth.uid())
  );
create policy "deck shares removed by owner" on public.deck_shares
  for delete using (
    exists (select 1 from public.decks d where d.id = deck_shares.deck_id and d.user_id = auth.uid())
  );

-- Replace the everyone-can-see-shared policy with scope-aware visibility:
-- everyone-scope decks stay group-visible; friends-scope decks need an
-- accepted friendship; direct grants always work.
drop policy if exists "shared decks viewable by members" on public.decks;

create policy "shared decks viewable by scope" on public.decks
  for select to authenticated
  using (
    (shared and share_scope = 'everyone')
    or (
      shared and share_scope = 'friends'
      and exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester = auth.uid() and f.addressee = decks.user_id)
            or (f.addressee = auth.uid() and f.requester = decks.user_id))
      )
    )
    or exists (
      select 1 from public.deck_shares s
      where s.deck_id = decks.id and s.user_id = auth.uid()
    )
  );
