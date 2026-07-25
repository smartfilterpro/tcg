import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** DELETE: remove a user entirely (admin only, cannot delete yourself). */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireAdmin();
    const { id } = await params;
    if (id === user.id) {
      return NextResponse.json({ error: "You can't delete yourself." }, { status: 400 });
    }
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
