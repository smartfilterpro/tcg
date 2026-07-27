import { NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage, checkAiBudget } from "@/lib/usage";
import { createClient } from "@/lib/supabase/server";
import { GRADING_SYSTEM, GRADE_SCHEMA, type GradeReport } from "@/lib/grading";

export const maxDuration = 180;

type Img = { data?: string; mediaType?: string };

function imageBlock(img: Img) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: (img.mediaType as "image/jpeg" | "image/png" | "image/webp") ?? "image/jpeg",
      data: img.data!,
    },
  };
}

/** POST: grade a card from front + back photos using the fixed rubric. */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { front, back } = (await req.json()) as { front?: Img; back?: Img };
    if (!front?.data || !back?.data) {
      return NextResponse.json(
        { error: "Both a front and a back photo are needed to grade." },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const budget = await checkAiBudget(supabase, user, profile);
    if (!budget.ok) {
      return NextResponse.json({ error: budget.message }, { status: 429 });
    }

    const client = anthropic();
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: GRADING_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: GRADE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "FRONT of the card:" },
            imageBlock(front),
            { type: "text", text: "BACK of the card:" },
            imageBlock(back),
            {
              type: "text",
              text: "Grade this card per the rubric. Be thorough and consistent.",
            },
          ],
        },
      ],
    });
    const response = await stream.finalMessage();

    await logAiUsage(supabase, user.id, "grade", MODEL, response.usage);

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "Those photos couldn't be processed — try different ones." },
        { status: 422 }
      );
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json(
        { error: "The grading ran out of room — please try again." },
        { status: 422 }
      );
    }
    let report: GradeReport;
    try {
      report = JSON.parse(textBlock.text) as GradeReport;
    } catch {
      return NextResponse.json(
        { error: "The grading came back malformed — please try again." },
        { status: 422 }
      );
    }
    if (!report.is_card) {
      return NextResponse.json(
        { error: "That doesn't look like the front and back of a trading card — try again with clear photos of one card." },
        { status: 422 }
      );
    }
    return NextResponse.json({ report });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("grade error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grading failed" },
      { status: 500 }
    );
  }
}
