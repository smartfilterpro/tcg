-- Read-only. Paste into the Supabase SQL editor. Changes nothing.
--
-- Answers, in order: do the rows still exist at all, and if so are they
-- attached to the account you're signing in as?

-- 1. Every account, with what it owns. If your decks and grades show up on a
--    row whose email is yours but whose id you are NOT signing in as, the
--    data is safe and the problem is which account the session is on.
select
  p.id,
  p.email,
  p.created_at,
  (select count(*) from public.decks          d where d.user_id = p.id) as decks,
  (select count(*) from public.grade_reports  g where g.user_id = p.id) as grades,
  (select count(*) from public.collection_items c where c.user_id = p.id) as cards
from public.profiles p
order by p.created_at;

-- 2. Totals, ignoring ownership. If these are non-zero, nothing was deleted —
--    it is a visibility or account problem, not data loss.
select
  (select count(*) from public.decks)         as decks_total,
  (select count(*) from public.grade_reports) as grades_total,
  (select count(*) from public.collection_items) as cards_total;

-- 3. Rows whose owner has no profile row. These are invisible to the app
--    (every read joins on the signed-in id) but the data is still here.
select 'decks' as tbl, d.user_id, count(*)
  from public.decks d
  left join public.profiles p on p.id = d.user_id
 where p.id is null group by d.user_id
union all
select 'grade_reports', g.user_id, count(*)
  from public.grade_reports g
  left join public.profiles p on p.id = g.user_id
 where p.id is null group by g.user_id;

-- 4. Duplicate accounts for the same person — the usual cause of "everything
--    vanished" right after an auth or redirect change.
select email, count(*) as accounts, array_agg(id) as ids
from auth.users
group by email having count(*) > 1;

-- 5. Is row-level security hiding rows the tables still hold? Compare what
--    the service role sees (above) with what your session sees. Run this
--    while signed in as yourself via the app's PostgREST, not the editor.
select relname, relrowsecurity
from pg_class
where relname in ('decks', 'grade_reports', 'collection_items');
