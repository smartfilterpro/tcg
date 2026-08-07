import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { writeZip, type ZipEntry } from "@/lib/zip";
import { signCardPhotos } from "@/lib/photoAccess";
import type { GradeReport } from "@/lib/grading";

export const maxDuration = 120;

/** Every saved grading report, for improving the grader.
 *
 *  GET /api/admin/grade-export?format=jsonl        — one JSON object a line
 *  GET /api/admin/grade-export?format=csv          — flat, for a spreadsheet
 *  GET /api/admin/grade-export?only=labelled       — only rows with a real grade
 *
 *  JSONL is the default because that is what fine-tuning and eval harnesses
 *  read, and because a grading example does not flatten well: subgrades,
 *  per-corner notes and caveats are nested by nature.
 *
 *  READ THIS BEFORE TRAINING ON THE OUTPUT. Rows without `actual` contain the
 *  model's own estimate and nothing else. Training on those teaches the model
 *  to reproduce its current mistakes with more confidence — the technical
 *  term is model collapse, and it looks like improvement right up until it
 *  doesn't. Only rows carrying `actual` (a grade a human grader assigned)
 *  are supervision. The rest are useful for eval, drift-watching and finding
 *  disagreements worth a human look — which is genuinely valuable, just not
 *  the same thing.
 */

interface Row {
  id: string;
  user_id: string;
  card_id: string | null;
  card_name: string | null;
  estimated_grade: number | null;
  report: GradeReport;
  measurement: Record<string, unknown> | null;
  value: Record<string, unknown> | null;
  front_url: string | null;
  back_url: string | null;
  created_at: string;
  actual_grade: number | null;
  actual_grader: string | null;
  actual_subgrades: Record<string, number> | null;
  actual_cert: string | null;
  actual_notes: string | null;
  actual_recorded_at: string | null;
}

/** One training/eval example. */
function toExample(r: Row) {
  const rep = r.report ?? ({} as GradeReport);
  const predicted = r.estimated_grade ?? rep.estimated_grade ?? null;
  const actual = r.actual_grade;
  return {
    id: r.id,
    graded_at: r.created_at,
    // Pseudonymous: which reports came from one person matters for splitting
    // train/test without leaking the same card across both, but who they are
    // does not.
    submitter: hashId(r.user_id),
    card: { id: r.card_id, name: r.card_name ?? rep.card_identified ?? null },

    // ---- inputs the model saw ----
    images: { front: r.front_url, back: r.back_url },
    measured_centering: r.measurement,
    photo_quality: rep.photo_quality ?? null,

    // ---- what the model said ----
    predicted: {
      grade: predicted,
      label: rep.grade_label ?? null,
      range: rep.grade_range ?? null,
      confidence: rep.confidence ?? null,
      subgrades: {
        centering: rep.centering?.score ?? null,
        corners: rep.corners?.score ?? null,
        edges: rep.edges?.score ?? null,
        surface: rep.surface?.score ?? null,
      },
      centering_estimate: rep.centering?.estimate ?? null,
      corner_details: rep.corners?.details ?? [],
      notes: {
        centering: rep.centering?.notes ?? null,
        corners: rep.corners?.notes ?? null,
        edges: rep.edges?.notes ?? null,
        surface: rep.surface?.notes ?? null,
      },
      summary: rep.summary ?? null,
      caveats: rep.caveats ?? [],
    },

    // ---- ground truth, when the card actually came back ----
    actual:
      actual == null
        ? null
        : {
            grade: actual,
            grader: r.actual_grader,
            subgrades: r.actual_subgrades,
            cert: r.actual_cert,
            notes: r.actual_notes,
            recorded_at: r.actual_recorded_at,
          },

    // Precomputed so nobody has to re-derive it in a notebook, and so the
    // CSV can carry it too.
    agreement:
      actual == null || predicted == null
        ? null
        : {
            delta: Number((predicted - actual).toFixed(2)),
            exact: predicted === actual,
            within_half: Math.abs(predicted - actual) <= 0.5,
            within_one: Math.abs(predicted - actual) <= 1,
            direction: predicted > actual ? "over" : predicted < actual ? "under" : "exact",
          },
  };
}

