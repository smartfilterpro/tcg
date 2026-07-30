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
  // v1. The OAuth endpoint is versioned separately from the Buy APIs it
  // issues tokens for, and a wrong version here answers 404 with an empty
  // body — which reads exactly like bad credentials and is not.
  const res = await fetch(`${host()}/identity/v1/oauth2/token`, {
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

/** What a configured credential looks like, without printing it.
 *
 *  "invalid_client" tells you the pair was rejected and nothing about why,
 *  and the three ways to get here are indistinguishable from the outside:
 *  a sandbox keyset in the production slot, the two values swapped, or an
 *  OAuth *access token* pasted where a keyset credential belongs. Each has
 *  a visible signature that doesn't require revealing the value. */
export interface CredentialShape {
  set: boolean;
  length: number;
  /** eBay stamps PRD or SBX into both halves of a keyset. */
  looksLike: "production" | "sandbox" | "access-token" | "unknown";
  /** Enough to recognise, not enough to use. */
  hint: string;
  /** True if the stored value had leading/trailing whitespace. We trim it,
   *  but a value that needed trimming was probably pasted carelessly. */
  hadWhitespace: boolean;
  /** The Cert ID starts with PRD-/SBX-; the App ID carries it mid-string. */
  startsWithMarker: boolean;
}

function shapeOf(raw: string): CredentialShape {
  const value = raw.trim();
  // The API Explorer's generated token. Long, and starts with this marker.
  const isAccessToken = value.startsWith("v^") || value.length > 200;
  const looksLike = isAccessToken
    ? "access-token"
    : /PRD-/i.test(value)
      ? "production"
      : /SBX-/i.test(value)
        ? "sandbox"
        : "unknown";
  return {
    set: value.length > 0,
    length: value.length,
    looksLike,
    hint: value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "(too short to show)",
    hadWhitespace: raw !== value,
    startsWithMarker: /^(PRD|SBX)-/i.test(value),
  };
}

export interface EbayAccess {
  configured: boolean;
  /** Browse — active listings. Any production keyset has this. */
  browse: boolean;
  /** Marketplace Insights — sold prices. Restricted. */
  insights: boolean;
  environment: "production" | "sandbox";
  marketplace: string;
  credentials: { clientId: CredentialShape; clientSecret: CredentialShape };
  /** Human-readable outcome per check, for the admin panel. */
  notes: string[];
}

/** Faults visible without calling eBay at all. */
function credentialComplaints(
  id: CredentialShape,
  secret: CredentialShape,
  env: "production" | "sandbox"
): string[] {
  const out: string[] = [];
  for (const [name, s] of [
    ["EBAY_CLIENT_ID", id],
    ["EBAY_CLIENT_SECRET", secret],
  ] as const) {
    if (s.looksLike === "access-token") {
      out.push(
        `${name} looks like a generated OAuth application token, not a keyset ` +
          `credential. Those expire in hours and are for eBay's API Explorer — ` +
          `this needs the App ID / Cert ID from Application Keys.`
      );
    } else if (s.looksLike === "sandbox" && env === "production") {
      out.push(`${name} is a SANDBOX credential but EBAY_ENV is production.`);
    } else if (s.looksLike === "production" && env === "sandbox") {
      out.push(`${name} is a PRODUCTION credential but EBAY_ENV is sandbox.`);
    }
    if (s.hadWhitespace) out.push(`${name} had surrounding whitespace (trimmed, but check it).`);
  }
  // Shape, not length: the Cert ID *begins* PRD-/SBX-, while the App ID
  // carries the same marker in the middle of a dash-separated name. A value
  // starting with the marker in the client-id slot means they were swapped.
  if (id.set && secret.set && id.startsWithMarker && !secret.startsWithMarker) {
    out.push("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET look swapped — the Cert ID goes in SECRET.");
  }
  return out;
}

/** What this keyset can actually do, right now.
 *
 *  Cheaper and more truthful than tracking eBay's approval emails: the token
 *  endpoint refuses a scope the application was never granted, so asking for
 *  it IS the check. */
export async function probeAccess(): Promise<EbayAccess> {
  const environment = host() === HOSTS.sandbox ? "sandbox" : "production";
  const credentials = {
    clientId: shapeOf(process.env.EBAY_CLIENT_ID ?? ""),
    clientSecret: shapeOf(process.env.EBAY_CLIENT_SECRET ?? ""),
  };
  const out: EbayAccess = {
    configured: ebayEnabled(),
    browse: false,
    insights: false,
    environment,
    marketplace: marketplace(),
    credentials,
    notes: credentialComplaints(credentials.clientId, credentials.clientSecret, environment),
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
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 here is never the credentials — eBay would have to reach the
    // endpoint to reject them. It means the token URL itself is wrong.
    // If something specific was already spotted in the credentials, don't
    // follow it with generic advice that sends the reader somewhere else.
    const hint = out.notes.length
      ? "See the credential problems above."
      : err instanceof EbayError && err.status === 404
        ? "A 404 means the token URL is wrong, not the keys."
        : err instanceof EbayError && err.status === 401
          ? "Check the key pair, and that a sandbox keyset didn't land in the production slot."
          : "Check the keys and that Railway redeployed after they were set.";
    out.notes.push(`Base token failed: ${msg}. ${hint}`);
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
