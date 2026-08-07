# TrainerDeck — Security & Production-Readiness Audit

**Date:** 2026-08-07
**Repo:** `/home/user/tcg` (branch `claude/pokemon-card-scanner-deck-csp2lv`)
**Auditor:** automated skill run + manual review

---

## Repo overview

TrainerDeck is a Next.js 15 / React 19 application (App Router, TypeScript, Tailwind)
deployed to Railway. It catalogues Pokémon trading cards: members photograph a pile,
Claude vision identifies the cards, and the app tracks quantities, finishes and market
value, builds decks, runs battles, brokers trades between members and estimates grading
outcomes.

Persistence and auth are Supabase (Postgres + Auth + Storage), payments are Stripe,
AI is Anthropic, and card/price data comes from five external sources (pokemontcg.io,
TCGdex, Pokémon Price Tracker, PokeTrace, eBay). There are **97 API routes**, 26 pages,
65 library modules and 53 SQL migrations. No Dockerfile; Railway builds from source.
A GitHub Actions workflow drives a scheduled price refresh.

## Scope reviewed

- All 97 route handlers under `src/app/api/**` checked for an authentication gate
- `src/middleware.ts` — the public-path allowlist and the terms gate
- `src/lib/auth.ts` — `requireUser` / `requireAdmin` / `requireModerator`
- `src/lib/supabase/admin.ts` — service-role client and every importer of it
- Authentication endpoints: login, signup, callback, reset
- The five self-authenticating endpoints (Stripe webhook, cron, eBay, bulk feeder, export token)
- Secrets: `.gitignore`, `.env.example`, full git history for committed env files
- Outbound HTTP: timeouts, retries, SSRF surface
- Storage buckets and their public/private posture
- Error handling and logging patterns across all routes
- `next.config.mjs` for headers/CSP

**Not reviewed** (out of scope for this skill): dependency CVEs, performance, test
coverage, licence compliance.

## Scanners attempted

| Tool | Result |
|---|---|
| gitleaks | not installed — skipped |
| trufflehog | not installed — skipped |
| semgrep | not installed — skipped |
| npm audit | not run (dependency CVEs are out of scope) |

All findings below are from manual review.

---

## Findings

**Summary: 0 CRITICAL · 2 HIGH · 5 MEDIUM · 4 LOW · 3 INFO**

**Status, 7 August 2026: H1, H2, M1, M2, M4 and M5 are fixed** — see each finding. M3 and
the four LOW findings are open. Migrations 054, 055 and 056 must be run for the fixes to
take effect.

### HIGH

#### H1 — No rate limiting on sign-in
**File:** `src/app/api/auth/login/route.ts`

The endpoint validates the email shape and password length, then calls
`signInWithPassword` with no attempt counter, no lockout and no IP throttle. Nothing in
the repo implements rate limiting (`grep` for rate-limit helpers returns only *outbound*
API budget code).

**Why it matters:** unlimited password guesses against a known email. The app's own
error text correctly refuses to distinguish "wrong password" from "no such account", so
enumeration is closed — but credential stuffing is not.

**Mitigating:** Supabase Auth applies its own per-IP and per-email limits upstream, so
this is throttled by the provider rather than unthrottled. That is a dependency on a
default nobody here controls or monitors.

**Fix:** add a small counter keyed by IP + email — an in-memory ring is enough for a
single Railway instance, a `login_attempts` table if you want it durable — and return
429 after ~10 failures in 15 minutes. Log the lockout so it is visible in the admin log.

---

#### H2 — Member photo bucket is world-readable — **FIXED**
**Files:** `src/lib/photos.ts:32-35`, `src/app/api/cards/[id]/find-image/route.ts:141`

Card photographs are uploaded to the `card-photos` Supabase bucket and served via
`getPublicUrl()`. Anyone holding the URL can fetch the image with no session. URLs are
long and effectively unguessable, and nothing in the app enumerates them, so this is
obscurity rather than access control.

