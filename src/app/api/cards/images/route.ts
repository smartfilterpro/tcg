import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

/** GET ?ids=a,b,c — card images from the local cache, for deck displays. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const idsParam = new URL(req.url).searchParams.get("ids") ?? "";
    const ids = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 150);
    if (ids.length === 0) return NextResponse.json({ images: {} });

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("cards")
      .select("id, image_small")
      .in("id", ids);
    if (error) throw error;

    const images: Record<string, string | null> = {};
    for (const row of data ?? []) images[row.id] = row.image_small;
    return NextResponse.json({ images });
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
