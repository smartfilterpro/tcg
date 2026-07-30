-- 028: friend codes, and consent to be added at all.
--
-- Pal requests used to work by browsing: GET /api/friends/requests returned a
-- `candidates` list of every other member, and you picked someone out of it.
-- That makes the whole membership directory readable by anyone with an
-- account, which is the wrong default for any app and a bad one for an app
-- children use.
--
-- Now you reach someone only if they have handed you their code — typed,
-- followed as a link, or scanned. There is no lookup by name and no list.

alter table public.profiles
  -- Crockford base32, stored bare and uppercase; the dashes are display only.
  add column if not exists friend_code text,
  -- The master switch. Off means nobody can send you a request even holding
  -- your code, AND you cannot send one either: the rule is reciprocal, so
  -- turning it off removes you from the system rather than making you a
  -- one-way sender. Defaults on, because the code is already the barrier —
  -- this is the stronger "not at all" lock on top of it.
  add column if not exists allow_friend_requests boolean not null default true;

create unique index if not exists profiles_friend_code_idx
  on public.profiles (friend_code) where friend_code is not null;

-- Codes are minted server-side and are an identifier, not a preference: a
-- client that could rewrite its own would be able to squat someone else's.
revoke update (friend_code) on public.profiles from authenticated;

-- Resolve a code to a user without exposing the profiles table.
--
-- Security definer so it can read past RLS, but it returns ONLY the id and
-- display name of an exact, whole-code match, and nothing at all when the
-- holder has requests switched off. There is no prefix search and no listing,
-- so it cannot be walked to enumerate members — a guess costs a full 8
-- characters out of 32^8.
create or replace function public.find_by_friend_code(code text)
returns table (id uuid, display_name text)
language sql security definer set search_path = public stable as $$
  select p.id,
         coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1))
  from public.profiles p
  where p.friend_code = upper(btrim(code))
    and p.allow_friend_requests
  limit 1;
$$;

revoke all on function public.find_by_friend_code(text) from public;
grant execute on function public.find_by_friend_code(text) to authenticated;