**Why it matters:** members photograph cards on desks, floors and laps. A leaked URL —
a shared screenshot, a referrer header, a browser sync — exposes an image that was
never intended to be public. The grading and bulk-scan buckets already do this properly
with signed URLs, so the pattern exists in the codebase.

**Worse than first reported.** The initial write-up said grading photos were stored
privately. They are not: `src/app/(app)/grade/page.tsx:524-527` saves the cropped front
and back of a graded card into `card-photos` as well. Those are the photographs most
likely to include a room, a hand or a desk, and they were the ones publicly readable.
The bulk-scan bucket is genuinely private; grading was never separated from card art.

**Fixed** (migration `054_private_card_photos.sql` and the code around it):

- The bucket is now `public = false`, the blanket read policy is dropped, and the
  replacement policy scopes a direct client read to the member's own folder.
- Stored URLs are unchanged and now function as identifiers rather than links — which
  keeps the dozen `includes("/card-photos/")` provenance checks in `cardWrite`,
  `cardRefresh` and `priceTrackerSync` working exactly as before.
- `GET /api/photo?u=<stored url>` is the only way in. It authenticates, authorises, and
  redirects to a link signed for one hour. The rule lives in `src/lib/photoAccess.ts`:
  your own folder is yours; a photo that became a card's picture in the shared catalogue
  is visible to any signed-in member, because that is the point of the feature; admins
  see everything for the image-review queue; everything else is 403 — which is what now
  covers another member's grading photos.
- Server-side readers sign first: `cardText.ts` before downloading a card's picture for
  transcription, and the grading export before fetching photos into its zip or emitting
  links into a CSV (seven-day expiry there, so a mislaid spreadsheet is not a permanent
  key).
- The privacy policy section that disclosed the weakness has been replaced with what is
  now true, including a note that the old text no longer applies.

---

### MEDIUM

#### M1 — Internal error messages returned to the client — **FIXED**
**Files:** 104 occurrences of `err instanceof Error ? err.message : "…"` across
`src/app/api/**/route.ts`

Caught exceptions are returned verbatim in the JSON body. Postgres errors leak column and
constraint names, Supabase errors leak table names, and upstream API errors leak URLs and
occasionally query strings.

**Why it matters:** it hands an attacker a free map of the schema. It is also how a
misconfigured upstream ends up printing a request URL — which for the paid price API
includes query parameters — into a browser.

**Fixed.** `src/lib/apiError.ts` introduces `PublicError` — an error whose message was
written for a person — and `errorJson(err, fallback)`, which shows the message only for
`PublicError` and `AuthError` and logs everything else in full on the server. The 85
canonical sites (all status 500) now call it, keeping the specific sentence each author
had already written as the fallback, which until now was the branch that almost never ran.
The eleven throws whose text is genuinely for a member — the daily download limit, "try a
different photo", "run the card catalogue import first" — became `PublicError` so they
still read as before.

The five background jobs that *record* a failure for a member to read later (scan, grade,
chat, deck build, coach) go through `safeMessage()`, on the grounds that a job row someone
opens is exactly as public as a response body.

14 sites remain and are deliberate: eight admin-only upstream probes, `find-image`'s
attempt log (admin-gated inside the route), and two server-side `console.error` calls.
Showing an admin what an upstream actually said is the purpose of those routes.

---

#### M2 — Two outbound clients have no request timeout — **FIXED**
**Files:** `src/lib/tcgdex.ts:41-49` (`get<T>`), `src/lib/clientLoop.ts`

`tcgdex.ts`'s fetch helper sets `cache: "no-store"` and no `AbortSignal`. Every other
outbound client in the repo sets one (pokemontcg 30s, price tracker 15s, card reader 15s,
image download 10s).

**Why it matters:** TCGdex is consulted during scans, set listings and card-detail views.
A hung connection there holds a Node request handler until the platform kills it. This is
the same class of fault that produced a 39.5-second single-card scan earlier this week,
which is documented in the scan timing panel.

