import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCardPhotoUrl } from "@/lib/photoUrl";
import { mayViewCardPhoto, signCardPhoto } from "@/lib/photoAccess";

/** GET /api/photo?u=<stored url> — the only way into the card-photos bucket.
 *
 *  Authenticates, decides whether this person may see this particular
 *  object (photoAccess has the rule), and redirects to a link that dies
 *  within the hour. The stored URL is passed in rather than a card id
 *  because the same picture is reached from four directions — a card in the
 *  catalogue, a row in the scan review, a saved grade report, the admin
 *  image queue — and only one of those has a card id to hand.
 *
 *  Half the redirect's life is cached, so a grid of fifty cards asks once
 *  per photo per half hour rather than on every render. */
export async function GET(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const raw = new URL(req.url).searchParams.get("u");
    if (!raw) return NextResponse.json({ error: "No photo" }, { status: 400 });

    // Only ever our own storage, and only ever a path that means what it
    // says: the URL is turned into an object path, so a traversal in it
    // would be a traversal in the bucket.
    const ours = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!ours || !raw.startsWith(ours) || !isCardPhotoUrl(raw) || raw.includes("..")) {
      return NextResponse.json({ error: "Not a card photo" }, { status: 400 });
    }

    const admin = createAdminClient();
    const allowed = await mayViewCardPhoto(admin, raw, user.id, profile?.role === "admin");
    if (!allowed) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    const url = await signCardPhoto(admin, raw);
    if (!url || url === raw) {
      // Signing failed. Saying so beats redirecting to the stored URL,
      // which is exactly the address that no longer resolves.
      return NextResponse.json({ error: "Photo unavailable" }, { status: 502 });
    }
    return NextResponse.redirect(url, {
      headers: { "Cache-Control": "private, max-age=1800" },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Photo failed" }, { status: 500 });
  }
}
