import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { anthropic, MODEL } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/usage";
import { emailEnabled, sendEmail } from "@/lib/mailer";
import { newsletterFooter, siteBase } from "@/lib/newsletter";
import { APP_NAME, AI_NAME } from "@/lib/branding";
import { fetchAllRows } from "@/lib/fetchAll";
import { errorJson } from "@/lib/apiError";

export const maxDuration = 300;

/** The admin's newsletter desk.
 *
 *  GET  — subscriber count and whether SMTP is configured.
 *  POST — { action: "draft", notes }        → AI-written subject + body
 *         { action: "test", subject, body } → one email, to the admin
 *         { action: "send", subject, body } → every opted-in subscriber
 *
 *  The draft is a starting point the admin edits, never something that
 *  sends itself: generation and sending are separate actions on purpose,
 *  with the admin's eyes between them. */

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "The email subject line. Concrete and short — under 60 characters." },
    body: {
      type: "string",
      description:
        "The newsletter body as PLAIN TEXT (no markdown syntax, no HTML). Short paragraphs, blank lines between them. 150-350 words.",
    },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const DRAFT_SYSTEM = `You write the newsletter for ${APP_NAME}, a trading card
collection app (Pokémon TCG and Magic: The Gathering): bulk scanning by
photo, collection value tracking, ${AI_NAME} deck building and coaching, set
completion, card grading, family accounts.

You will be given the owner's notes — what's new, what to announce. Write a
short, warm, plain-text email to members who OPTED IN to hear from the app.

RULES:
- Only claim what the notes say. Never invent features, dates, or prices.
- Plain text only: no markdown, no HTML, no emoji spam (one or two is fine).
- Short paragraphs. A reader skims email; front-load what's new.
- One clear pointer to the app (${siteBase()}) near the end, not a wall of links.
- No hype adjectives ("amazing", "revolutionary"). The product news IS the pitch.
- Do not add an unsubscribe line — the app appends its own to every send.`;

export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    let subscribers = 0;
    let migrated = true;
    try {
      const { count, error } = await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("newsletter_opt_in", true);
      if (error) throw error;
      subscribers = count ?? 0;
    } catch {
      migrated = false;
    }
    return NextResponse.json({ subscribers, migrated, emailReady: emailEnabled() });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}

export async function POST(req: Request) {
  try {
    const { user, profile } = await requireAdmin();
    const body = (await req.json()) as {
      action?: string;
      notes?: string;
      subject?: string;
      body?: string;
    };
    const admin = createAdminClient();

    if (body.action === "draft") {
      const notes = (body.notes ?? "").trim().slice(0, 4000);
      if (!notes) {
        return NextResponse.json(
          { error: "Give the draft some notes — what should this issue say?" },
          { status: 400 }
        );
      }
      const client = anthropic();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: DRAFT_SYSTEM,
        output_config: {
          format: { type: "json_schema", schema: DRAFT_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: "user", content: `THE OWNER'S NOTES FOR THIS ISSUE:\n${notes}` }],
      });
      await logAiUsage(admin, user.id, "newsletter", MODEL, response.usage);
      const block = response.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") throw new Error("No draft produced — try again.");
      const draft = JSON.parse(block.text) as { subject: string; body: string };
      return NextResponse.json(draft);
    }

    const subject = (body.subject ?? "").trim().slice(0, 200);
    const text = (body.body ?? "").trim().slice(0, 20_000);
    if (!subject || !text) {
      return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });
    }
    if (!emailEnabled()) {
      return NextResponse.json(
        { error: "Email isn't configured — set SMTP_HOST/PORT/USER/PASS/FROM in Railway first." },
        { status: 400 }
      );
    }

    if (body.action === "test") {
      const to = profile?.email ?? user.email;
      if (!to) return NextResponse.json({ error: "Your account has no email." }, { status: 400 });
      await sendEmail({
        to,
        subject: `[TEST] ${subject}`,
        text: text + newsletterFooter(user.id),
      });
      return NextResponse.json({ ok: true, to });
    }

    if (body.action === "send") {
      type Sub = { id: string; email: string | null };
      const { data: subs, error } = await fetchAllRows<Sub>(() =>
        admin
          .from("profiles")
          .select("id, email")
          .eq("newsletter_opt_in", true)
          .order("id") as unknown as {
          range: (from: number, to: number) => PromiseLike<{
            data: Sub[] | null;
            error: { message: string } | null;
          }>;
        }
      );
      if (error) throw error;
      const list = (subs ?? []).filter((s): s is { id: string; email: string } => !!s.email);
      let sent = 0;
      const failures: string[] = [];
      for (const s of list) {
        try {
          await sendEmail({
            to: s.email,
            subject,
            text: text + newsletterFooter(s.id),
            headers: {
              "List-Unsubscribe": `<${siteBase()}/api/newsletter/unsubscribe?u=${encodeURIComponent(s.id)}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          });
          sent++;
        } catch (e) {
          failures.push(`${s.email}: ${e instanceof Error ? e.message : "failed"}`);
          // One bad address must not sink the issue — but a run of straight
          // failures means the server is refusing us; stop rather than burn
          // the sender's reputation against a wall.
          if (failures.length >= 5 && sent === 0) break;
        }
        // A polite gap keeps the SMTP host from reading a send as a burst.
        await new Promise((r) => setTimeout(r, 150));
      }
      console.log(
        `newsletter: "${subject}" sent to ${sent}/${list.length}` +
          (failures.length ? `, ${failures.length} failed` : "")
      );
      return NextResponse.json({ sent, total: list.length, failures: failures.slice(0, 5) });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
