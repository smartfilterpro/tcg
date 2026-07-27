import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** GET: this deck's direct shares (owner only) — who it's shared with by
 *  name, for the sharing controls. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    const { data: deck } = await supabase
      .from("decks")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!deck) return NextResponse.json({ error: "Deck not found." }, { status: 404 });

    const { data: shares, error } = await supabase
      .from("deck_shares")
      .select("user_id")
      .eq("deck_id", id);
    if (error) return NextResponse.json({ shares: [], migrated: false });

    const ids = (shares ?? []).map((s) => s.user_id as string);
    let names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, display_name")
        .in("id", ids);
      names = new Map(
        (profiles ?? []).map((p) => [
          p.id as string,
          ((p.display_name as string | null)?.trim() || (p.email as string).split("@")[0]) as string,
        ])
      );
    }
    return NextResponse.json({
      migrated: true,
      shares: ids.map((uid) => ({ userId: uid, name: names.get(uid) ?? "Trainer" })),
    });
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

/** PATCH: sharing controls for a deck you own.
 *  Body: { shared?: boolean, shareScope?: "everyone" | "friends",
 *          addShareUserId?: string, removeShareUserId?: string } */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const body = (await req.json()) as {
      shared?: boolean;
      shareScope?: string;
      addShareUserId?: string;
      removeShareUserId?: string;
      name?: string;
      strategy?: string | null;
      cards?: Array<{ name?: string; quantity?: number; category?: string; card_id?: string | null }>;
    };
    const supabase = await createClient();

    const patch: Record<string, unknown> = {};
    if (typeof body.shared === "boolean") patch.shared = body.shared;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) {
        return NextResponse.json({ error: "Invalid deck name" }, { status: 400 });
      }
      patch.name = body.name.trim();
    }
    if (body.strategy !== undefined) {
      patch.strategy = typeof body.strategy === "string" ? body.strategy.slice(0, 10000) : null;
    }
    if (body.cards !== undefined) {
      if (
        !Array.isArray(body.cards) ||
        body.cards.length === 0 ||
        body.cards.length > 80 ||
        !body.cards.every(
          (c) => typeof c.name === "string" && typeof c.quantity === "number" && c.quantity > 0
        )
      ) {
        return NextResponse.json({ error: "Invalid card list" }, { status: 400 });
      }
      patch.cards = body.cards;
      // Editing the list means suggestions may be fulfilled — prune any
      // wishlist entry whose card is now in the deck (best-effort; the
      // suggestions column exists after migration 006).
      const inDeck = new Set(body.cards.map((c) => (c.name as string).trim().toLowerCase()));
      const { data: existing } = await supabase
        .from("decks")
        .select("suggestions")
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      const suggestions = (existing?.suggestions as Array<{ name?: string }> | null) ?? null;
      if (Array.isArray(suggestions)) {
        patch.suggestions = suggestions.filter(
          (s) => !inDeck.has((s.name ?? "").trim().toLowerCase())
        );
      }
    }
    if (body.shareScope !== undefined) {
      if (body.shareScope !== "everyone" && body.shareScope !== "friends") {
        return NextResponse.json({ error: "Invalid share scope" }, { status: 400 });
      }
      patch.shareScope = body.shareScope;
    }

    if (Object.keys(patch).length > 0) {
      const update: Record<string, unknown> = {};
      if ("shared" in patch) update.shared = patch.shared;
      if ("shareScope" in patch) update.share_scope = patch.shareScope;
      if ("name" in patch) update.name = patch.name;
      if ("strategy" in patch) update.strategy = patch.strategy;
      if ("cards" in patch) update.cards = patch.cards;
      if ("suggestions" in patch) update.suggestions = patch.suggestions;
      let { data, error } = await supabase
        .from("decks")
        .update(update)
        .eq("id", id)
        .eq("user_id", user.id)
        .select("id");
      // Pre-migration-006 fallback: retry without the suggestions column.
      if (error && /suggestions/i.test(error.message ?? "") && "suggestions" in update) {
        delete update.suggestions;
        ({ data, error } = await supabase
          .from("decks")
          .update(update)
          .eq("id", id)
          .eq("user_id", user.id)
          .select("id"));
      }
      if (error) {
        if (/share_scope/i.test(error.message ?? "")) {
          return NextResponse.json(
            { error: "Pals-only sharing needs a database update — run supabase/migrations/020_pals.sql first." },
            { status: 400 }
          );
        }
        if (/shared/i.test(error.message ?? "")) {
          return NextResponse.json(
            { error: "Deck sharing isn't set up yet — run supabase/migrations/008_sharing.sql first." },
            { status: 400 }
          );
        }
        throw error;
      }
      if (!data || data.length === 0) {
        return NextResponse.json({ error: "Deck not found." }, { status: 404 });
      }
    }

    if (body.addShareUserId && typeof body.addShareUserId === "string") {
      const { error } = await supabase
        .from("deck_shares")
        .upsert({ deck_id: id, user_id: body.addShareUserId }, { onConflict: "deck_id,user_id", ignoreDuplicates: true });
      if (error) {
        return NextResponse.json(
          { error: /deck_shares/.test(error.message ?? "") ? "Sharing with a specific pal needs supabase/migrations/020_pals.sql — run it first." : error.message },
          { status: 400 }
        );
      }
    }
    if (body.removeShareUserId && typeof body.removeShareUserId === "string") {
      const { error } = await supabase
        .from("deck_shares")
        .delete()
        .eq("deck_id", id)
        .eq("user_id", body.removeShareUserId);
      if (error) throw error;
    }

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

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const supabase = await createClient();
    const { error } = await supabase.from("decks").delete().eq("id", id).eq("user_id", user.id);
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
