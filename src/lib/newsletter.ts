// Newsletter consent plumbing shared by the settings toggle, the sends,
// and the one-click unsubscribe.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The site's own address, for links inside email. */
export function siteBase(): string {
  return (process.env.APP_BASE_URL ?? "https://tcgdeck.io").replace(/\/$/, "");
}

/** The unsubscribe token: HMAC of the user id. Lets the link in an email
 *  flip consent off WITHOUT a login — the whole point of one-click
 *  unsubscribe — while forging one for someone else requires the server
 *  secret. The service key doubles as that secret; NEWSLETTER_SECRET can
 *  override it so rotating one doesn't invalidate the other. */
function secret(): string {
  return process.env.NEWSLETTER_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dev";
}

export function unsubToken(userId: string): string {
  return createHmac("sha256", secret()).update(userId).digest("hex").slice(0, 32);
}

export function unsubTokenValid(userId: string, token: string): boolean {
  const want = Buffer.from(unsubToken(userId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function unsubUrl(userId: string): string {
  return `${siteBase()}/api/newsletter/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}

/** The footer every newsletter carries — who it's from and the way out. */
export function newsletterFooter(userId: string): string {
  return (
    `\n\n—\nYou're getting this because you opted in from your TCGdeck account settings.\n` +
    `Unsubscribe with one click: ${unsubUrl(userId)}`
  );
}
