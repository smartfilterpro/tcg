-- When was the export link last used? Security audit finding M4.
--
-- The token is a bearer credential with no expiry, which is the right
-- shape for what it does — it lives in a URL somebody pastes into an
-- external tool, and a link that stops working next Tuesday is a link
-- nobody trusts. What was missing is any way to notice it had been taken.
--
-- So: not an expiry, but a witness. Settings now shows when the link was
-- last used, which turns "somebody has my token" from invisible into
-- something a member can see and rotate away from.

alter table public.api_tokens
  add column if not exists last_used_at timestamptz;
