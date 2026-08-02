# Roles and access

Three roles live in `profiles.role`: **member**, **moderator**, **admin**.

The dividing line is deliberate and worth stating once, because it is the
rule every future decision should be checked against:

> A moderator can change **content**. An admin can change **money, power and
> existence**.

Everything a moderator can do is reversible and about what members see.
Everything held back is either irreversible (deleting an account), spends
money (credits, AI budgets), hands out power (roles), or exposes the
business (revenue, per-member spend, billing).

---

## At a glance

| Capability | Member | Moderator | Admin |
|---|:--:|:--:|:--:|
| **Content moderation** | | | |
| Remove any trade post or reply | — | ✅ | ✅ |
| Rename someone's shared deck | — | ✅ | ✅ |
| Unshare someone's deck | — | ✅ | ✅ |
| Review the name audit (what people tried to be called) | — | ✅ | ✅ |
| Reset a member's display name | — | ✅ | ✅ |
| Block a member from sharing decks | — | ✅ | ✅ |
| Block a member from posting trades | — | ✅ | ✅ |
| Suspend / unsuspend a member | — | ✅ | ✅ |
| See the member list | — | ✅ | ✅ |
| **Money** | | | |
| See the business dashboard (MRR, margin, per-member spend) | — | — | ✅ |
| Grant credits | — | — | ✅ |
| Set a member's AI budget | — | — | ✅ |
| See per-member AI spend | — | — | ✅ |
| **Power and existence** | | | |
| Change anyone's role | — | — | ✅ |
| Delete a member | — | — | ✅ |
| Reset a member's password | — | — | ✅ |
| **Operations** | | | |
| Publish the site-wide notice banner | — | — | ✅ |
| Card catalogue import, price sync, art mirror, dedupe | — | — | ✅ |
| Card image review queue | — | — | ✅ |
| Bulk mail-in scanning jobs | — | — | ✅ |
| Load a CSV into a member's collection | — | — | ✅ |
| Grading data export | — | — | ✅ |
| Support tickets | — | — | ✅ |
| **Own account** | | | |
| Everything a normal member does | ✅ | ✅ | ✅ |
| Unmetered AI (no credit cost) | — | — | ✅ |

Two entries people expect to find on the moderator side and won't:

- **Site notice.** It is a message from the product to every member, not a
  moderation action. Admin only.
- **Support tickets.** They carry billing questions and personal detail, and
  answering them speaks for the business. Admin only. (Easy to move if you
  want moderators handling support — say so and it is a one-line change.)

---

## What each role sees

**Moderator** gets the Admin link in the nav and a page with two tabs:

- **🛡️ Content** — site notice is hidden; shared-deck rename/unshare and the
  name-check audit are there.
- **👥 Members** — the list, with only: Reset name, Block/Allow trades,
  Block/Allow sharing, Suspend/Unsuspend. No AI limit, no reset password, no
  role buttons, no Remove.

They also see **Remove (admin)** on trade posts and the ✕ on replies when
browsing the Trades board.

**Admin** sees all six tabs (Analytics, Members, Content, Catalogue, Bulk
scan, Support) and every control.

---

## How it is enforced

Three layers, and the second is the one that matters:

1. **UI** hides what the role can't use. Convenience only — never trust it.
2. **API gates.** `requireAdmin()` and `requireModerator()` in `src/lib/auth.ts`.
   These are **separate functions, not one widened function**, which is the
   whole safety property: every money or deletion route still calls
   `requireAdmin` verbatim, so a field added to a shared route later is
   admin-only by default. Being wrong in that direction is harmless.
3. **Row-level security.** `public.is_admin()` is unchanged. A second
   function `public.is_moderator()` (admin OR moderator) gates exactly two
   policies — deleting trade posts and trade comments. Widening anything
   else at the database level is a deliberate migration, never a side effect.

### Route map

| Route | Gate |
|---|---|
| `/api/admin/shared-decks` (GET, POST) | `requireModerator` |
| `/api/admin/name-audit` (GET) | `requireModerator` |
| `/api/admin/users` (GET) | `requireModerator` — **reduced payload** |
| `/api/admin/users/[id]` **PATCH** | `requireModerator`, then per-field |
| `/api/admin/users/[id]` **DELETE** | `requireAdmin` |
| `/api/admin/users/[id]/password` | `requireAdmin` |
| `/api/notice` (POST, DELETE) | `requireAdmin` |
| `/api/support` (GET) | any member — but returns **only your own** tickets unless `role === "admin"` |
| every other `/api/admin/*` | `requireAdmin` |

Two details in that table are load-bearing:

- **The member list returns less to a moderator.** AI spend, budgets, and
  last-sign-in are *absent from the response*, not merely unrendered. Hiding
  a column client-side would leave the numbers in the page source.
- **The shared PATCH checks field by field.** `role` and `aiBudgetUsd` are
  refused for a moderator inside the handler; the moderation fields pass.
  That is why a new field is safe by default — it simply won't be in the
  allowed set.

---

## Appointing and removing staff

Admin → **Members** → **Make staff** on the member's row. It asks which:

- `moderator` — content tools only
- `admin` — everything, including billing and deletion

**Remove {role} access** demotes back to member.

One guardrail, enforced server-side: **nobody can change their own role.**
An admin who demoted themselves would lock everyone out of the tools, and
there is no in-app way back.

---

## Adding a capability later

Ask the one question: *is this content, or is it money, power or existence?*

- Content → gate it with `requireModerator()`, and if RLS is involved, use
  `is_moderator()`.
- Anything else → `requireAdmin()` and `is_admin()`, and leave it there.

If a route serves both (like the member PATCH), gate it at
`requireModerator()` and check the privileged fields individually inside —
never widen the gate to reach one field.
