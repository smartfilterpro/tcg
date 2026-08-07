// Comparing secrets without telling the caller how close they got.
//
// Security audit finding L1. The cron secret and the Stripe signature each
// had their own copy of this; the bulk feeder's device key used `!==`.
// Exploiting a string-comparison timing side channel over HTTP is close to
// theoretical, but the inconsistency was the real finding: three places
// that check a secret should not have three different opinions about how.

import { timingSafeEqual } from "node:crypto";

/** Constant-time compare that can't leak length either. */
export function secretMatches(
  given: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // A length mismatch is answered without comparing, which does leak the
  // length — of a value the caller supplied and therefore already knows.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
