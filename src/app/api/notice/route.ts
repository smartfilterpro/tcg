import { NextResponse } from "next/server";
import { requireUser, requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// The site-wide notice: "Upgrade tonight at 11", "Trainer AI is down".
//
// Read by everyone, written by admins. One notice is live at a time — two
// banners stacked on a page is worse than none, and nobody reads the second.

export interface SiteNotice {
  id: string;
  body: string;
  level: "info" | "warning" | "outage";
  dismissible: boolean;
  startsAt: string;
  endsAt: string | null;
}

/** The notice that should be on screen right now, or null. */
export async function GET() {
  try {
    await requireUser();
    const admin = createAdminClient();
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("site_notices")
      .select("id, body, level, dismissible, starts_at, ends_at")
      .eq("active", true)
      .lte("starts_at", now)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // A missing table (migration 032 not run) is not an error worth showing.
    if (error || !data) return NextResponse.json({ notice: null });
    return NextResponse.json({
      notice: {
        id: data.id,
        body: data.body,
        level: data.level,
        dismissible: data.dismissible,
        startsAt: data.starts_at,
        endsAt: data.ends_at,
      } satisfies SiteNotice,
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ notice: null });
    return NextResponse.json({ notice: null });
  }
}

/** POST — publish a notice (admin). Replaces whatever was live: a new one
 *  supersedes the old rather than joining it. */
export async function POST(req: Request) {
  try {
    const { user } = await requireAdmin();
    const admin = createAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      body?: string;
      level?: string;
      dismissible?: boolean;
      startsAt?: string;
      endsAt?: string | null;
    };

    const text = (body.body ?? "").trim();
    if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
    if (text.length > 300) {
      // A banner is one sentence. Anything longer is a page, and a page in a
      // banner pushes the app off the screen on a phone.
      return NextResponse.json({ error: "Keep it under 300 characters." }, { status: 400 });
    }
    const level = ["info", "warning", "outage"].includes(body.level ?? "")
      ? (body.level as string)
      : "info";

    // Retire the current one first. Two live notices is a bug, not a feature.
    await admin.from("site_notices").update({ active: false }).eq("active", true);

    const { data, error } = await admin
      .from("site_notices")
      .insert({
        body: text,
        level,
        dismissible: body.dismissible !== false,
        starts_at: body.startsAt || new Date().toISOString(),
        ends_at: body.endsAt || null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) {
      return NextResponse.json(
        {
          error: error.message.includes("site_notices")
            ? "The notices table is missing — run supabase/migrations/032_admin_notice_and_grants.sql."
            : error.message,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Couldn't publish that notice" }, { status: 500 });
  }
}

/** DELETE — take the current notice down (admin). */
export async function DELETE() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    await admin.from("site_notices").update({ active: false }).eq("active", true);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Couldn't take it down" }, { status: 500 });
  }
}
