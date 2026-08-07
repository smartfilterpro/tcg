// Throttling sign-in attempts.
//
// Two keys per attempt, because they stop different attacks. The email key
// stops a run against one account. The IP key stops one machine working
// through a list of accounts, where no single email ever reaches its own
// limit.
//
// The tradeoff, stated plainly: a hard lock on the email key means somebody
// who knows a member's address can lock them out for a quarter of an hour
// by guessing badly ten times. That is the cost of the control, and the
// alternative — never locking the email — leaves a distributed attempt
// against one account unthrottled by anything of ours. Fifteen minutes is
// chosen as the ceiling on both harms rather than the floor on either.
//
// Everything here is best-effort. A database that will not answer must not
// be the reason nobody can sign in, so a failed check lets the attempt
// through; the throttle is a control on top of authentication, never a
// replacement for it.

import type { SupabaseClient } from "@supabase/supabase-js";

/** How far back a run of failures counts. */
const WINDOW = "15 minutes";
/** How long a locked key stays locked. */
const LOCK = "15 minutes";

/** Failures within the window before the key locks. The IP allowance is
 *  higher because a household, a school and an office each share one. */
const MAX_PER_EMAIL = 10;
const MAX_PER_IP = 30;

export interface LoginKeys {
  email: string;
  ip: string | null;
}

function keysFor({ email, ip }: LoginKeys): Array<{ key: string; max: number }> {
  const keys = [{ key: `email:${email}`, max: MAX_PER_EMAIL }];
  if (ip) keys.push({ key: `ip:${ip}`, max: MAX_PER_IP });
  return keys;
}

/** The client's address, as far as we can tell.
 *
 *  The leftmost entry of X-Forwarded-For is the one the client can write
 *  itself, so this is spoofable and an attacker can shed their IP key at
 *  will. It is kept anyway: it costs nothing, it stops the unsophisticated
 *  case, and the email key — which cannot be spoofed, because guessing a
 *  different email is not an attempt against this account — is the one
 *  carrying the weight. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  return req.headers.get("x-real-ip")?.trim().slice(0, 64) ?? null;
}

/** Seconds until this person may try again, or 0 if they may try now. */
export async function loginRetryAfter(admin: SupabaseClient, keys: LoginKeys): Promise<number> {
  try {
    const { data } = await admin
      .from("login_attempts")
      .select("locked_until")
      .in("key", keysFor(keys).map((k) => k.key));
    const now = Date.now();
    let until = 0;
    for (const row of data ?? []) {
      const at = row.locked_until ? Date.parse(row.locked_until as string) : 0;
      if (Number.isFinite(at) && at > until) until = at;
    }
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  } catch {
    return 0;
  }
}

/** Count a failed attempt against both keys. Returns true if that failure
 *  is the one that locked something, which is the interesting moment to
 *  log — a lockout is either an attack or a member who needs the reset
 *  link, and both are worth being able to see afterwards. */
export async function noteLoginFailure(
  admin: SupabaseClient,
  keys: LoginKeys
): Promise<boolean> {
  let locked = false;
  for (const { key, max } of keysFor(keys)) {
    try {
      const { data } = await admin.rpc("note_login_failure", {
        p_key: key,
        p_window: WINDOW,
        p_max: max,
        p_lock: LOCK,
      });
      if (data) locked = true;
    } catch {
      // Deliberately silent, and deliberately not fatal: see the note at
      // the top. A throttle that can refuse a sign-in when its own table
      // is unreachable is worse than no throttle.
    }
  }
  return locked;
}

/** A successful sign-in clears the slate — for the email, and for the
 *  address it came from. Somebody who mistyped their password nine times
 *  and then got it right is not one mistake away from a lockout. */
export async function clearLoginFailures(
  admin: SupabaseClient,
  keys: LoginKeys
): Promise<void> {
  try {
    await admin
      .from("login_attempts")
      .delete()
      .in("key", keysFor(keys).map((k) => k.key));
  } catch {
    // Best-effort; the row expires on its own within the window.
  }
}
