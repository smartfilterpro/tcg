-- 027: Stripe billing state.
--
-- Stripe is the source of truth for subscriptions; these columns are the
-- cached projection the app reads. All of them are written ONLY by the
-- webhook and billing routes (service role) — never by clients.

alter table public.profiles
  add column if not exists stripe_customer text,
  add column if not exists stripe_subscription text,
  -- Set when the user cancels: access continues to the end of the paid
  -- period, and the subscription.deleted webhook drops the plan afterwards.
  add column if not exists plan_expires_at timestamptz,
  -- The Stripe billing period start. Once present, credit cycles anchor to
  -- this instead of the signup date, so grants line up with invoices.
  add column if not exists billing_anchor timestamptz;

revoke update (stripe_customer, stripe_subscription, plan_expires_at, billing_anchor)
  on public.profiles from authenticated;

-- Ties a pending boost row to the Checkout Session that will (or won't) pay
-- for it. Unique so a replayed webhook finds exactly one row to fulfil.
alter table public.boost_purchases
  add column if not exists stripe_checkout_session text;

create unique index if not exists boost_purchases_session_idx
  on public.boost_purchases (stripe_checkout_session)
  where stripe_checkout_session is not null;
