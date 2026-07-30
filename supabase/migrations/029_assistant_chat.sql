-- 029: the always-available Trainer AI chat.
--
-- One rolling conversation per user rather than threads. The point is that it
-- remembers you — what you asked last week, which decks you keep coming back
-- to — so a thread list would fragment exactly the context that makes it
-- useful.

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  /** Set when the message never reached the model — refused by the scope
   *  guard. Kept so the conversation reads back correctly, and so it is
   *  possible to see what people try to use this for. */
  refused boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists assistant_messages_user_idx
  on public.assistant_messages (user_id, created_at);

alter table public.assistant_messages enable row level security;

-- Read and delete your own. Writes are service-role only: the assistant's
-- replies must come from the API, not from a client that could forge a turn
-- and poison its own history.
create policy "own assistant messages read" on public.assistant_messages
  for select to authenticated using (user_id = auth.uid());
create policy "own assistant messages delete" on public.assistant_messages
  for delete to authenticated using (user_id = auth.uid());