/** Stable pseudonym for a user id — same person, same token, no way back. */
function hashId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `s${Math.abs(h).toString(36)}`;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Excel reads a leading =, +, - or @ as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const raw = url.searchParams.get("format");
    const format = raw === "csv" ? "csv" : raw === "zip" ? "zip" : "jsonl";
    // Photos make the archive big — a few hundred KB each — so the zip is
    // paged rather than pretending a whole corpus fits in one response.
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const onlyLabelled = url.searchParams.get("only") === "labelled";

    const admin = createAdminClient();
    let q = admin
      .from("grade_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id");
    q = format === "zip" ? q.range(offset, offset + limit - 1) : q.limit(10000);
    if (onlyLabelled) q = q.not("actual_grade", "is", null);

    const { data, error } = await q;
    if (error) {
      if (/actual_grade/.test(error.message ?? "")) {
        return NextResponse.json(
          {
            error:
              "Grading outcomes need a one-time database update — run " +
              "supabase/migrations/030_grade_outcomes.sql first.",
          },
          { status: 400 }
        );
      }
      throw error;
    }

    const examples = ((data ?? []) as unknown as Row[]).map(toExample);
    const stamp = new Date().toISOString().slice(0, 10);

    // The photos are in a private bucket (054), so the stored addresses no
    // longer resolve — which matters for the zip, which downloads them, and
    // for the CSV, where the link is the only way back to the picture. A
    // week is long enough to work through an export and short enough that a
    // mislaid spreadsheet is not a standing key to members' photographs.
    const EXPORT_TTL_SECONDS = 7 * 24 * 3600;
    const links = await signCardPhotos(
      admin,
      examples.flatMap((e) => [e.images.front, e.images.back]),
      EXPORT_TTL_SECONDS
    );
    examples.forEach((e, i) => {
      e.images.front = links[i * 2];
      e.images.back = links[i * 2 + 1];
    });

    if (format === "csv") {
      const header = [
        "id", "graded_at", "submitter", "card_name", "card_id",
        "predicted_grade", "predicted_confidence",
        "pred_centering", "pred_corners", "pred_edges", "pred_surface",
        "measured_centering",
        "actual_grade", "actual_grader", "actual_cert",
        "delta", "within_half", "direction",
        "front_url", "back_url",
      ];
      const rows = examples.map((e) =>
        [
          e.id, e.graded_at, e.submitter, e.card.name, e.card.id,
          e.predicted.grade, e.predicted.confidence,
          e.predicted.subgrades.centering, e.predicted.subgrades.corners,
          e.predicted.subgrades.edges, e.predicted.subgrades.surface,
          e.predicted.centering_estimate,
          e.actual?.grade ?? "", e.actual?.grader ?? "", e.actual?.cert ?? "",
          e.agreement?.delta ?? "", e.agreement?.within_half ?? "", e.agreement?.direction ?? "",
          e.images.front, e.images.back,
        ].map(csvCell).join(",")
      );
      // BOM so Excel opens UTF-8 card names without mangling them.
      const csv = "﻿" + [header.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv;charset=utf-8",
          "Content-Disposition": `attachment; filename="grades-${stamp}.csv"`,
        },
      });
    }

    if (format === "zip") {
      // The images ARE the training data. A JSONL of grades with URLs in it
      // is not a dataset — it's a dataset plus a scavenger hunt, and the URLs
      // stop resolving the moment a photo is deleted or the bucket is
      // reconfigured. So the archive carries the pixels.
      const files: ZipEntry[] = [];
      let fetched = 0;
      let missing = 0;

      // Sequential, not parallel: this is an admin pulling a training set,
      // nobody is waiting on a spinner, and a hundred concurrent fetches at
      // the storage bucket is a good way to get rate limited mid-export.
      for (const e of examples) {
        for (const side of ["front", "back"] as const) {
          const src = e.images[side];
          if (!src) {
            missing += 1;
            continue;
          }
          try {
            const res = await fetch(src, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
            if (!res.ok) {
              missing += 1;
              continue;
            }
            files.push({
              // Named by example id so a row in the JSONL and its photos are
              // matched by inspection, with no lookup table.
              name: `images/${e.id}-${side}.jpg`,
              data: new Uint8Array(await res.arrayBuffer()),
            });
            fetched += 1;
          } catch {
            missing += 1;
          }
        }
      }

      const meta = {
        _meta: {
          exported_at: new Date().toISOString(),
          examples: examples.length,
          labelled: examples.filter((x) => x.actual != null).length,
          images_included: fetched,
          images_missing: missing,
          page: { offset, limit },
          images_note:
            "Each example's photos are images/<id>-front.jpg and <id>-back.jpg. " +
            "Missing files mean the photo was deleted or unreachable at export time.",
          training_warning:
            "Rows without `actual` hold the model's OWN estimate. Training on those " +
            "teaches it to reproduce its current mistakes with more confidence. Only " +
            "rows carrying `actual` — a grade a human grader assigned — are supervision.",
        },
      };
      files.push({
        name: "examples.jsonl",
        data: new TextEncoder().encode(
          [JSON.stringify(meta), ...examples.map((e) => JSON.stringify(e))].join("\n") + "\n"
        ),
      });

      const zip = writeZip(files);
      return new NextResponse(Buffer.from(zip), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="grades-${stamp}-${offset}.zip"`,
        },
      });
    }

    // JSONL, with a leading metadata line describing what the file is. A
    // dataset that arrives without its own provenance gets misused.
    const labelled = examples.filter((e) => e.actual != null).length;
    const meta = {
      _meta: true,
      exported_at: new Date().toISOString(),
      examples: examples.length,
      with_ground_truth: labelled,
      note:
        "Only rows where `actual` is non-null carry a human grader's label and are " +
        "suitable for supervised training. Rows without it contain the model's own " +
        "estimate; training on those reinforces existing errors. They remain useful " +
        "for evaluation and for finding disagreements to review.",
    };
    const body = [meta, ...examples].map((e) => JSON.stringify(e)).join("\n") + "\n";
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/x-ndjson;charset=utf-8",
        "Content-Disposition": `attachment; filename="grades-${stamp}.jsonl"`,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("grade export error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 }
    );
  }
}
