import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import type { GradeReport } from "@/lib/grading";
import type { CenteringMeasurement } from "@/lib/cardGeometry";
import type { GradeValue } from "@/lib/gradeValue";

export interface SavedGrade {
  id: string;
  cardName: string | null;
  estimatedGrade: number | null;
  frontUrl: string | null;
  backUrl: string | null;
  createdAt: string;
  report: GradeReport;
  measurement: CenteringMeasurement | null;
  value: GradeValue | null;
  /** What the card actually graded, once it came back (migration 030). */
  actualGrade?: number | null;
  actualGrader?: string | null;
  actualCert?: string | null;
  actualNotes?: string | null;
}

const MIGRATION_HINT =
  "Saving grades needs a database update — run supabase/migrations/024_grade_reports.sql first.";

/** GET: this member's saved grades, newest first. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("grade_reports")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      if (/grade_reports/i.test(error.message ?? "")) {
        return NextResponse.json({ migrated: false, grades: [] });
      }
      throw error;
    }
    const grades: SavedGrade[] = (data ?? []).map((r) => ({
      id: r.id as string,
      cardName: (r.card_name as string | null) ?? null,
      estimatedGrade: r.estimated_grade == null ? null : Number(r.estimated_grade),
      frontUrl: (r.front_url as string | null) ?? null,
      backUrl: (r.back_url as string | null) ?? null,
      createdAt: r.created_at as string,
      report: r.report as GradeReport,
      measurement: (r.measurement as CenteringMeasurement | null) ?? null,
      value: (r.value as GradeValue | null) ?? null,
      actualGrade: r.actual_grade == null ? null : Number(r.actual_grade),
      actualGrader: (r.actual_grader as string | null) ?? null,
      actualCert: (r.actual_cert as string | null) ?? null,
      actualNotes: (r.actual_notes as string | null) ?? null,
    }));
    return NextResponse.json({ migrated: true, grades });
  } catch (err) {
    return fail(err);
  }
}

/** POST: save a finished grade. Best-effort — a failure here never costs
 *  the user the report they're already looking at. */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json()) as {
      report?: GradeReport;
      measurement?: unknown;
      value?: unknown;
      cardId?: string | null;
      cardName?: string | null;
      frontUrl?: string | null;
      backUrl?: string | null;
    };
    if (!body.report || typeof body.report !== "object") {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("grade_reports")
      .insert({
        user_id: user.id,
        card_id: body.cardId ?? null,
        card_name: body.cardName ?? body.report.card_identified ?? null,
        estimated_grade: body.report.estimated_grade ?? null,
        report: body.report,
        measurement: body.measurement ?? null,
        value: body.value ?? null,
        front_url: body.frontUrl ?? null,
        back_url: body.backUrl ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      if (/grade_reports/i.test(error.message ?? "")) {
        return NextResponse.json({ error: MIGRATION_HINT }, { status: 400 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true, id: data?.id ?? null });
  } catch (err) {
    return fail(err);
  }
}

/** DELETE: remove one saved grade (?id=). */
/** PATCH: record what the card actually graded. Body:
 *  { id, actualGrade, actualGrader, actualCert?, actualNotes? }
 *  A null actualGrade clears it.
 *
 *  This is the only source of real supervision the grader will ever have —
 *  everything else in a saved report is the model's own opinion. */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      actualGrade?: number | null;
      actualGrader?: string | null;
      actualCert?: string | null;
      actualNotes?: string | null;
    };
    if (!body.id) return NextResponse.json({ error: "Missing grade id." }, { status: 400 });

    const clearing = body.actualGrade == null;
    if (!clearing) {
      const g = Number(body.actualGrade);
      // Halves only: no grader issues an 8.3.
      if (!Number.isFinite(g) || g < 1 || g > 10 || Math.round(g * 2) !== g * 2) {
        return NextResponse.json(
          { error: "Grades run 1 to 10, in halves (8, 8.5, 9…)." },
          { status: 400 }
        );
      }
      if (!body.actualGrader) {
        return NextResponse.json(
          { error: "Say who graded it — the scales aren't interchangeable." },
          { status: 400 }
        );
      }
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("grade_reports")
      .update({
        actual_grade: clearing ? null : Number(body.actualGrade),
        actual_grader: clearing ? null : body.actualGrader,
        actual_cert: clearing ? null : (body.actualCert?.trim() || null),
        actual_notes: clearing ? null : (body.actualNotes?.trim() || null),
        actual_recorded_at: clearing ? null : new Date().toISOString(),
      })
      .eq("id", body.id)
      .eq("user_id", user.id)
      .select("id");
    if (error) {
      if (/actual_grade/.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Recording outcomes needs supabase/migrations/030_grade_outcomes.sql." },
          { status: 400 }
        );
      }
      throw error;
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "That grade isn't yours." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't save the outcome" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const { user } = await requireUser();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const supabase = await createClient();
    const { error } = await supabase
      .from("grade_reports")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("grade reports error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
