import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { recordFinishFeedback, type FinishFeedbackEntry } from "@/lib/finishFeedback";

/** POST: best-effort finish-feedback from the scan review screen — what the
 *  scanner guessed vs. what the member actually saved, per card. Feeds the
 *  scanner's memory so repeat mistakes stop repeating.
 *  Body: { entries: [{ cardId, predicted, corrected }] } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { entries } = (await req.json()) as { entries?: FinishFeedbackEntry[] };
    if (!Array.isArray(entries)) {
      return NextResponse.json({ error: "Missing entries" }, { status: 400 });
    }
    const supabase = await createClient();
    await recordFinishFeedback(supabase, user.id, entries);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Learning is best-effort — never surface an error to the scan screen.
    console.error("finish-feedback error", err);
    return NextResponse.json({ ok: true });
  }
}
