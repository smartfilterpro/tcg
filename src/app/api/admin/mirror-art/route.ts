import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { mirrorBatch, mirrorStatus } from "@/lib/artMirror";

export const maxDuration = 300;

/** GET: how much of the catalogue's art is ours vs hotlinked. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    return NextResponse.json(await mirrorStatus(admin));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { after? }: mirror one batch, returning the cursor for the next.
 *  The client loops; each request stays small enough that the proxy never
 *  cuts it off mid-answer the way the first price-sync runs were. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { after?: string };
    const admin = createAdminClient();
    const result = await mirrorBatch(admin, typeof body.after === "string" ? body.after : null);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const msg = err instanceof Error ? err.message : "Mirror failed";
  return NextResponse.json(
    {
      error: /card-art|bucket/i.test(msg)
        ? `${msg} — has supabase/migrations/037_card_art.sql been run?`
        : msg,
    },
    { status: 500 }
  );
}
