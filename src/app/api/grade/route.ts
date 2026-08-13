import { NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";
import { checkCredits } from "@/lib/credits";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GRADING_SYSTEM, GRADE_SCHEMA, type GradeReport } from "@/lib/grading";
import { centeringCapBack, type CenteringMeasurement } from "@/lib/cardGeometry";
import { computeGradeValue, parseRange, type GradedPrices, type GradeValue } from "@/lib/gradeValue";
import { defaultVariantFor, priceForVariant } from "@/lib/types";
import { normalizeForSearch } from "@/lib/text";
import { errorJson, PublicError, safeMessage } from "@/lib/apiError";
import { GRADE_BODY_LIMIT, readJson } from "@/lib/requestBody";

export const maxDuration = 180;

const GRADE_LABELS: Record<number, string> = {
  10: "Gem Mint",
  9: "Mint",
  8: "Near Mint-Mint",
  7: "Near Mint",
  6: "Excellent-Mint",
  5: "Excellent",
  4: "Very Good-Excellent",
  3: "Very Good",
  2: "Good",
  1: "Poor",
};

function gradeLabel(grade: number): string {
  return GRADE_LABELS[Math.floor(grade)] ?? "Estimated";
}

type Img = { data?: string; mediaType?: string };
type CornerImg = { label?: string; data?: string; mediaType?: string };

interface SideInput {
  card?: Img;
  corners?: CornerImg[];
  centering?: CenteringMeasurement | null;
  /** Legacy single-photo shape. */
  data?: string;
  mediaType?: string;
}

const DEFAULT_FEE_USD = 25;

function imageBlock(img: { data?: string; mediaType?: string }) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: (img.mediaType as "image/jpeg" | "image/png" | "image/webp") ?? "image/jpeg",
      data: img.data!,
    },
  };
}

/** Accepts both the current shape (flattened card + corner close-ups) and
 *  the original one-photo-per-side shape, so a stale browser tab still
 *  works — it just grades without measurements. */
function normalizeSide(side: SideInput | undefined): {
  card: Img | null;
  corners: CornerImg[];
  centering: CenteringMeasurement | null;
} {
  if (!side) return { card: null, corners: [], centering: null };
  if (side.data) return { card: { data: side.data, mediaType: side.mediaType }, corners: [], centering: null };
  const corners = (side.corners ?? [])
    .filter((c) => typeof c?.data === "string" && c.data.length > 0)
    .slice(0, 4);
  return { card: side.card?.data ? side.card : null, corners, centering: side.centering ?? null };
}

function measurementLine(m: CenteringMeasurement | null, side: "front" | "back"): string {
  if (!m) {
    return `- ${side}: NOT MEASURABLE (no border this scan could read reliably). Estimate this one by eye and say so.`;
  }
  const cap = side === "front" ? m.cap : centeringCapBack(m.worst);
  const allowance =
    side === "front"
      ? "front allowances: 55/45 for a 10, 60/40 for a 9, 65/35 for an 8, 70/30 for a 7, 80/20 for a 6"
      : "back allowances are looser: roughly 75/25 for a 10 and 90/10 for a 9";
  const axes: string[] = [];
  if (m.lr) axes.push(`${m.lr.pct[0]}/${m.lr.pct[1]} left-to-right`);
  if (m.tb) axes.push(`${m.tb.pct[0]}/${m.tb.pct[1]} top-to-bottom`);
  const missing = !m.lr
    ? ` ${m.lrNote ?? "Left-to-right could not be read on this card."} Judge that axis by eye and say which edge defeated the measurement.`
    : !m.tb
      ? ` ${m.tbNote ?? "Top-to-bottom could not be read on this card."} Judge that axis by eye and say which edge defeated the measurement.`
      : "";
  return (
    `- ${side}: ${axes.join(", ")}. ` +
    `Worst measured axis ${m.worst}/${100 - m.worst}, so measured centering caps this side at ${cap} (${allowance}).${missing}`
  );
}

