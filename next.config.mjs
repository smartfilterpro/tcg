/** Response headers every page and route gets.
 *
 *  Security audit finding M5: there were none.
 *
 *  Referrer-Policy is the one that mattered. The collection export used to
 *  carry its token in the query string, so any outbound link from a page
 *  bearing that URL leaked the token in the Referer header — and card
 *  pictures are loaded from other people's servers on nearly every screen.
 *  The token has since moved to a header (M4), but same-origin is the right
 *  default regardless: no third party needs to know which card a member was
 *  looking at when their image was fetched.
 *
 *  No Content-Security-Policy here yet, deliberately. Next injects inline
 *  scripts for hydration, so a useful CSP needs per-request nonces threaded
 *  through the middleware, and a CSP written without that is either
 *  unsafe-inline (which buys nothing) or a blank page. It belongs in its own
 *  change, with something rendering to test against.
 */
const securityHeaders = [
  // Don't tell other people's servers which page the request came from.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No MIME sniffing: an uploaded file that claims to be a JPEG is treated
  // as one and never as a script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing here is meant to be framed, and a collection inside somebody
  // else's page is a clickjacking target.
  { key: "X-Frame-Options", value: "DENY" },
  // A year of HTTPS-only. Railway terminates TLS and there is no plain-HTTP
  // path into the app, so this costs nothing and closes the first-request
  // downgrade.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // The app asks for the camera itself (scanning) and nothing else; an
  // embedded frame gets none of it.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.pokemontcg.io" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
