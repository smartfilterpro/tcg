import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth";

export interface ReviewCandidate {
  id: string;
  url: string;
  uploadedByEmail: string | null;
  createdAt: string;
}

export interface ReviewRow {
  card: {
    id: string;
    name: string;
    set_name: string | null;
    number: string | null;
    image_small: string | null;
    image_locked: boolean;
  };
  candidates: ReviewCandidate[];
}

/** GET: cards that need image review (admin only) — every card that has
 *  submitted photo candidates, plus cards with no image at all. */
export async function GET() {
  try {
    await requireAdmin();
    const admin = createAdminClient();

    const [{ data: candidates, error: candErr }, { data: missing, error: missErr }] =
      await Promise.all([
        admin
          .from("card_image_candidates")
          .select("id, card_id, url, uploaded_by, created_at")
          .order("created_at", { ascending: false })
          .limit(1000),
        admin
          .from("cards")
          .select("id, name, set_name, number, image_small, image_locked")
          .is("image_small", null)
          .order("name")
          .limit(300),
      ]);
    if (missErr) throw missErr;
    // Tolerate a missing candidates table (migration 007 not applied yet) —
    // still list the cards that have no image at all.
    if (candErr) console.error("card_image_candidates unavailable", candErr.message);

    const candidateCardIds = [...new Set((candidates ?? []).map((c) => c.card_id as string))];
    const missingById = new Map((missing ?? []).map((c) => [c.id as string, c]));
    const extraIds = candidateCardIds.filter((id) => !missingById.has(id));

    let extraCards: typeof missing = [];
    if (extraIds.length > 0) {
      const { data, error } = await admin
        .from("cards")
        .select("id, name, set_name, number, image_small, image_locked")
        .in("id", extraIds);
      if (error) throw error;
      extraCards = data;
    }
    const cardById = new Map(
      [...(missing ?? []), ...(extraCards ?? [])].map((c) => [c.id as string, c])
    );

    // Resolve uploader emails for attribution
    const uploaderIds = [
      ...new Set((candidates ?? []).map((c) => c.uploaded_by as string | null).filter(Boolean)),
    ] as string[];
    let emailById = new Map<string, string>();
    if (uploaderIds.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, email")
        .in("id", uploaderIds);
      emailById = new Map((profiles ?? []).map((p) => [p.id as string, p.email as string]));
    }

    const candidatesByCard = new Map<string, ReviewCandidate[]>();
    for (const c of candidates ?? []) {
      const list = candidatesByCard.get(c.card_id) ?? [];
      list.push({
        id: c.id,
        url: c.url,
        uploadedByEmail: c.uploaded_by ? emailById.get(c.uploaded_by) ?? null : null,
        createdAt: c.created_at,
      });
      candidatesByCard.set(c.card_id, list);
    }

    const rows: ReviewRow[] = [...cardById.values()].map((card) => ({
      card: {
        id: card.id,
        name: card.name,
        set_name: card.set_name,
        number: card.number,
        image_small: card.image_small,
        image_locked: !!card.image_locked,
      },
      candidates: candidatesByCard.get(card.id) ?? [],
    }));

    // Cards missing an image first (most urgent), then unlocked cards with
    // pending candidates, locked cards last.
    rows.sort((a, b) => {
      const rank = (r: ReviewRow) =>
        !r.card.image_small ? 0 : !r.card.image_locked ? 1 : 2;
      return rank(a) - rank(b) || a.card.name.localeCompare(b.card.name);
    });

    return NextResponse.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: admin decisions.
 *  { action: "set", cardId, url }  — make this the card's image and lock it.
 *  { action: "unlock", cardId }    — allow users to change the image again. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const body = (await req.json()) as {
      action?: string;
      cardId?: string;
      url?: string;
    };

    if (!body.cardId || typeof body.cardId !== "string") {
      return NextResponse.json({ error: "Missing cardId" }, { status: 400 });
    }

    if (body.action === "unlock") {
      const { error } = await admin
        .from("cards")
        .update({ image_locked: false })
        .eq("id", body.cardId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (body.action === "set") {
      const url = body.url;
      if (
        !url ||
        typeof url !== "string" ||
        url.length > 500 ||
        !url.startsWith("https://")
      ) {
        return NextResponse.json({ error: "Invalid image URL" }, { status: 400 });
      }
      const { error } = await admin
        .from("cards")
        .update({ image_small: url, image_large: url, image_locked: true })
        .eq("id", body.cardId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: remove a bad candidate. Body: { candidateId } */
export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const admin = createAdminClient();
    const { candidateId } = (await req.json()) as { candidateId?: string };
    if (!candidateId || typeof candidateId !== "string") {
      return NextResponse.json({ error: "Missing candidateId" }, { status: 400 });
    }
    const { error } = await admin
      .from("card_image_candidates")
      .delete()
      .eq("id", candidateId);
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
  console.error("admin card-images error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