**Fixed.** TCGdex gives up after ten seconds. `resilientFetch` now aborts an attempt at
330s — just past the 300s ceiling the longest admin routes declare, so it can only fire on
a request the server has already abandoned. Its retry loop already classified an abort as
a transport failure, so recovery needed no further change; a caller's own signal still
wins, since that usually means somebody pressed stop.

A recount while fixing this: only these two lacked a timeout. Every other outbound call in
the repo already had one — the audit's phrasing implied a wider gap than exists.

---

#### M3 — No request-size limit on image uploads
**Files:** `src/app/api/scan/route.ts`, `src/app/api/grade/route.ts`, `next.config.mjs`

Scan and grade accept base64 images in a JSON body. Neither checks the string length
before decoding and forwarding to Anthropic, and no body-size limit is configured.

**Why it matters:** an authenticated member can post an arbitrarily large payload. Best
case it is rejected downstream after the app has already buffered it in memory; worst
case several concurrent uploads exhaust the instance.

**Fix:** reject early — `if (image.length > 8_000_000) return 413` — before any decode or
model call. Both endpoints already require a session and spend credits, which limits the
blast radius to abuse by an existing member.

---

#### M4 — Export token travels in the query string — **FIXED**
**Files:** `src/app/api/export/route.ts:9`, `src/app/api/export/token/route.ts`

`GET /api/export?token=…` authenticates with a 48-hex-character token from
`api_tokens`. The route is in the middleware's public allowlist. The response includes
the member's **email address** alongside their whole collection.

**Why it matters:** URLs leak in ways headers do not — proxy logs, browser history,
referrer headers, screenshots, shell history. The token never expires (no `expires_at`
column, no `last_used_at`), so a leaked one is valid until manually rotated.

**Fixed**, with one deliberate departure from the suggested fix. `Authorization: Bearer`
is accepted and preferred, the email is gone from the payload, and the response carries
`Cache-Control: no-store` and `X-Robots-Tag: noindex`.

No `expires_at`. This link exists to be pasted into a tool that fetches a URL, and a
credential that stops working next Tuesday is one nobody trusts — the failure mode is a
member who assumes the app is broken. Migration 056 adds `last_used_at` instead: not an
expiry but a witness.

That only helps if somebody can see it, and the token had **no UI at all** — no way to
read it, no way to rotate it, despite `POST /api/export/token` having existed the whole
time. Settings → Account now shows the link, when it was last used, and a Replace button.
A date you do not recognise is the only signal a member will ever get that the link got
out.

---

#### M5 — No security headers — **FIXED**
**File:** `next.config.mjs`

No `headers()` block. The app ships without Content-Security-Policy,
`X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`,
`Referrer-Policy` or HSTS.

**Why it matters:** `Referrer-Policy` is the one with a concrete link to M4 — a
default-referrer request from a page whose URL contains a token hands that token to a
third-party host. Clickjacking is the other realistic gap, since the app has
state-changing buttons (delete account, apply deck edit).

