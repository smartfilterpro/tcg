-- 069: the deck coach remembers the conversation.
--
-- The coach used to be one question, one answer, wiped by the next question
-- — every follow-up started from nothing, so "ok, and what about water
-- decks?" read as a brand-new question about nothing. This table is the
-- thread: one row per message, per member, per deck, so a conversation
-- survives closing the deck, switching devices, and coming back next week.
--
-- Private per member on purpose: a family-shared deck can be read by the
-- household, but your questions about it are yours.

create table if not exists public.deck_chat_messages (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists deck_chat_messages_idx
  on public.deck_chat_messages (deck_id, user_id, created_at);

alter table public.deck_chat_messages enable row level security;

-- Members read and clear their own threads. INSERTS come only from the
-- service role (the coach writes both sides of each exchange after the
-- answer lands) — a client that could write assistant rows could put words
-- in the coach's mouth for the approval UI to trust.
create policy "own deck chat read" on public.deck_chat_messages
  for select to authenticated using (user_id = auth.uid());
create policy "own deck chat clear" on public.deck_chat_messages
  for delete to authenticated using (user_id = auth.uid());
