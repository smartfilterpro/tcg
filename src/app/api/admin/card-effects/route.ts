import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { effectBatch, effectStatus } from "@/lib/effectSweep";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

/** GET: how much of the catalogue the engine can actually play. */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await effectStatus(createAdminClient()));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't read the effect-compile status");
  }
}

/** POST { after? }: compile one batch, returning the cursor for the next.
 *  The client loops, so no single request outlives the proxy. */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as { after?: string };
    const result = await effectBatch(createAdminClient(), body.after ?? null, {
      userId: user.id,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Effect compile failed");
  }
}
