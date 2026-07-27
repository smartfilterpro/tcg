-- Let participants clear out finished trade requests.
-- Run this in the Supabase SQL editor after 013_trade_offers.sql.

-- Pending offers can't be deleted (withdraw/decline them first); resolved
-- ones can be removed by either participant. Deleting removes the record
-- for both sides.
create policy "participants delete resolved trade offers"
  on public.trade_offers for delete to authenticated
  using (
    (from_user = auth.uid() or to_user = auth.uid())
    and status <> 'pending'
  );
