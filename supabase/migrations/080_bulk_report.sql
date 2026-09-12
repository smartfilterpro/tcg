-- The customer-facing scan report. A bulk job that was uploaded into a
-- member's collection can mint a share token; the link shows every card
-- with its scan photo beside the catalogue card, so the person whose
-- cards were scanned can verify the work without an account or a login.
alter table public.bulk_jobs add column if not exists report_token text;
