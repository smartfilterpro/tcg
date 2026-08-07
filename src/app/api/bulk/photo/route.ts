import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BULK_BUCKET, MAX_JOB_CARDS, identifyPhoto } from "@/lib/bulkScan";
import { errorJson } from "@/lib/apiError";
import { secretMatches } from "@/lib/secretCompare";

export const maxDuration = 120;

// The feeder rig's door. No browser session — a pi taped to a card feeder
// authenticates with the job's device key and posts one photo per card:
//
//   curl -X POST https://…/api/bulk/photo \
//     -H "x-bulk-key: <device_key>" \
//     -F job=<job_id> -F pass=1 -F seq=17 -F photo=@card.jpg
//
// seq is optional (defaults to next); pass 2 arrives in REVERSE feed order
// and is attached to the matching pass-1 row: pass-2 card s pairs with
// pass-1 card (N+1−s). Identification starts immediately, detached, so by
// the time the stack finishes most reads are already done.

export async function POST(req: Request) {
  try {
    const key = req.headers.get("x-bulk-key") ?? "";
    if (!key) return NextResponse.json({ error: "Missing x-bulk-key header." }, { status: 401 });

    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "Send multipart/form-data." }, { status: 400 });
    const jobId = String(form.get("job") ?? "");
    const pass = String(form.get("pass") ?? "1") === "2" ? 2 : 1;
    const seqRaw = form.get("seq");
    const photo = form.get("photo");
    if (!jobId) return NextResponse.json({ error: "Missing job field." }, { status: 400 });
    if (!(photo instanceof File)) {
      return NextResponse.json({ error: "Missing photo file field." }, { status: 400 });
    }
    if (photo.size > 8_000_000) {
      return NextResponse.json({ error: "Photo over 8MB — send smaller frames." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: job } = await admin
      .from("bulk_jobs")
      .select("id, status, device_key, created_by")
      .eq("id", jobId)
      .maybeSingle();
    if (!job || !secretMatches(key, job.device_key as string | null)) {
      // One answer for wrong job and wrong key: no probing which is which.
      return NextResponse.json({ error: "Unknown job or wrong device key." }, { status: 403 });
    }
    if (job.status !== "open") {
      return NextResponse.json({ error: `This job is ${job.status} — not accepting photos.` }, { status: 409 });
    }

    // Where does this photo belong?
    const { count: pass1Count } = await admin
      .from("bulk_cards")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .not("pass1_path", "is", null)
      .lt("seq", 10000);
    const { count: pass2Count } = await admin
      .from("bulk_cards")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .not("pass2_path", "is", null);
    if ((pass1Count ?? 0) >= MAX_JOB_CARDS) {
      return NextResponse.json({ error: `Job is at the ${MAX_JOB_CARDS}-card cap.` }, { status: 400 });
    }

    const given = seqRaw != null ? parseInt(String(seqRaw), 10) : NaN;
    const ordinal = Number.isFinite(given) && given > 0 ? given : (pass === 1 ? (pass1Count ?? 0) : (pass2Count ?? 0)) + 1;
    // Pass 2 runs the stack in reverse: its s-th card is pass 1's (N+1−s)-th.
    const targetSeq = pass === 1 ? ordinal : (pass1Count ?? 0) + 1 - ordinal;

    const buffer = Buffer.from(await photo.arrayBuffer());
    const contentType = photo.type || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const path = `${jobId}/pass${pass}/${String(ordinal).padStart(5, "0")}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(BULK_BUCKET)
      .upload(path, buffer, { contentType, upsert: true });
    if (upErr) {
      return NextResponse.json(
        { error: /bucket/i.test(upErr.message) ? "Storage not ready — run migration 039." : upErr.message },
        { status: 500 }
      );
    }

    let rowId: string;
    if (pass === 1) {
      const { data: row, error } = await admin
        .from("bulk_cards")
        .upsert(
          { job_id: jobId, seq: targetSeq, pass1_path: path, updated_at: new Date().toISOString() },
          { onConflict: "job_id,seq" }
        )
        .select("id")
        .single();
      if (error || !row) throw new Error(error?.message ?? "row write failed");
      rowId = row.id as string;
    } else {
      // Attach to the paired pass-1 row; a misfeed that broke the count
      // lands on an offset seq and finalize routes the whole mess to review.
      const { data: existing } = await admin
        .from("bulk_cards")
        .select("id")
        .eq("job_id", jobId)
        .eq("seq", targetSeq)
        .maybeSingle();
      if (existing && targetSeq >= 1) {
        await admin
          .from("bulk_cards")
          .update({ pass2_path: path, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
        rowId = existing.id as string;
      } else {
        const { data: row, error } = await admin
          .from("bulk_cards")
          .upsert(
            { job_id: jobId, seq: 10000 + ordinal, pass2_path: path, updated_at: new Date().toISOString() },
            { onConflict: "job_id,seq" }
          )
          .select("id")
          .single();
        if (error || !row) throw new Error(error?.message ?? "row write failed");
        rowId = row.id as string;
      }
    }

    // Identify in the background; the rig gets its 200 and keeps feeding.
    const adminUserId = (job.created_by as string | null) ?? "";
    void identifyPhoto(admin, jobId, adminUserId, {
      data: buffer.toString("base64"),
      mediaType: contentType,
    }).then(async (read) => {
      await admin
        .from("bulk_cards")
        .update(
          pass === 1
            ? { pass1_read: read, updated_at: new Date().toISOString() }
            : { pass2_read: read, updated_at: new Date().toISOString() }
        )
        .eq("id", rowId);
    });

    return NextResponse.json({ ok: true, pass, seq: targetSeq, ordinal });
  } catch (err) {
    return errorJson(err, "Photo intake failed");
  }
}
