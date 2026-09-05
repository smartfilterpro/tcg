import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorJson } from "@/lib/apiError";

// The rig key: one long-lived credential that lets a scanning APPLIANCE
// (the Pi bridge) create bulk jobs for itself, so nobody has to open the
// admin panel and copy-paste a device key at the scanning bench.
//
// It is deliberately narrower than an admin session: it can create a job
// (and each job's own device key comes back once, as always) — nothing
// else. Only the SHA-256 of the key is stored; the plaintext is shown
// once at generation, and generating again replaces the old key
// immediately. Jobs it creates are attributed to the admin who minted it,
// which is who the AI spend lands on.

const STATE_KEY = "bulk_rig_key";

export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { data } = await admin.from("app_state").select("value").eq("key", STATE_KEY).maybeSingle();
    const v = (data?.value ?? null) as { created_at?: string } | null;
    return NextResponse.json({ exists: !!v, created_at: v?.created_at ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST() {
  try {
    const { user } = await requireAdmin();
    const admin = createAdminClient();
    const rigKey = `rk_${randomBytes(24).toString("base64url")}`;
    const hash = createHash("sha256").update(rigKey).digest("hex");
    const { error } = await admin.from("app_state").upsert({
      key: STATE_KEY,
      value: { hash, created_by: user.id, created_at: new Date().toISOString() },
    });
    if (error) throw error;
    return NextResponse.json({ rig_key: rigKey });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { error } = await admin.from("app_state").delete().eq("key", STATE_KEY);
    if (error) throw error;
    return NextResponse.json({ ok: true });
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
