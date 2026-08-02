import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { recentLogs, logsAsText } from "@/lib/logBuffer";

/** GET: the recent server log this process has kept.
 *
 *  `?format=text` returns it as a downloadable file, which is the form worth
 *  sending to somebody. Admin only — the log carries card ids, job internals
 *  and error messages, which is not member-facing detail.
 *
 *  Never cached: a log read from cache is a log about the past. */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const format = new URL(req.url).searchParams.get("format");
    if (format === "text") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      return new NextResponse(logsAsText(), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="trainerdeck-log-${stamp}.txt"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(recentLogs(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't read the log" },
      { status: 500 }
    );
  }
}
