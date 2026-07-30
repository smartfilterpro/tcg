// Stripe over plain fetch — deliberately no SDK. The repo's rule is no new
// dependencies without asking, and the slice of Stripe this app needs
// (checkout sessions, the portal, price lookup, webhook verification) is a
// form-encoded REST API plus one HMAC. Everything here is testable locally;
// nothing depends on package versions.

import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";

function secretKey(): string {
  return (process.env.STRIPE_SECRET_KEY ?? "").trim();
}

export function stripeEnabled(): boolean {
  return secretKey().length > 0;
}

/** The two products the owner created in Stripe, resolved by exact name.
 *  STRIPE_PRICE_PRO / STRIPE_PRICE_FAMILY env vars short-circuit the lookup
 *  if set. */
export const PLAN_PRODUCTS: Record<"pro" | "family", { productName: string; cents: number }> = {
  pro: { productName: "TrainerDeck Pro Tier", cents: 900 },
  family: { productName: "TrainerDeck Family Tier", cents: 1900 },
};

/** One-off boost packs. Sold with ad-hoc price_data, so no Stripe product
 *  needs to exist for them. */
export { BOOST_PACKS } from "@/lib/boosts";

/** Flatten nested params into Stripe's bracket form encoding:
 *  { line_items: [{ price: "x", quantity: 1 }] }
 *  → line_items[0][price]=x & line_items[0][quantity]=1 */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (key: string, value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${key}[${k}]`, v);
      }
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join("&");
}

export class StripeError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function stripeFetch(
  path: string,
  opts?: { method?: "GET" | "POST"; params?: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const method = opts?.method ?? "POST";
  const body = opts?.params ? encodeForm(opts.params) : undefined;
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string } | undefined)?.message ?? `Stripe ${res.status}`;
    throw new StripeError(err, res.status);
  }
  return json;
}

/** Webhook signature check, per Stripe's scheme: the Stripe-Signature header
 *  carries `t=<unix>,v1=<hmac>`, and the HMAC-SHA256 is over `${t}.${body}`
 *  with the endpoint secret. Constant-time compare; stale timestamps are
 *  rejected so a captured request can't be replayed later. */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = new Map<string, string[]>();
  for (const piece of signatureHeader.split(",")) {
    const [k, v] = piece.split("=", 2).map((s) => s?.trim());
    if (!k || !v) continue;
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = Number(parts.get("t")?.[0]);
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected);
  // Stripe may send several v1 signatures during secret rotation — any match
  // passes.
  for (const candidate of parts.get("v1") ?? []) {
    const buf = Buffer.from(candidate);
    if (buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf)) return true;
  }
  return false;
}

// Price ids barely ever change; cache per process.
const priceCache = new Map<string, string>();

/** The recurring monthly price id for a plan.
 *
 *  Resolution order: env override → an existing monthly price on the
 *  named product → create one on that product. Creating is what "define
 *  them in code on first run" means: the owner made the two products, and
 *  the price is added to THEIR product, visibly, not to some shadow copy. */
export async function planPriceId(plan: "pro" | "family"): Promise<string> {
  const envOverride = (
    plan === "pro" ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_FAMILY
  )?.trim();
  if (envOverride) return envOverride;
  const cached = priceCache.get(plan);
  if (cached) return cached;

  const spec = PLAN_PRODUCTS[plan];
  const products = await stripeFetch("/products", {
    method: "GET",
    params: { active: true, limit: 100 },
  });
  const product = ((products.data as Array<Record<string, unknown>>) ?? []).find(
    (p) => p.name === spec.productName
  );
  if (!product) {
    throw new StripeError(
      `Product "${spec.productName}" not found in Stripe — create it (or set ` +
        `STRIPE_PRICE_${plan.toUpperCase()}).`,
      500
    );
  }

  const prices = await stripeFetch("/prices", {
    method: "GET",
    params: { product: product.id, active: true, limit: 100 },
  });
  const match = ((prices.data as Array<Record<string, unknown>>) ?? []).find((p) => {
    const rec = p.recurring as { interval?: string } | null;
    return rec?.interval === "month" && p.unit_amount === spec.cents && p.currency === "usd";
  });
  if (match) {
    priceCache.set(plan, match.id as string);
    return match.id as string;
  }

  const created = await stripeFetch("/prices", {
    params: {
      product: product.id,
      unit_amount: spec.cents,
      currency: "usd",
      recurring: { interval: "month" },
    },
  });
  priceCache.set(plan, created.id as string);
  return created.id as string;
}

/** Find or create the Stripe customer for a user, storing the id back on the
 *  profile so it's one lookup forever after. */
export async function ensureCustomer(
  admin: {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => PromiseLike<unknown> };
    };
  },
  userId: string,
  email: string | null,
  existing: string | null
): Promise<string> {
  if (existing) return existing;
  const customer = await stripeFetch("/customers", {
    params: { email: email ?? undefined, metadata: { user_id: userId } },
  });
  const id = customer.id as string;
  await admin.from("profiles").update({ stripe_customer: id }).eq("id", userId);
  return id;
}
