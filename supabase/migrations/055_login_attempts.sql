-- Rate limiting for sign-in. Security audit finding H1.
--
-- /api/auth/login validated the email shape and the password length and
-- then handed both to Supabase, as many times a second as anyone cared to
-- ask. Supabase applies its own limits upstream, so this was throttled —
-- but by a provider default nobody here set, monitors, or would notice
-- changing. This adds our own, which we can see.
--
-- One row per key. A key is an email or an IP, and a failed sign-in
-- increments both: the email key stops a run at one account, the IP key
-- stops one machine working through a list of accounts.

create table if not exists public.login_attempts (
  key text primary key,
  failures int not null default 0,
  first_failure_at timestamptz not null default now(),
  last_failure_at timestamptz not null default now(),
  locked_until timestamptz
);

create index if not exists login_attempts_last_failure_idx
  on public.login_attempts (last_failure_at);

-- Service role only. The route reads and writes this before anyone is
-- authenticated, so there is no member here to write a policy about.
alter table public.login_attempts enable row level security;

-- Count a failure and say whether that key is now locked.
--
-- One statement rather than read-then-write: a hundred parallel guesses
-- would otherwise all read "3 failures" and all write "4", and the counter
-- would measure concurrency instead of attempts.
create or replace function public.note_login_failure(
  p_key text,
  p_window interval,
  p_max int,
  p_lock interval
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_failures int;
  v_locked timestamptz;
begin
  insert into public.login_attempts (key, failures, first_failure_at, last_failure_at)
  values (p_key, 1, now(), now())
  on conflict (key) do update set
    -- A quiet window forgets what came before it, including the lock it
    -- ended with. Otherwise a member who was locked out this morning is
    -- still carrying it tonight.
    failures = case
      when login_attempts.first_failure_at < now() - p_window then 1
      else login_attempts.failures + 1 end,
    first_failure_at = case
      when login_attempts.first_failure_at < now() - p_window then now()
      else login_attempts.first_failure_at end,
    locked_until = case
      when login_attempts.first_failure_at < now() - p_window then null
      else login_attempts.locked_until end,
    last_failure_at = now()
  returning failures, locked_until into v_failures, v_locked;

  if v_failures >= p_max then
    update public.login_attempts
      set locked_until = greatest(coalesce(locked_until, now()), now() + p_lock)
      where key = p_key
      returning locked_until into v_locked;
  end if;

  -- Housekeeping, here because failures are rare and this table should
  -- never grow: a key nobody has failed against in a day is finished.
  delete from public.login_attempts where last_failure_at < now() - interval '1 day';

  return v_locked;
end;
$$;

revoke all on function public.note_login_failure(text, interval, int, interval) from public, anon, authenticated;
