import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { isFreeTier } from "@/lib/credits";
import type { Deck } from "@/lib/types";
import { errorJson } from "@/lib/apiError";

export interface Friend {
  id: string;
  name: string;
  cardCount: number;
}

export interface SharedDeck extends Deck {
  ownerName: string;
}

/** GET: members sharing their collection, decks shared with the group,
 *  and whether the current user is sharing. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const supabase = await createClient();
    // Deck sharing (both directions) is a paid feature. This feed is the
    // one source of shared decks for the Friends page AND the battle
    // borrow picker, so emptying it here closes both surfaces. A product
    // gate at the API, like the collection-export gate — RLS itself still
    // permits the rows, which matters only to someone driving the database
    // by hand.
    const free = await isFreeTier(user, profile);

    // Two narrow reads instead of every column of every member: my own row,
    // and the members actually sharing. The filter moving server-side is
    // what stops this route scaling with total signups. share_collection
    // only exists after migration 008 — a missing column fails the query,
    // which is the "not migrated" answer.
    const [meRes, sharersRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, display_name, email, share_collection")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("id, display_name, email")
        .eq("share_collection", true)
        .neq("id", user.id)
        .order("created_at"),
    ]);
    const profErr = meRes.error ?? sharersRes.error;
    if (profErr && !/share_collection/i.test(profErr.message ?? "")) throw profErr;
    const migrated = !profErr && meRes.data != null;
    const me = (meRes.data ?? null) as {
      share_collection?: boolean;
      display_name?: string | null;
      email?: string | null;
    } | null;
    const sharers = migrated ? (sharersRes.data ?? []) : [];

    const friends: Friend[] = await Promise.all(
      sharers.map(async (p) => {
        const { count } = await supabase
          .from("collection_items")
          .select("id", { count: "exact", head: true })
          .eq("user_id", p.id);
        return {
          id: p.id as string,
          name: (p.display_name || p.email) as string,
          cardCount: count ?? 0,
        };
      })
    );

    let sharedDecks: SharedDeck[] = [];
    if (migrated && !free) {
      // No .eq("shared") filter: row-level security decides what's visible —
      // everyone-scope decks, pals-only decks (if we're pals), and decks
      // shared directly with this user (migration 020).
      const { data: decks } = await supabase
        .from("decks")
        .select("*")
        .neq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      const ownerIds = [...new Set((decks ?? []).map((d) => d.user_id as string))];
      const { data: owners } = ownerIds.length
        ? await supabase.from("profiles").select("id, display_name, email").in("id", ownerIds)
        : { data: [] };
      const nameById = new Map(
        (owners ?? []).map((p) => [p.id as string, (p.display_name || p.email) as string])
      );
      sharedDecks = ((decks ?? []) as Deck[]).map((d) => ({
        ...d,
        ownerName: nameById.get(d.user_id) ?? "A member",
      }));
    }

    // Own card count, for the "You: name · N cards" badge on the share row.
    const { count: myCardCount } = await supabase
      .from("collection_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    return NextResponse.json({
      migrated,
      sharing: me?.share_collection === true,
      myName: (me?.display_name || me?.email || "") as string,
      myCardCount: myCardCount ?? 0,
      friends,
      sharedDecks,
      // The Friends page shows an upgrade note instead of the deck list.
      decksLocked: free,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: toggle sharing my collection. Body: { share: boolean } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { share } = (await req.json()) as { share?: boolean };
    if (typeof share !== "boolean") {
      return NextResponse.json({ error: "Missing share flag" }, { status: 400 });
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from("profiles")
      .update({ share_collection: share })
      .eq("id", user.id);
    if (error) {
      if (/share_collection/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Sharing isn't set up yet — run supabase/migrations/008_sharing.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true, sharing: share });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("friends error", err);
  return errorJson(err, "Request failed");
}
