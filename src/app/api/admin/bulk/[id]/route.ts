import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { BULK_BUCKET, finalizeJob, identifyPhoto, type BulkRead } from "@/lib/bulkScan";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** GET ?rows=review|all&page=N — the job, its counts, and a page of rows
 *  with short-lived signed photo URLs for the review screen. */
export async function GET(req: Request, { params }: Params) {
  try {
    await requireAdmin();
    const { id } = await params;
    const url = new URL(req.url);
    const which = url.searchParams.get("rows") ?? "review";
    const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
    const PAGE = 25;

    const admin = createAdminClient();
    const { data: job } = await admin.from("bulk_jobs").select("*").eq("id", id).maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

    let q = admin
      .from("bulk_cards")
      .select("id, seq, pass1_path, pass2_path, pass1_read, pass2_read, card_id, variant, confidence, reviewed, review_note", { count: "exact" })
      .eq("job_id", id);
    if (which === "review") q = q.eq("confidence", "review").eq("reviewed", false);
    else if (which === "verified") q = q.eq("confidence", "verified");
    const { data: rows, count } = await q.order("seq").range(page * PAGE, page * PAGE + PAGE - 1);

    const signed = await Promise.all(
      ((rows ?? []) as Array<Record<string, unknown>>).map(async (r) => {
        const sign = async (path: unknown) =>
          typeof path === "string" && path
            ? (await admin.storage.from(BULK_BUCKET).createSignedUrl(path, 3600)).data?.signedUrl ?? null
            : null;
        const cardOf = async (cardId: unknown) => {
          if (typeof cardId !== "string" || !cardId) return null;
          const { data: c } = await admin
            .from("cards")
            .select("id, name, number, set_name")
            .eq("id", cardId)
            .maybeSingle();
          return c ?? null;
        };
        return {
          id: r.id,
          seq: r.seq,
          photo1: await sign(r.pass1_path),
          photo2: await sign(r.pass2_path),
          read1: r.pass1_read as BulkRead | null,
          read2: r.pass2_read as BulkRead | null,
          card: await cardOf(r.card_id),
          variant: r.variant,
          confidence: r.confidence,
          reviewed: r.reviewed,
          note: r.review_note,
        };
      })
    );

    return NextResponse.json({
      job: { ...job, ai_cost_usd: Number(job.ai_cost_usd ?? 0) },
      rows: signed,
      rowCount: count ?? 0,
      page,
      pageSize: PAGE,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH — job actions and row review.
 *  { action: "finalize" }                          pair passes, set confidence
 *  { action: "reopen" }                            back to accepting photos
 *  { action: "cancel" }                            close it out
 *  { action: "rotate_key" }                        new device key, old one dead immediately
 *  { row, cardId?, variant?, note? }               a human's verdict on a row */
/** DELETE — remove a job outright: its photos in storage, its card rows,
 *  and the job itself, in that order so a failure partway leaves the job
 *  visible (and re-deletable) rather than orphaning files under a job
 *  nobody can see. Member collections are untouched: an uploaded job's
 *  cards were written to the member and stay theirs — deleting the job
 *  deletes the paperwork, not the delivery (that's what Undo upload is
 *  for, before deleting). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    await requireAdmin();
    const { id } = await params;
    const admin = createAdminClient();
    const { data: job } = await admin.from("bulk_jobs").select("id").eq("id", id).maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

    // Storage first. list() pages at 100 by default; loop each pass folder
    // until it runs dry — an 8,000-card job holds up to 16k files.
    for (const folder of [`${id}/pass1`, `${id}/pass2`, id]) {
      for (;;) {
        const { data: files } = await admin.storage
          .from(BULK_BUCKET)
          .list(folder, { limit: 100 });
        // Subfolders list with a null id; only real files get removed, and
        // an all-folders page breaks the loop like an empty one.
        const paths = (files ?? [])
          .filter((f) => f.name && (f as { id?: string | null }).id != null)
          .map((f) => `${folder}/${f.name}`);
        if (paths.length === 0) break;
        const { error: rmErr } = await admin.storage.from(BULK_BUCKET).remove(paths);
        if (rmErr) throw rmErr;
      }
    }

    const { error: rowsErr } = await admin.from("bulk_cards").delete().eq("job_id", id);
    if (rowsErr) throw rowsErr;
    const { error: jobErr } = await admin.from("bulk_jobs").delete().eq("id", id);
    if (jobErr) throw jobErr;
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Couldn't delete the job");
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    await requireAdmin();
    const { id } = await params;
    const body = (await req.json()) as {
      action?: string;
      row?: string;
      cardId?: string | null;
      variant?: string;
      note?: string;
    };
    const admin = createAdminClient();
    const { data: job } = await admin
      .from("bulk_jobs")
      .select("id, status, created_by")
      .eq("id", id)
      .maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

    if (body.row) {
      if (job.status === "uploaded") {
        return NextResponse.json({ error: "Already uploaded — undo first to edit." }, { status: 409 });
      }
      // A correction: the human's pick IS the answer now.
      if (body.cardId) {
        const { data: card } = await admin.from("cards").select("id").eq("id", body.cardId).maybeSingle();
        if (!card) return NextResponse.json({ error: "That card id isn't in the catalogue." }, { status: 400 });
      }
      const { error } = await admin
        .from("bulk_cards")
        .update({
          ...(body.cardId !== undefined ? { card_id: body.cardId } : {}),
          ...(body.variant ? { variant: body.variant } : {}),
          reviewed: true,
          confidence: "corrected",
          review_note: (body.note ?? "").slice(0, 300) || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.row)
        .eq("job_id", id);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (body.action === "finalize") {
      if (job.status === "uploaded") {
        return NextResponse.json({ error: "Already uploaded." }, { status: 409 });
      }
      const result = await finalizeJob(admin, id);
      await admin
        .from("bulk_jobs")
        .update({ status: "ready", updated_at: new Date().toISOString() })
        .eq("id", id);
      return NextResponse.json({ ok: true, result });
    }
    if (body.action === "reread") {
      // Second chances without re-feeding cardboard: the photos are already
      // in storage, so every MACHINE-decided row — the review queue AND the
      // machine's own "verified" calls — gets a fresh identify-and-check
      // with whatever the reader has learned since it was shot. Verified
      // rows are included on purpose: when a reader flaw is systematic
      // (every card called reverse holo under the rig's lamp), the wrong
      // answers are the confident ones. Only human verdicts are untouched.
      // Batched with a time budget — a big job takes several clicks, each
      // one reporting how many are left.
      if (job.status === "uploaded") {
        return NextResponse.json({ error: "Already uploaded — undo first." }, { status: 409 });
      }
      const { data: stuck } = await admin
        .from("bulk_cards")
        .select("id, seq, pass1_path")
        .eq("job_id", id)
        .eq("reviewed", false)
        .not("pass1_path", "is", null)
        .order("seq");
      const rows = (stuck ?? []) as Array<{ id: string; seq: number; pass1_path: string }>;
      const adminUserId = (job.created_by as string | null) ?? "";
      const started = Date.now();
      let done = 0;
      for (let i = 0; i < rows.length; i += 4) {
        if (Date.now() - started > 220_000) break;
        await Promise.all(
          rows.slice(i, i + 4).map(async (r) => {
            const { data: file } = await admin.storage.from(BULK_BUCKET).download(r.pass1_path);
            if (!file) return;
            const buf = Buffer.from(await file.arrayBuffer());
            const mediaType = r.pass1_path.endsWith(".png")
              ? "image/png"
              : r.pass1_path.endsWith(".webp")
                ? "image/webp"
                : "image/jpeg";
            const read = await identifyPhoto(
              admin,
              id,
              adminUserId,
              { data: buf.toString("base64"), mediaType },
              { check: true }
            );
            await admin
              .from("bulk_cards")
              .update({ pass1_read: read, updated_at: new Date().toISOString() })
              .eq("id", r.id);
            done++;
          })
        );
      }
      const result = await finalizeJob(admin, id);
      return NextResponse.json({ ok: true, reread: done, remaining: rows.length - done, result });
    }
    if (body.action === "reopen") {
      if (job.status === "uploaded") {
        return NextResponse.json({ error: "Already uploaded — undo first." }, { status: 409 });
      }
      await admin.from("bulk_jobs").update({ status: "open", updated_at: new Date().toISOString() }).eq("id", id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "cancel") {
      await admin.from("bulk_jobs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "rotate_key") {
      // The recovery path for "I lost the link before pass 2" — the old
      // key stops working the instant this write lands, same one-time
      // visibility as a freshly created job's key, just not a new job.
      const deviceKey = `bk_${randomBytes(24).toString("base64url")}`;
      const { error } = await admin
        .from("bulk_jobs")
        .update({ device_key: deviceKey, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      return NextResponse.json({ ok: true, device_key: deviceKey });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** The consolidated final sheet: every resolved row folded to
 *  (card, variant) with quantities — the same shape the CSV loader eats. */
async function consolidate(admin: ReturnType<typeof createAdminClient>, jobId: string) {
  const { data } = await admin
    .from("bulk_cards")
    .select("seq, card_id, variant, confidence, reviewed, review_note")
    .eq("job_id", jobId)
    .order("seq");
  const rows = (data ?? []) as Array<{
    seq: number;
    card_id: string | null;
    variant: string;
    confidence: string | null;
    reviewed: boolean;
  }>;
  const unresolved = rows.filter(
    (r) => !(r.confidence === "verified" || (r.reviewed && r.card_id)) || !r.card_id
  );
  const counted = new Map<string, { card_id: string; variant: string; qty: number }>();
  for (const r of rows) {
    if (!r.card_id) continue;
    if (!(r.confidence === "verified" || r.reviewed)) continue;
    const key = `${r.card_id}|${r.variant}`;
    const prev = counted.get(key);
    if (prev) prev.qty += 1;
    else counted.set(key, { card_id: r.card_id, variant: r.variant, qty: 1 });
  }
  return { rows, unresolved, counted: [...counted.values()] };
}

/** POST — the money steps.
 *  { action: "export" }          → CSV report (also loader-compatible)
 *  { action: "upload", email }   → write into the member's collection
 *  { action: "undo" }            → reverse a previous upload, exactly */
export async function POST(req: Request, { params }: Params) {
  try {
    await requireAdmin();
    const { id } = await params;
    const body = (await req.json()) as { action?: string; email?: string };
    const admin = createAdminClient();
    const { data: job } = await admin.from("bulk_jobs").select("*").eq("id", id).maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

    if (body.action === "export") {
      const { rows, counted } = await consolidate(admin, id);
      const cardIds = [...new Set(counted.map((c) => c.card_id))];
      const names = new Map<string, { name: string; number: string; set_name: string | null }>();
      for (let i = 0; i < cardIds.length; i += 200) {
        const { data: cards } = await admin
          .from("cards")
          .select("id, name, number, set_name")
          .in("id", cardIds.slice(i, i + 200));
        for (const c of cards ?? []) names.set(c.id as string, c as never);
      }
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [
        ["name", "number", "set", "quantity", "variant", "card_id", "source"].map(esc).join(","),
        ...counted.map((c) => {
          const card = names.get(c.card_id);
          return [card?.name, card?.number, card?.set_name, c.qty, c.variant, c.card_id, job.label]
            .map(esc)
            .join(",");
        }),
      ];
      const resolvedCards = rows.filter((r) => r.card_id && (r.confidence === "verified" || r.reviewed)).length;
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="bulk-${(job.label as string).replace(/[^a-zA-Z0-9-]/g, "_")}.csv"`,
          "X-Resolved": String(resolvedCards),
        },
      });
    }

    if (body.action === "upload") {
      if (job.status === "uploaded") {
        return NextResponse.json({ error: "Already uploaded — undo first to run again." }, { status: 409 });
      }
      const email = (body.email ?? "").trim().toLowerCase();
      if (!email) return NextResponse.json({ error: "Which member? Give their email." }, { status: 400 });
      const { data: profile } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .ilike("email", email)
        .maybeSingle();
      if (!profile) return NextResponse.json({ error: `No member with the email ${email}.` }, { status: 404 });

      const { unresolved, counted } = await consolidate(admin, id);
      if (unresolved.length > 0) {
        return NextResponse.json(
          {
            error: `${unresolved.length} card${unresolved.length === 1 ? "" : "s"} still need review (or have no catalogue match) — every card needs a verified or human answer before upload.`,
          },
          { status: 409 }
        );
      }
      if (counted.length === 0) {
        return NextResponse.json({ error: "Nothing to upload." }, { status: 400 });
      }

      const receipts: Array<{
        item_id: string;
        action: "created" | "merged";
        qty: number;
        card_id: string;
        variant: string;
      }> = [];
      for (const c of counted) {
        const { data: created, error: insErr } = await admin
          .from("collection_items")
          .insert({ user_id: profile.id, card_id: c.card_id, quantity: c.qty, variant: c.variant })
          .select("id")
          .single();
        if (!insErr && created) {
          receipts.push({ item_id: created.id as string, action: "created", qty: c.qty, card_id: c.card_id, variant: c.variant });
          continue;
        }
        const { data: existing } = await admin
          .from("collection_items")
          .select("id, quantity")
          .eq("user_id", profile.id)
          .eq("card_id", c.card_id)
          .eq("variant", c.variant)
          .maybeSingle();
        if (!existing) throw new Error(insErr?.message ?? "insert failed");
        const { error: qtyErr } = await admin
          .from("collection_items")
          .update({ quantity: (existing.quantity as number) + c.qty })
          .eq("id", existing.id);
        if (qtyErr) throw qtyErr;
        receipts.push({ item_id: existing.id as string, action: "merged", qty: c.qty, card_id: c.card_id, variant: c.variant });
      }

      await admin
        .from("bulk_jobs")
        .update({
          status: "uploaded",
          uploaded_to: profile.id,
          uploaded_at: new Date().toISOString(),
          upload_result: receipts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      return NextResponse.json({
        ok: true,
        member: (profile.display_name as string | null) || (profile.email as string),
        cards: counted.reduce((s, c) => s + c.qty, 0),
        lines: counted.length,
      });
    }

    if (body.action === "undo") {
      if (job.status !== "uploaded" || !Array.isArray(job.upload_result)) {
        return NextResponse.json({ error: "Nothing to undo — this job hasn't uploaded." }, { status: 409 });
      }
      let removed = 0;
      let decremented = 0;
      const leftovers: string[] = [];
      for (const r of job.upload_result as Array<{
        item_id: string;
        action: string;
        qty: number;
      }>) {
        if (r.action === "created") {
          const { error } = await admin.from("collection_items").delete().eq("id", r.item_id);
          if (!error) removed++;
          else leftovers.push(r.item_id);
        } else {
          const { data: item } = await admin
            .from("collection_items")
            .select("id, quantity")
            .eq("id", r.item_id)
            .maybeSingle();
          if (!item) {
            leftovers.push(r.item_id);
            continue;
          }
          const next = (item.quantity as number) - r.qty;
          if (next > 0) {
            await admin.from("collection_items").update({ quantity: next }).eq("id", item.id);
            decremented++;
          } else {
            await admin.from("collection_items").delete().eq("id", item.id);
            removed++;
          }
        }
      }
      await admin
        .from("bulk_jobs")
        .update({
          status: "ready",
          uploaded_to: null,
          uploaded_at: null,
          upload_result: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      return NextResponse.json({ ok: true, removed, decremented, leftovers: leftovers.length });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return errorJson(err, "Request failed");
}
