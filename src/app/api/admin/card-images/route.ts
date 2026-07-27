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

/** Build ReviewRows from card records + their candidate rows. */
async function toRows(
  admin: ReturnType<typeof createAdminClient>,
  cards: Array<Record<string, unknown>>,
  candidates: Array<Record<string, unknown>>
): Promise<ReviewRow[]> {
  const uploaderIds = [
    ...new Set(candidates.map((c) => c.uploaded_by as string | null).filter(Boolean)),
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
  for (const c of candidates) {
    const list = candidatesByCard.get(c.card_id as string) ?? [];
    list.push({
      id: c.id as string,
      url: c.url as string,
      uploadedByEmail: c.uploaded_by ? emailById.get(c.uploaded_by as string) ?? null : null,
      createdAt: c.created_at as string,
    });
    candidatesByCard.set(c.card_id as string, list);
  }
  return cards.map((card) => ({
    card: {
      id: card.id as string,
      name: card.name as string,
      set_name: card.set_name as string | null,
      number: card.number as string | null,
      image_small: card.image_small as string | null,
      image_locked: !!card.image_locked,
    },
    candidates: candidatesByCard.get(card.id as string) ?? [],
  }));
}

/** GET: cards that need image review (admin only) — every card that has
 *  submitted photo candidates, plus cards with no image at all.
 *  With ?q=, instead searches the whole shared card database by name/number
 *  so the admin can fix ANY card's image, not just flagged ones. */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const admin = createAdminClient();

    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (q) {
      // Strip characters that would break the .or() filter syntax
      const clean = q.replace(/[%_,()]/g, " ").trim();
      if (!clean) return NextResponse.json({ rows: [] });
      const { data: found, error } = await admin
        .from("cards")
        .select("*")
        .or(`name.ilike.%${clean}%,number.ilike.%${clean}%`)
        .order("name")
        .limit(30);
      if (error) throw error;

      const ids = (found ?? []).map((c) => c.id as string);
      let cands: Array<Record<string, unknown>> = [];
      if (ids.length > 0) {
        const { data, error: cErr } = await admin
          .from("card_image_candidates")
          .select("id, card_id, url, uploaded_by, created_at")
          .in("card_id", ids)
          .order("created_at", { ascending: false })
          .limit(300);
        if (cErr) console.error("card_image_candidates unavailable", cErr.message);
        else cands = data ?? [];
      }
      const rows = await toRows(admin, found ?? [], cands);
      return NextResponse.json({ rows });
    }

    const [{ data: candidates, error: candErr }, { data: missing, error: missErr }] =
      await Promise.all([
        admin
          .from("card_image_candidates")
          .select("id, card_id, url, uploaded_by, created_at")
          .order("created_at", { ascending: false })
          .limit(1000),
        // select("*") — image_locked only exists after migration 007
        admin
          .from("cards")
          .select("*")
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
        .select("*")
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
      const { data, error } = await admin
        .from("cards")
        .update({ image_locked: false })
        .eq("id", body.cardId)
        .select("id");
      if (error) {
        if (/image_locked/i.test(error.message ?? "")) {
          return NextResponse.json(
            { error: "Locking isn't set up yet — run supabase/migrations/007_image_curation.sql first." },
            { status: 400 }
          );
        }
        throw error;
      }
      if (!data || data.length === 0) {
        return NextResponse.json({ error: "Card not found." }, { status: 404 });
      }
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
      // .select() so a zero-row match (bad card id) is a visible error
      // instead of a silent no-op that leaves the old photo in place.
      let warning: string | undefined;
      let { data, error } = await admin
        .from("cards")
        .update({ image_small: url, image_large: url, image_locked: true })
        .eq("id", body.cardId)
        .select("id, image_small");
      // Pre-migration-007 database: set the image anyway, just without the lock.
      if (error && /image_locked/i.test(error.message ?? "")) {
        ({ data, error } = await admin
          .from("cards")
          .update({ image_small: url, image_large: url })
          .eq("id", body.cardId)
          .select("id, image_small"));
        warning =
          "Image updated, but it is NOT locked — run supabase/migrations/007_image_curation.sql to enable admin locking.";
      }
      if (error) throw error;
      if (!data || data.length === 0) {
        return NextResponse.json(
          { error: "Card not found — the image was not changed." },
          { status: 404 }
        );
      }
      // The decision is made — clear this card's pending candidates so it
      // drops off the review list. New member submissions will re-surface
      // it. Best-effort (table exists after migration 007).
      await admin.from("card_image_candidates").delete().eq("card_id", body.cardId);
      return NextResponse.json({ ok: true, imageUrl: url, warning });
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
  // Supabase errors are plain objects, not Error instances — surface their
  // message too instead of a useless generic "Request failed".
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? ((err as { message: string }).message)
        : "Request failed";
  return NextResponse.json({ error: message }, { status: 500 });
}
