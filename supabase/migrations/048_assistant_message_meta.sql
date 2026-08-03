-- Structured payloads attached to an assistant message.
--
-- The first use is a proposed deck edit: TrainerAI describes a change, the
-- player approves it, and only then does anything get written. That
-- proposal has to OUTLIVE the reply — the assistant answers through a job,
-- so the message lands in history and the player may well read it after
-- reloading. A proposal held only in the response body would leave an
-- approval button that vanishes on refresh, or worse, one that survives in
-- the UI with nothing behind it.
--
-- Deliberately a loose jsonb rather than columns for this one shape. What
-- an assistant message needs to carry alongside its text will keep
-- changing, and a migration per idea is how a chat table ends up thirty
-- columns wide with twenty-eight of them null.

alter table public.assistant_messages
  add column if not exists meta jsonb;

comment on column public.assistant_messages.meta is
  'Structured payload for the message — currently a proposed deck edit awaiting approval.';
