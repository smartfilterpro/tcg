// eBay Buy APIs — application-level access to public listing and sales data.
//
// Entirely optional, same stance as PokeTrace: no EBAY_CLIENT_ID /
// EBAY_CLIENT_SECRET means the feature is simply off, and nothing in the app
// notices. No eBay user ever signs in here; this is the client-credentials
// flow, which reads public marketplace data and nothing account-specific.
//
// Two APIs matter, and they are not equally available:
//
//   Browse             — ACTIVE listings. What people are ASKING. Comes with
//                        any production keyset.
//   Marketplace Insights — SOLD prices, last 90 days. What things actually go
//                        for. Restricted: eBay grants it per-application on
//                        request, and declines plenty of them.
//
// The distinction is the whole ballgame for us. Asking prices on singles run
// well above sales, so presenting a Browse median as "what your card is
// worth" would be worse than the estimates we already show. `probeAccess()`
// below exists to answer which of the two we actually have, empirically,
// rather than waiting on an email.

const HOSTS = {
  prod: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
} as const;

/** Base scope, granted to every keyset. */
export const SCOPE_BASE = "https://api.ebay.com/oauth/api_scope";
/** Sold-price data. Restricted — a keyset without it is refused the token. */
export const SCOPE_INSIGHTS = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

// Trimmed for the reason PokeTrace's key is: a newline picked up pasting into
// Railway would corrupt the Basic auth header, and the error eBay returns for
// that says nothing useful.
const clientId = (): string => (process.env.EBAY_CLIENT_ID ?? "").trim();
const clientSecret = (): string => (process.env.EBAY_CLIENT_SECRET ?? "").trim();

function host(): string {
  return (process.env.EBAY_ENV ?? "").trim().toLowerCase() === "sandbox"
    ? HOSTS.sandbox
    : HOSTS.prod;
}

/** Which eBay site prices come from. Card values differ by marketplace, so
 *  this is not cosmetic — EBAY_GB returns pounds and a different market. */
export function marketplace(): string {
  return (process.env.EBAY_MARKETPLACE ?? "EBAY_US").trim();
}

export function ebayEnabled(): boolean {
  return clientId().length > 0 && clientSecret().length > 0;
}

export class EbayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "EbayError";
  }
}

/* ----------------------------------------------------------------- tokens */

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed by the scope string: the base token and an insights token are
// different grants and cannot substitute for each other.
const tokens = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

// Refreshed early. A token that expires between the check and the call fails
// the request for no reason, and eBay's clock is not ours.
const EARLY_REFRESH_MS = 60_000;

async function requestToken(scopes: string[]): Promise<string> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(`${host()}/identity/v2/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: scopes.join(" "),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON from the token endpoint means an infrastructure error page,
    // not an API error — keep the text, it's the only diagnostic there is.
  }

  if (!res.ok) {
    // The one worth recognising: asking for a scope the keyset was never
    // granted. eBay answers invalid_scope, which is the honest answer to
    // "do we have sold-price access?" — not a fault to retry.
    const code = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    const detail =
      typeof json.error_description === "string" ? json.error_description : text.slice(0, 300);
    throw new EbayError(`${code}: ${detail}`, res.status, json);
  }

  const token = typeof json.access_token === "string" ? json.access_token : null;
  if (!token) throw new EbayError("Token response had no access_token", 502, json);

  const ttlSeconds = typeof json.expires_in === "number" ? json.expires_in : 7200;
  tokens.set(scopes.join(" "), {
    token,
    expiresAt: Date.now() + ttlSeconds * 1000 - EARLY_REFRESH_MS,
  });
  return token;
}

/** An application access token for these scopes, cached until it expires.
 *
 *  Concurrent callers share one request: a page pricing twelve cards would
 *  otherwise open twelve token requests at once, all identical, and eBay
 *  rate-limits the token endpoint separately from the APIs. */
export async function getToken(scopes: string[] = [SCOPE_BASE]): Promise<string> {
  const key = scopes.join(" ");
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = requestToken(scopes).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ calls */

export async function ebayFetch(
  path: string,
  opts: { params?: Record<string, string | number>; scopes?: string[] } = {}
): Promise<Record<string, unknown>> {
  const token = await getToken(opts.scopes ?? [SCOPE_BASE]);
  const url = new URL(`${host()}${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace(),
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* left empty; the status and raw text carry the diagnosis */
  }
  if (!res.ok) {
    const errors = json.errors as Array<{ message?: string; longMessage?: string }> | undefined;
    const first = errors?.[0];
    throw new EbayError(
      first?.longMessage ?? first?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      json
    );
  }
  return json;
}

/* ----------------------------------------------------------------- probe */

export interface EbayAccess {
  configured: boolean;
  /** Browse — active listings. Any production keyset has this. */
  browse: boolean;
  /** Marketplace Insights — sold prices. Restricted. */
  insights: boolean;
  environment: "production" | "sandbox";
  marketplace: string;
  /** Human-readable outcome per check, for the admin panel. */
  notes: string[];
}

/** What this keyset can actually do, right now.
 *
 *  Cheaper and more truthful than tracking eBay's approval emails: the token
 *  endpoint refuses a scope the application was never granted, so asking for
 *  it IS the check. */
export async function probeAccess(): Promise<EbayAccess> {
  const out: EbayAccess = {
    configured: ebayEnabled(),
    browse: false,
    insights: false,
    environment: host() === HOSTS.sandbox ? "sandbox" : "production",
    marketplace: marketplace(),
    notes: [],
  };
  if (!out.configured) {
    out.notes.push("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set.");
    return out;
  }

  try {
    await getToken([SCOPE_BASE]);
    out.browse = true;
    out.notes.push("Base scope granted — active listings (asking prices) are available.");
  } catch (err) {
    out.notes.push(
      `Base token failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Usually a wrong or sandbox-vs-production key pair.`
    );
    return out;
  }

  try {
    await getToken([SCOPE_BASE, SCOPE_INSIGHTS]);
    out.insights = true;
    out.notes.push("Marketplace Insights granted — real sold prices are available.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.notes.push(
      /invalid_scope|insufficient/i.test(msg)
        ? "Marketplace Insights NOT granted — sold-price data needs eBay's restricted-access approval."
        : `Insights check failed for another reason: ${msg}`
    );
  }
  return out;
}
