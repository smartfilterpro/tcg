import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/requestOrigin";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EmailOtpType } from "@supabase/supabase-js";

/** Signup stores the Terms acceptance in user metadata (the profile row
 *  doesn't exist to write to until the trigger fires). Copy it over on the
 *  first verified visit, so the box ticked at signup isn't asked again by
 *  the accept-terms gate. */
async function stampTosFromMetadata(supabase: Awaited<ReturnType<typeof createClient>>) {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const stamped = user?.user_metadata?.tos_accepted_at as string | undefined;
    if (!user || !stamped) return;
    const admin = createAdminClient();
    const { data: prof } = await admin
      .from("profiles")
      .select("tos_accepted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (prof && prof.tos_accepted_at == null) {
      await admin.from("profiles").update({ tos_accepted_at: stamped }).eq("id", user.id);
    }
  } catch {
    // Worst case the accept-terms page asks once more.
  }
}

/** Handles both PKCE (?code=) and magic-link (?token_hash=&type=) callbacks. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const nextParam = url.searchParams.get("next") ?? "/";
  // Only internal destinations — an absolute URL here would make the
  // verification email an open redirect.
  const next = /^\/(?!\/)/.test(nextParam) ? nextParam : "/";

  const origin = requestOrigin(request);
  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await stampTosFromMetadata(supabase);
      return NextResponse.redirect(new URL(next, origin));
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      await stampTosFromMetadata(supabase);
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=link", origin));
}
