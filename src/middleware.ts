import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

const PUBLIC_PATHS = ["/login", "/auth", "/api/auth", "/api/export", "/terms"];

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
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Signed in but hasn't accepted the Terms: everything funnels to the
  // accept page (server-side — the login-screen gate alone was bypassable
  // by simply navigating away). Pre-migration-016 profiles (no column, or
  // query error) skip the gate gracefully.
  if (user && !TOS_EXEMPT_PATHS.some((p) => pathname.startsWith(p))) {
    const { data: prof, error } = await supabase
      .from("profiles")
      .select("tos_accepted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (!error && prof && prof.tos_accepted_at == null) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Please accept the Terms of Service to continue." },
          { status: 403 }
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/accept-terms";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
