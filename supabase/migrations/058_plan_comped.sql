-- Which plans were given rather than sold.
--
-- Admins and moderators run the place; charging them for it makes no sense,
-- and neither does counting what they were given as money that came in.
-- Revenue is derived from monthly_grant rows mapped back to a plan price,
-- so without this flag every comped account would report $9 or $19 a month
-- of income that never existed — and the operator's own Family plan would
-- be the largest fictional customer on the chart.
--
-- Set when an admin sets a plan by hand. Cleared whenever Stripe sets one,
-- because a comped account that later actually subscribes is a real
-- customer from that moment.

alter table public.profiles
  add column if not exists plan_comped boolean not null default false;

comment on column public.profiles.plan_comped is
  'True when the plan was granted by an admin rather than paid for. Excluded from revenue.';
