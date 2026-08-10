import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { textBatch, textStatus } from "@/lib/cardTextSweep";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

/** GET: how much of the catalogue can say what it does. */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await textStatus(createAdminClient()));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't read the card-text status");
  }
}

/** POST { after?, ownedOnly? }: read one batch, returning the cursor for
 *  the next. The client loops — each request stays small enough that the
 *  proxy never cuts it off mid-read. */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      after?: string;
      ownedOnly?: boolean;
    };
    const result = await textBatch(createAdminClient(), body.after ?? null, {
      ownedOnly: body.ownedOnly === true,
      userId: user.id,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Card-text sweep failed");
  }
}