/** Find the card in our database so the report can talk about money. */
async function lookupValue(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  report: GradeReport,
  fee: number
): Promise<GradeValue | null> {
  const name = (report.card_name ?? "").trim();
  if (!name) return null;
  try {
    const { data } = await supabase
      .from("cards")
      .select("*")
      .ilike("name", `%${name}%`)
      .limit(60);
    let candidates = (data ?? []) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return null;

    // Prefer an exact name match, then the printed collector number.
    const wanted = normalizeForSearch(name);
    const exact = candidates.filter((c) => normalizeForSearch(String(c.name ?? "")) === wanted);
    if (exact.length > 0) candidates = exact;
    const number = (report.card_number ?? "").split("/")[0].trim();
    if (number) {
      const byNumber = candidates.filter(
        (c) => String(c.number ?? "").trim().toLowerCase() === number.toLowerCase()
      );
      if (byNumber.length > 0) candidates = byNumber;
    }

    // Then the copy the user actually owns, then anything with graded sales.
    const ids = candidates.map((c) => String(c.id));
    const { data: owned } = await supabase
      .from("collection_items")
      .select("card_id")
      .eq("user_id", userId)
      .in("card_id", ids);
    const ownedIds = new Set((owned ?? []).map((o) => String(o.card_id)));
    const score = (c: Record<string, unknown>) =>
      (ownedIds.has(String(c.id)) ? 2 : 0) + (c.graded_prices ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a));
    const card = candidates[0];

    // The FINISH matters, and this was ignoring it.
    //
    // market_price is the card's headline number and on a foil-only
    // printing it is routinely the wrong one — a Slowbro Illustration Rare
    // showed $16.09 in the collection, where the finish is known, and
    // $0.14 here, where it wasn't. Same card, same second, two answers, and
    // the grading advice was built on the wrong one: "worth about $0.14, so
    // only grade it for its own sake" about a card worth sixteen dollars.
    //
    // defaultVariantFor is the same reasoning the collection uses when a
    // card is added — an Illustration Rare has no plain printing, so the
    // only finish it comes in is the finish it is. Asking it here means the
    // two pages can no longer disagree.
    const variant = defaultVariantFor({
      prices: card.prices as Record<string, number | null> | null,
      rarity: card.rarity as string | null,
      name: card.name as string,
    });
    const raw = priceForVariant(
      {
        prices: card.prices as Record<string, number | null> | null,
        market_price: card.market_price as number | null,
      },
      variant
    );
    const graded = (card.graded_prices as GradedPrices | null) ?? null;

    return computeGradeValue({
      cardId: String(card.id),
      cardName: `${card.name}${card.set_name ? ` · ${card.set_name}` : ""}`,
      estimatedGrade: report.estimated_grade,
      range: report.grade_range,
      raw,
      graded,
      fee,
    });
  } catch {
    // graded_prices only exists after migration 023; value is a bonus, never
    // a reason to lose the grade.
    return null;
  }
}

/** POST: grade a card from flattened front + back images, corner close-ups,
 *  and software-measured centering. */
/** The grade itself, detached from the request that started it.
 *
 *  Same shape as the scan runner and for the same reason: the model runs for
 *  half a minute, phones lock, and the person has already paid. Everything
 *  thrown here lands on the job row where the client will find it. */
