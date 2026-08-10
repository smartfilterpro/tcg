import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";
import { errorJson } from "@/lib/apiError";
import type { CollectionItem } from "@/lib/types";

interface Params {
  params: Promise<{ id: string }>;
}

/** GET: another household member's collection, read-only.
 *
 *  Separate from /api/friends/[id]/collection on purpose. That route exists
 *  to serve trades and gates on the share_collection opt-in, which is a
 *  decision about strangers. Family is not that decision — the plan is one
 *  household on one bill, and a parent shouldn't have to negotiate access to
 *  what they're paying for.
 *
 *  Membership is proved with the service role because family_members is
 *  deliberately unreadable by clients. The rows themselves come back through
 *  the caller's own client, so migration 061's policy is what actually
 *  decides, and this route can't hand out anything the database wouldn't. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const admin = createAdminClient();

    const { data: rows } = await admin
      .from("family_members")
      .select("user_id, group_id")
      .in("user_id", [user.id, id]);

    const mine = (rows ?? []).find((r) => r.user_id === user.id);
    const theirs = (rows ?? []).find((r) => r.user_id === id);
    if (!mine || !theirs || mine.group_id !== theirs.group_id || user.id === id) {
      // Same answer whether they exist, aren't family, or are you: this
      // shouldn't be usable to find out who has an account.
      return NextResponse.json({ error: "Not in your family." }, { status: 403 });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("display_name, email")
      .eq("id", id)
      .maybeSingle();

    const supabase = await createClient();
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("collection_items")
        .select("*, card:cards(*)")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .order("id")
    );
    if (error) throw error;

    return NextResponse.json({
      owner: {
        id,
        name:
          ((profile?.display_name as string | null) ?? "").trim() ||
          ((profile?.email as string) ?? "").split("@")[0],
      },
      items: (data ?? []) as unknown as CollectionItem[],
    });
  } catch (err) {
    return errorJson(err, "Couldn't load that collection.");
  }
}
