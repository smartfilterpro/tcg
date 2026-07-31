-- 038: per-member moderation switches.
--
-- Suspension is the hammer; these are the scalpels. A member who shares
-- decks with inappropriate names loses sharing; one who abuses the trade
-- board loses posting. Everything else about their account keeps working,
-- which is the point — the punishment fits the surface being abused.
-- Enforced in the API routes (deck share PATCH, market POST); the admin
-- flips them from the Members panel.

alter table public.profiles
  add column if not exists can_share_decks boolean not null default true,
  add column if not exists can_post_trades boolean not null default true;
