import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import type { CollectionItem } from "@/lib/types";
import { fetchAllRows } from "@/lib/fetchAll";

type Params = { params: Promise<{ id: string }> };

/** GET: a friend's collection — only if they've opted into sharing. */
export async function GET(_req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const supabase = await createClient();

    const { data: friend } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!friend || friend.share_collection !== true) {
      return NextResponse.json(
        { error: "This member isn't sharing their collection." },
        { status: 403 }
      );
    }

    // RLS (migration 008) allows reading shared members' items
    const { data, error } = await fetchAllRows(() =>
      supabase
        .from("collection_items")
        .select("*, card:cards(*)")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
    );
    if (error) throw error;

    return NextResponse.json({
      friend: { id: friend.id, name: friend.display_name || friend.email },
      items: (data ?? []) as unknown as CollectionItem[],
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("friend collection error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
