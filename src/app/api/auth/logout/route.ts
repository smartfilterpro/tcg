import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // Behind Railway's proxy, request.url is the INTERNAL origin (localhost) —
  // redirect to the public app URL instead, falling back to the forwarded
  // headers the proxy sets.
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (forwardedHost ? `${forwardedProto}://${forwardedHost}` : request.url);

  return NextResponse.redirect(new URL("/login", base), { status: 302 });
}
