import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";

/** GET: my newsletter consent. POST { optIn }: change it. The column is
 *  written with the service role because profiles are otherwise read-only
 *  to their owners for good reason — this is the one field that is purely
 *  the member's own to flip. */
export async function GET() {
  try {
    const { profile } = await requireUser();
    return NextResponse.json({
      optIn: (profile as { newsletter_opt_in?: boolean } | null)?.newsletter_opt_in === true,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { optIn } = (await req.json()) as { optIn?: boolean };
    if (typeof optIn !== "boolean") {
      return NextResponse.json({ error: "optIn must be true or false" }, { status: 400 });
    }
    const admin = createAdminClient();
    const { error } = await admin
      .from("profiles")
      .update({ newsletter_opt_in: optIn })
      .eq("id", user.id);
    if (error) {
      return NextResponse.json(
        {
          error: /newsletter/.test(error.message)
            ? "Run migration 076 first — profiles has no newsletter column yet."
            : error.message,
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ optIn });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