async function runGrade(opts: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  front: ReturnType<typeof normalizeSide>;
  back: ReturnType<typeof normalizeSide>;
  fee: number;
}): Promise<{ report: GradeReport; value: unknown }> {
  const { supabase, userId, front, back, fee } = opts;
  {

    // POST verified both images exist before starting the job; the type
    // doesn't carry that knowledge across the call.
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: "FRONT of the card, flattened (card only, camera angle removed):" },
      imageBlock(front.card!),
    ];
    for (const c of front.corners) {
      content.push({ type: "text", text: `Close-up — front ${c.label ?? "corner"}:` });
      content.push(imageBlock(c));
    }
    content.push({
      type: "text",
      text: "BACK of the card, flattened (card only, camera angle removed):",
    });
    content.push(imageBlock(back.card!));
    for (const c of back.corners) {
      content.push({ type: "text", text: `Close-up — back ${c.label ?? "corner"}:` });
      content.push(imageBlock(c));
    }

    const measured = front.centering || back.centering;
    content.push({
      type: "text",
      text: measured
        ? `CENTERING, MEASURED IN SOFTWARE from the flattened card (border widths counted in pixels — use these numbers, do not re-estimate them):\n${measurementLine(
            front.centering,
            "front"
          )}\n${measurementLine(back.centering, "back")}`
        : "CENTERING COULD NOT BE MEASURED on either side (no consistent printed border). Estimate centering by eye and state clearly in your notes that it was estimated rather than measured.",
    });
    content.push({
      type: "text",
      text: "Grade this card per the rubric. Be thorough and consistent, and give a verdict for every corner close-up you were shown.",
    });

    const client = anthropic();
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: GRADING_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: GRADE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: "user", content: content as never }],
    });
    const response = await stream.finalMessage();

    await logAiUsage(supabase, userId, "grade", MODEL, response.usage);

    if (response.stop_reason === "refusal") {
      throw new PublicError("Those photos couldn't be processed — try different ones.");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new PublicError("The grading ran out of room — please try again.");
    }
    let report: GradeReport;
    try {
      report = JSON.parse(textBlock.text) as GradeReport;
    } catch {
      throw new PublicError("The grading came back malformed — please try again.");
    }
    if (!report.is_card) {
      throw new Error(
        "That doesn't look like the front and back of a trading card — try again with clear photos of one card."
      );
    }

    // The measurement is ours, not the model's: hold the grade to it even if
    // the write-up drifts above the cap.
    if (front.centering) {
      const cap = front.centering.cap;
      if (report.centering.score > cap) report.centering.score = cap;
      if (report.estimated_grade > cap) {
        report.estimated_grade = cap;
        report.grade_label = `${gradeLabel(cap)} ${cap}`;
        const { low, high } = parseRange(report.grade_range, cap);
        report.grade_range = `${Math.min(low, cap)}-${Math.min(high, cap)}`;
      }
    }

    const value = await lookupValue(supabase, userId, report, fee);
    return { report, value };
  }
}

/** POST → { jobId } immediately; the grade continues server-side.
 *  GET ?job=<id> → the job's state; GET with no id → the newest running
 *  job, which is how a phone that slept finds its way back. */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const body = await readJson<{ front?: SideInput; back?: SideInput; fee?: number }>(
      req,
      GRADE_BODY_LIMIT
    );
    const front = normalizeSide(body.front);
    const back = normalizeSide(body.back);
    if (!front.card?.data || !back.card?.data) {
      return NextResponse.json(
        { error: "Both a front and a back photo are needed to grade." },
        { status: 400 }
      );
    }
    const fee =
      typeof body.fee === "number" && body.fee >= 0 && body.fee <= 500 ? body.fee : DEFAULT_FEE_USD;

    const supabase = await createClient();
    const budget = await checkCredits(user, profile);
    if (!budget.ok) {
      return NextResponse.json({ error: budget.message }, { status: 429 });
    }

    const admin = createAdminClient();
    const { data: job, error: jobErr } = await admin
      .from("grade_jobs")
      .insert({ user_id: user.id, status: "running" })
      .select("id")
      .single();
    if (jobErr || !job) {
      return NextResponse.json(
        {
          error: /grade_jobs/.test(jobErr?.message ?? "")
            ? "Grading needs a one-time database update — run supabase/migrations/035_grade_jobs.sql."
            : "Couldn't start the grade.",
        },
        { status: 500 }
      );
    }
    const jobId = job.id as string;

    void runGrade({ supabase, userId: user.id, front, back, fee })
      .then(async (result) => {
        await admin
          .from("grade_jobs")
          .update({ status: "done", result, updated_at: new Date().toISOString() })
          .eq("id", jobId);
      })
      .catch(async (err) => {
        await admin
          .from("grade_jobs")
          .update({
            status: "error",
            error: safeMessage(err, "Grading failed"),
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      });

    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("grade error", err);
    return errorJson(err, "Grading failed");
  }
}

export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = await createClient();
    const id = new URL(req.url).searchParams.get("job");
    let q = supabase
      .from("grade_jobs")
      .select("id, status, result, error, created_at")
      .eq("user_id", user.id);
    q = id ? q.eq("id", id) : q.eq("status", "running");
    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return NextResponse.json({ job: null, migrated: false });
    return NextResponse.json({ job: data ?? null, migrated: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ job: null }, { status: 500 });
  }
}
