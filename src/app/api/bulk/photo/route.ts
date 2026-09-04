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
// seq is optional (defaults to next); pass 2 pairs with pass 1 by feed
// order — REVERSE by default (pass-2 card s pairs with pass-1 card
// N+1−s), or 1:1 when the client sends order=same. Identification starts
// immediately, detached, so by the time the stack finishes most reads are
// already done.

/** DELETE ?job=<id>&pass=1|2 — erase one pass and start it over.
 *
 *  Same auth as POST (the device key), because it serves the same person:
 *  whoever is feeding cards and realizes the pass went wrong. Clears the
 *  pass's photos from storage and its half of every row; rows left with
 *  neither pass are removed. The job must still be open. */
export async function DELETE(req: Request) {
  try {
    const key = req.headers.get("x-bulk-key") ?? "";
    if (!key) return NextResponse.json({ error: "Missing x-bulk-key header." }, { status: 401 });
    const url = new URL(req.url);
    const jobId = url.searchParams.get("job") ?? "";
    const pass = url.searchParams.get("pass") === "2" ? 2 : 1;
    if (!jobId) return NextResponse.json({ error: "Missing job parameter." }, { status: 400 });

    const admin = createAdminClient();
    const { data: job } = await admin
      .from("bulk_jobs")
      .select("id, status, device_key")
      .eq("id", jobId)
      .maybeSingle();
    if (!job || !secretMatches(key, job.device_key as string | null)) {
      return NextResponse.json({ error: "Unknown job or wrong device key." }, { status: 403 });
    }
    if (job.status !== "open") {
      return NextResponse.json(
        { error: `This job is ${job.status} — reopen it before erasing a pass.` },
        { status: 409 }
      );
    }

    // Storage: everything under this pass's folder, paged.
    const folder = `${jobId}/pass${pass}`;
    let cleared = 0;
    for (;;) {
      const { data: files } = await admin.storage.from(BULK_BUCKET).list(folder, { limit: 100 });
      const paths = (files ?? [])
        .filter((f) => f.name && (f as { id?: string | null }).id != null)
        .map((f) => `${folder}/${f.name}`);
      if (paths.length === 0) break;
      const { error: rmErr } = await admin.storage.from(BULK_BUCKET).remove(paths);
      if (rmErr) throw rmErr;
      cleared += paths.length;
    }

    // Rows: this pass's half cleared everywhere; rows with nothing left go.
    const clear =
      pass === 1
        ? { pass1_path: null, pass1_read: null, updated_at: new Date().toISOString() }
        : { pass2_path: null, pass2_read: null, updated_at: new Date().toISOString() };
    const { error: upErr } = await admin.from("bulk_cards").update(clear).eq("job_id", jobId);
    if (upErr) throw upErr;
    const { error: delErr } = await admin
      .from("bulk_cards")
      .delete()
      .eq("job_id", jobId)
      .is("pass1_path", null)
      .is("pass2_path", null);
    if (delErr) throw delErr;

    return NextResponse.json({ ok: true, pass, cleared });
  } catch (err) {
    return errorJson(err, "Couldn't erase the pass");
  }
}

export async function POST(req: Request) {
  try {
    const key = req.headers.get("x-bulk-key") ?? "";
    if (!key) return NextResponse.json({ error: "Missing x-bulk-key header." }, { status: 401 });

    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "Send multipart/form-data." }, { status: 400 });
    const jobId = String(form.get("job") ?? "");
    const pass = String(form.get("pass") ?? "1") === "2" ? 2 : 1;
    // How pass 2 was fed. "reverse" (the default, and the Pi rig's
    // contract) is the natural result of picking a stack up and feeding it
    // again; "same" is for rigs whose second run preserves order — the
    // phone chute, per its operator. Decided per photo by the client that
    // knows how the cards actually moved.
    const order = String(form.get("order") ?? "reverse") === "same" ? "same" : "reverse";
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
    // Reverse: pass 2's s-th card is pass 1's (N+1−s)-th. Same: it's just s.
    const targetSeq =
      pass === 1 ? ordinal : order === "same" ? ordinal : (pass1Count ?? 0) + 1 - ordinal;

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
