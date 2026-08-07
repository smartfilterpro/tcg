import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { mirrorCard, type MirrorRow } from "@/lib/artMirror";
import { signCardPhoto } from "@/lib/photoAccess";

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** One mirror per card at a time: a grid of <img> tags can ask for the
 *  same card twice (small in the grid, large in the detail view) and both
 *  requests should ride one download. */
const inFlight = new Map<string, Promise<unknown>>();

function pick(row: MirrorRow | null | undefined, size: "small" | "large"): string | null {
  if (!row) return null;
  return size === "large"
    ? (row.image_large ?? row.image_small)
    : (row.image_small ?? row.image_large);
}

/** GET /api/cards/[id]/art?size=small|large — serve a card's picture from
 *  our storage, mirroring it in passing if we don't hold it yet.
 *
 *  Always answers with a redirect: to our copy when we have (or just made)
 *  one, to the third-party source when mirroring failed — a broken mirror
 *  must degrade to the old hotlinking behaviour, never to a broken image. */
export async function GET(req: Request, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;
    const size = new URL(req.url).searchParams.get("size") === "large" ? "large" : "small";
    const ours = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const admin = createAdminClient();

    const { data: card } = await admin
      .from("cards")
      .select("id, image_small, image_large")
      .eq("id", id)
      .maybeSingle();
    const url = pick(card, size);
    if (!card || !url) return NextResponse.json({ error: "No image" }, { status: 404 });
    if (url.startsWith(ours)) {
      // A card whose picture is a member's photograph lives in the private
      // bucket, so the stored address is not a link. artSrc sends those to
      // /api/photo directly; this is for anything that still comes here.
      const signed = (await signCardPhoto(admin, url)) ?? url;
      return NextResponse.redirect(signed, {
        headers: { "Cache-Control": "private, max-age=1800" },
      });
    }

    let job = inFlight.get(id);
    if (!job) {
      job = mirrorCard(admin, card, ours).finally(() => inFlight.delete(id));
      inFlight.set(id, job);
    }
    await job.catch(() => {});

    const { data: fresh } = await admin
      .from("cards")
      .select("id, image_small, image_large")
      .eq("id", id)
      .maybeSingle();
    const finalUrl = pick(fresh, size) ?? url;
    return NextResponse.redirect(finalUrl, {
      // A successful mirror can be remembered for a while; a failure gets a
      // short leash so the next view retries.
      headers: {
        "Cache-Control": finalUrl.startsWith(ours) ? "private, max-age=3600" : "private, max-age=300",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Art failed" },
      { status: 500 }
    );
  }
}
