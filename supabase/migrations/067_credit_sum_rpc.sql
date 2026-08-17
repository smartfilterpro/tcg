-- 067: sum the credit ledger in the database, not in Node.
--
-- Balances are derived by summing credit_ledger, and that sum ran as a paged
-- SELECT of every row's delta — pulled over the wire 1,000 rows at a time,
-- added up in JavaScript, on EVERY AI call and every page that shows the
-- meter. A ledger gains a row per call, so the cost of checking the balance
-- grew with every use of the thing it was checking. Postgres has an
-- aggregate for this; one round trip, a few bytes back, served by the
-- (user_id, created_at) index that has been there since 026.
--
-- Plain invoker rights on purpose: the only caller is the service role
-- (src/lib/credits.ts), and granting EXECUTE to authenticated would let any
-- member sum any user id they liked.
create or replace function public.sum_credit_deltas(
  p_user_ids uuid[],
  p_since timestamptz default null,
  p_negative_only boolean default false
) returns bigint
language sql
stable
as $$
  select coalesce(sum(delta), 0)::bigint
  from public.credit_ledger
  where user_id = any(p_user_ids)
    and (p_since is null or created_at >= p_since)
    and (not p_negative_only or delta < 0);
$$;

revoke execute on function public.sum_credit_deltas(uuid[], timestamptz, boolean) from public;
revoke execute on function public.sum_credit_deltas(uuid[], timestamptz, boolean) from anon;
revoke execute on function public.sum_credit_deltas(uuid[], timestamptz, boolean) from authenticated;
