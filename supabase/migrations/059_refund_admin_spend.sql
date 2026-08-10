-- Give a family pool back what its admin's AI spend took out of it.
--
-- debitCredits now returns early for admins, so nothing new is being taken.
-- That stopped the leak; it did not refill the tank. Every debit written
-- before that fix is still sitting in the ledger, and because a family
-- balance is the sum of the whole group's rows, an admin who owns a pool had
-- already spent the household's month. The symptom is a child being told
-- they are out of credits for work a parent did — on this project, a pool of
-- 1,500 sitting at -1,493 with the other parent at 0 of 1,500.
--
-- Reversed with compensating rows rather than deletions. The ledger is an
-- account: the debits happened, they are what ai_usage says they cost, and
-- the honest correction is an entry that says so. It also keeps the admin's
-- own usage visible on the family page, which reads spend from the negative
-- rows and would otherwise show them as having done nothing all month.
--
-- Not every negative row is AI spend. 'plan_expired' is credits timing out
-- at the end of a cycle and 'admin_adjustment' is a deduction somebody made
-- on purpose; refunding either would invent credits.
--
-- Safe to run twice. The amount is what is owed *after* previous refunds, so
-- a second run on a later day tops up anything since, and the unique index on
-- (user_id, reason, ref_id) makes a same-day re-run do nothing at all.

with tally as (
  select
    l.user_id,
    -coalesce(
      sum(l.delta) filter (
        where l.delta < 0
          and l.reason not in ('plan_expired', 'admin_adjustment')
      ),
      0
    ) as spent,
    coalesce(sum(l.delta) filter (where l.reason = 'admin_unmetered'), 0) as refunded
  from public.credit_ledger l
  join public.profiles p on p.id = l.user_id
  where p.role = 'admin'
  group by l.user_id
)
insert into public.credit_ledger (user_id, delta, reason, ref_id)
select
  user_id,
  spent - refunded,
  'admin_unmetered',
  to_char(now(), 'YYYY-MM-DD')
from tally
where spent - refunded > 0
on conflict do nothing;
