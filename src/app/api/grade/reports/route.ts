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
