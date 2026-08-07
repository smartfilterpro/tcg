import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** GET /api/health — is this instance actually serving?
 *
 *  Security audit finding L2: there was no such route, so Railway's probe
 *  fell back to the app root. That renders a full React page and reads the
 *  database on the way, which is a heavy thing to do every thirty seconds
 *  and — worse — cannot tell "app up, database down" from "app down". Both
 *  answered 200 or both answered 500 depending on where the fault was, and
 *  neither told you which.
 *
 *  So: one cheap read, reported separately from the process being alive.
 *  The status code stays 200 while the app itself is serving, because a
 *  platform that restarts the container over a database blip turns a
 *  recoverable outage into a longer one. A monitor that cares reads the
 *  body — which is the point of having one.
 *
 *  Public, deliberately: a probe cannot sign in. It says nothing an
 *  unauthenticated caller could use — no version, no hostname, no counts.
 */
export async function GET() {
  const startedAt = Date.now();
  let database: "ok" | "slow" | "down" = "down";
  try {
    const admin = createAdminClient();
    // The lightest query that still proves the connection and PostgREST
    // are both answering: a count with no rows returned.
    const probe = admin.from("profiles").select("id", { count: "exact", head: true }).limit(1);
    const { error } = await Promise.race([
      probe,
      new Promise<{ error: Error }>((resolve) =>
        setTimeout(() => resolve({ error: new Error("timeout") }), 4000)
      ),
    ]);
    if (!error) database = Date.now() - startedAt > 1500 ? "slow" : "ok";
  } catch {
    database = "down";
  }

  return NextResponse.json(
    { ok: true, database, ms: Date.now() - startedAt },
    { headers: { "Cache-Control": "no-store" } }
  );
}