**Fixed.** `next.config.mjs` sets `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a year of HSTS, and a
`Permissions-Policy` granting the camera to the app itself and nothing to an embedded
frame.

No CSP yet, and not by oversight: Next injects inline scripts for hydration, so a useful
policy needs per-request nonces threaded through the middleware, and one written without
them is either `unsafe-inline` (which buys nothing) or a blank page. It belongs in its own
change, with something rendering to test against.

---

### LOW

#### L1 — Timing-unsafe comparison of the bulk-scan device key
**File:** `src/app/api/bulk/photo/route.ts:44` — `job.device_key !== key`

The cron secret and the Stripe signature both use `timingSafeEqual`; this one uses `!==`.
Exploiting a string-comparison timing side channel over HTTP is close to theoretical, and
the route correctly refuses to distinguish a wrong job id from a wrong key. Worth aligning
for consistency.

**Fix:** reuse the `secretMatches` helper from `src/app/api/cron/refresh-prices/route.ts:22`.

---

#### L2 — No healthcheck endpoint
No `/health`, `/healthz` or `/api/health` route exists. Railway falls back to probing the
app root, which renders a full React page and touches the database — a heavier check than
a healthcheck should be, and one that can't distinguish "app up, database down".

**Fix:** a route returning `{ ok: true }` plus a one-row Supabase read, with a short
timeout.

---

#### L3 — Unstructured logs
Roughly 60 `console.log`/`warn`/`error` calls emit prose lines
(`price sync loop: 3 set(s) → set 90 of 217, …`). They are unusually well written and
`src/lib/logBuffer.ts` makes them readable from the admin page, but they cannot be
filtered or aggregated by field, and they carry no request or user correlation id.

**Fix:** not urgent at this size. If it ever matters, add a thin wrapper emitting JSON
with `level`, `event` and a correlation id, keeping the human sentence as `msg`.

---

#### L4 — Sign-in error passthrough
**File:** `src/app/api/auth/login/route.ts:47-50`

`Invalid login credentials` is correctly translated to a neutral message, but every other
Supabase auth error is returned verbatim. Those strings can describe provider state
("Email not confirmed", rate-limit text).

**Fix:** whitelist the messages worth showing; return a generic failure otherwise.

---

### INFO

#### I1 — Secrets hygiene is clean
`.env` variants are gitignored; `.env.example` contains placeholders only
(`eyJ...`, `sk-ant-...`); git history contains no committed env file
(`git log --all --full-history -- '*.env'` is empty apart from the example). No hardcoded
key-shaped literals in source. No secret is logged.

#### I2 — Authentication coverage is complete
All 97 routes were checked. Exactly seven lack a `requireUser`/`requireAdmin` call, and
each authenticates by another means: Stripe HMAC signature with a 300-second tolerance
and `timingSafeEqual`; `CRON_SECRET` bearer with `timingSafeEqual`; the eBay challenge
hash; the bulk feeder's per-job device key; the export token; and the two auth endpoints
themselves. The service-role client is imported by no client component, and
`SUPABASE_SERVICE_ROLE_KEY` appears in exactly one file. `requireAdmin` and
`requireModerator` are separate gates, so widening moderator access cannot grant money or
deletion rights.

#### I3 — Injection and redirect surface is small
No raw SQL anywhere — everything goes through PostgREST parameter binding. No `eval`, no
`child_process`, no dynamic `require`. The one open-redirect candidate,
`src/app/auth/callback/route.ts:41`, is explicitly defended:
`/^\/(?!\/)/.test(nextParam)` rejects absolute URLs and protocol-relative ones. The only
route accepting a URL from a client (`PATCH /api/cards/[id]/image`) is admin-only and
requires the URL to start with our own storage prefix, so there is no SSRF path from user
input. RLS is enabled on all 22 tables.

---

## Fix first

1. ~~**H2** — private bucket + signed URLs for `card-photos`.~~ **Done** — migration 054
   and `/api/photo`. See the finding for what shipped.
2. ~~**H1** — a login attempt counter.~~ **Done** — migration 055 and
   `src/lib/loginThrottle.ts`.
3. ~~**M1** — stop returning `err.message` to clients.~~ **Done** — `src/lib/apiError.ts`.
4. ~~**M2** — a timeout on the TCGdex client.~~ **Done**.
5. ~~**M4/M5 together**.~~ **Done** — migration 056, the Settings panel, and a `headers()`
   block.

**Still open: M3, and the four LOW findings.** M3 (no request-size limit on the scan and
grade uploads) is the only MEDIUM left; both endpoints require a session and spend
credits, so the exposure is abuse by an existing member rather than by a stranger.

## Requires manual verification

- Supabase Storage bucket policies were read from migrations and code. After running
  migration 054, confirm in the Supabase dashboard that `card-photos` shows as private
  and that `card-art` is still public — card art is meant to be.
- Supabase Auth's own rate limits (relevant to H1) are provider defaults — check the
  project's Auth settings for the actual thresholds.
- Railway environment variables were not readable from here; confirm no secret is set as
  `NEXT_PUBLIC_*`, which would ship it to the browser.
