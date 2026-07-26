import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** PATCH: set a card's image to a user-uploaded photo.
 *  Body: { imageUrl } — must point at our own Supabase storage.
 *  Only allowed for cards the user actually owns a copy of. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user, profile } = await requireUser();
    const { id } = await params;
    const { imageUrl } = (await req.json()) as { imageUrl?: string };

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    if (
      !imageUrl ||
      typeof imageUrl !== "string" ||
      imageUrl.length > 500 ||
      !imageUrl.startsWith(`${supabaseUrl}/storage/v1/object/public/card-photos/`)
    ) {
      return NextResponse.json({ error: "Invalid image URL" }, { status: 400 });
    }

    const supabase = await createClient();
    const [{ data: owned }, { data: card }] = await Promise.all([
      supabase
        .from("collection_items")
        .select("id")
        .eq("user_id", user.id)
        .eq("card_id", id)
        .limit(1)
        .maybeSingle(),
      // select("*") — image_locked only exists after migration 007; naming
      // it would error the query on older databases.
      supabase.from("cards").select("*").eq("id", id).maybeSingle(),
    ]);
    if (!owned) {
      return NextResponse.json(
        { error: "You can only set photos on cards in your collection." },
        { status: 403 }
      );
    }

    // Always keep the photo as a candidate for admin review (best-effort).
    await supabase
      .from("card_image_candidates")
      .upsert(
        { card_id: id, url: imageUrl, uploaded_by: user.id },
        { onConflict: "card_id,url", ignoreDuplicates: true }
      )
      .then(() => {});

    const isAdmin = profile?.role === "admin";
    if (card?.image_locked && !isAdmin) {
      return NextResponse.json({
        ok: true,
        locked: true,
        message:
          "This card's image was set by the admin, so it can't be changed — your photo was submitted for review instead.",
      });
    }

    const { error } = await supabase
      .from("cards")
      .update({ image_small: imageUrl, image_large: imageUrl })
      .eq("id", id);
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
