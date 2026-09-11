import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BULK_BUCKET } from "@/lib/bulkScan";
import { errorJson } from "@/lib/apiError";

// The scan report a customer opens from a link — no account, no login,
// just the token minted on their job. Every card that was uploaded, with
// the scan photo beside the catalogue card it was filed as, so the person
// whose collection this became can check the work card by card.
//
// Public by design (and listed in the middleware's public paths): the
// token is the credential. It reads one finished job and can write
// nothing.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const jobId = url.searchParams.get("job") ?? "";
    const token = url.searchParams.get("t") ?? "";
    if (!jobId || !token) {
      return NextResponse.json({ error: "This report link is incomplete." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: job } = await admin
      .from("bulk_jobs")
      .select("id, label, status, uploaded_at, report_token")
      .eq("id", jobId)
      .maybeSingle();
    if (!job || !job.report_token || job.report_token !== token) {
      return NextResponse.json(
        { error: "This report link isn't valid — ask for a fresh one." },
        { status: 404 }
      );
    }

    const { data: rows } = await admin
      .from("bulk_cards")
      .select("seq, pass1_path, pass1_read, card_id, variant, confidence, reviewed")
      .eq("job_id", jobId)
      .not("card_id", "is", null)
      .order("seq")
      .limit(1000);

    const cardIds = [...new Set((rows ?? []).map((r) => r.card_id as string))];
    const cardById = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < cardIds.length; i += 100) {
      const { data: cards } = await admin
        .from("cards")
        .select("id, name, number, set_name, image_small")
        .in("id", cardIds.slice(i, i + 100));
      for (const c of cards ?? []) cardById.set(c.id as string, c);
    }

    const out = await Promise.all(
      (rows ?? []).map(async (r) => {
        const card = cardById.get(r.card_id as string);
        const scan =
          typeof r.pass1_path === "string" && r.pass1_path
            ? (await admin.storage.from(BULK_BUCKET).createSignedUrl(r.pass1_path, 3600)).data
                ?.signedUrl ?? null
            : null;
        const read = r.pass1_read as { orientation?: string } | null;
        return {
          seq: r.seq,
          scan,
          flipped: read?.orientation === "upside_down",
          name: (card?.name as string) ?? "?",
          number: (card?.number as string) ?? "?",
          set: (card?.set_name as string) ?? null,
          image: (card?.image_small as string) ?? null,
          finish: r.variant,
          humanChecked: r.reviewed === true,
        };
      })
    );

    return NextResponse.json({
      label: job.label,
      uploadedAt: job.uploaded_at,
      count: out.length,
      cards: out,
    });
  } catch (err) {
    return errorJson(err, "Couldn't load the report");
  }
}
