/** The request's PUBLIC origin, proxy-aware.
 *
 *  `new URL(req.url).origin` is a trap on Railway (and most PaaS): the app
 *  runs behind a proxy on an internal port, so the server sees itself as
 *  localhost:8080 — and a redirect built from that sent verified users to
 *  https://localhost:8080/onboarding. The proxy passes the truth in
 *  x-forwarded-host / x-forwarded-proto; the Origin header (present on
 *  fetch/XHR but not top-level navigations) is preferred when it exists. */
export function requestOrigin(req: Request): string {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host && !/^localhost[:\d]*$|^127\./.test(host)) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  // Local dev genuinely is localhost; anything else falls back to the
  // request URL as a last resort.
  return host ? `http://${host}` : new URL(req.url).origin;
}
