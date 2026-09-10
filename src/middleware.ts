import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/pricing",
  "/auth",
  "/api/auth",
  "/api/export",
  // Self-authenticated endpoints: the Stripe webhook proves itself with an
  // HMAC signature and the cron route with a bearer secret. Neither carries
  // session cookies, so the blanket 401 here was rejecting them before
  // their own (stricter) checks could run.
  "/api/billing/webhook",
  "/api/cron",
  // eBay's account-deletion endpoint. eBay calls it with no cookies and will
  // mark the endpoint down if it 401s, which costs the production keyset. It
  // holds no data and answers a hash challenge, so it is safe to expose.
  "/api/ebay/account-deletion",
  // The bulk-scan feeder rig posts photos with a per-job device key, no
  // session — the route itself refuses anything without a matching key.
  "/api/bulk/photo",
  // The rig's job endpoint is self-authenticated the same way (x-rig-key
  // to mint a job, x-bulk-key to read one). Without this entry the Pi
  // bridge's "Create job & start" died here with a generic 401 before
  // the route's own key check ever saw the request.
  "/api/bulk/job",
  // The bridge script itself, served to the Pi's "check for update" —
  // no secrets in it, and the Pi fetches it before holding any session.
  "/api/bulk/bridge",
  // Phone-camera client for the same bulk-scan contract — same auth model
  // as the rig (device key only, checked by /api/bulk/photo itself), so it
  // stays out of the session-gated app surface for the same reason.
  "/bulk/capture",
  // Family invitations are answered by people who may not have an account
  // yet — that is the entire point of the change. The page itself resolves
  // the token through a security-definer function and shows nothing for a
  // dead one; accepting still requires signing in.
  "/family/join",
  // What things cost is a question people ask before signing up, so the
  // reference page answers it without an account.
  "/credits",
  "/terms",
  // The privacy policy, for the same reason as the terms — and because an
  // app store reviewer follows the URL without an account, finds a login
  // wall, and rejects the submission.
  "/privacy",
  // The platform's healthcheck, which cannot sign in and would otherwise be
  // probing the landing page — a full React render plus a database read,
  // every thirty seconds, that still could not tell an app fault from a
  // database one.
  "/api/health",
];

/** startsWith("/") matches everything, so the landing page is handled as an
 *  exact match instead of living in the list. */
function isPublicPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

// Reachable while signed in but before accepting the Terms
const TOS_EXEMPT_PATHS = [...PUBLIC_PATHS, "/accept-terms"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the session (required for SSR auth) and gate private routes.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = isPublicPath(pathname);

  if (!user && !isPublic) {
    // A JSON 401 is right for fetch(), and wrong for a person. Some API
    // routes are legitimate navigation targets — GET /api/billing/checkout
    // is what signup redirects into, and an expired session there would
    // otherwise render `{"error":"Not authenticated"}` in the address bar.
    // Sec-Fetch-Mode tells the two apart; without it, assume fetch().
    const navigating = request.headers.get("sec-fetch-mode") === "navigate";
    if (pathname.startsWith("/api/") && !navigating) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Remember where they were headed (e.g. a battle invite link) so login
    // can send them back instead of dumping everyone at the collection.
    const dest = pathname + request.nextUrl.search;
    url.search = dest !== "/" ? `?next=${encodeURIComponent(dest)}` : "";
    return NextResponse.redirect(url);
  }

  // Signed in but hasn't accepted the Terms: everything funnels to the
  // accept page (server-side — the login-screen gate alone was bypassable
  // by simply navigating away). Pre-migration-016 profiles (no column, or
  // query error) skip the gate gracefully.
  // "/" is public for strangers but NOT TOS-exempt: for a signed-in account
  // it renders the collection, which the terms gate must still cover.
  //
  // Two performance carve-outs, neither weakening the gate:
  //  - /api/* skips this entirely: requireUser inside every route enforces
  //    the same 403 itself (its comment has said so all along), so this
  //    query was pure duplication on the app's hottest path — every fetch
  //    a page makes was paying an extra database round trip here.
  //  - Pages memo the answer in a cookie keyed to the USER ID, so the
  //    query runs about once per sign-in rather than once per navigation.
  //    Keyed to the id because a shared browser can hold a different next
  //    account; acceptance is never revoked in-app, so a memo can't go
  //    stale in the direction that matters.
  const TOS_COOKIE = "td_tos_ok";
  if (
    user &&
    !pathname.startsWith("/api/") &&
    !TOS_EXEMPT_PATHS.some((p) => pathname.startsWith(p)) &&
    request.cookies.get(TOS_COOKIE)?.value !== user.id
  ) {
    const { data: prof, error } = await supabase
      .from("profiles")
      .select("tos_accepted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (!error && prof && prof.tos_accepted_at == null) {
      const url = request.nextUrl.clone();
      url.pathname = "/accept-terms";
      return NextResponse.redirect(url);
    }
    response.cookies.set(TOS_COOKIE, user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return response;
}

export const config = {
  // manifest.webmanifest is excluded because browsers fetch a manifest
  // WITHOUT cookies: the auth gate saw a stranger, answered with the login
  // page, and Chrome logged a manifest syntax error on every page for every
  // visitor — signed in or not. robots.txt is excluded because crawlers
  // don't sign in either, and a robots file behind a login redirect means
  // the index/noindex switch was never actually being read. sw.js for the
  // same class of reason: a service worker must be fetchable to register.
  // All three serve public data by construction.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
