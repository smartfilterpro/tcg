import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { boardEnabled, BOARD_OFF_ERROR, tradingOff, TRADING_OFF_ERROR } from "@/lib/tradeBoard";

/** Lightweight card reference attached to a post, for showing pictures. */
export interface PostCardRef {
  id: string;
  name: string;
  image: string | null;
  set_name: string | null;
  number: string | null;
  qty?: number;
}

export interface TradePostComment {
  id: string;
  post_id: string;
  user_id: string;
  authorName: string;
  body: string;
  created_at: string;
}

export interface TradePost {
  id: string;
  user_id: string;
  authorName: string;
  looking_for: string;
  offering: string;
  looking_for_cards: PostCardRef[];
  offering_cards: PostCardRef[];
  status: "open" | "closed";
  created_at: string;
  comments: TradePostComment[];
}

function sanitizeCards(input: unknown, cap = 10): PostCardRef[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((c) => c && typeof c.id === "string" && typeof c.name === "string")
    .slice(0, cap)
    .map((c) => ({
      id: String(c.id).slice(0, 100),
      name: String(c.name).slice(0, 200),
      image: typeof c.image === "string" ? c.image.slice(0, 500) : null,
      set_name: typeof c.set_name === "string" ? c.set_name.slice(0, 200) : null,
      number: typeof c.number === "string" ? c.number.slice(0, 40) : null,
      qty:
        Number.isInteger(c.qty) && c.qty > 1 ? Math.min(99, c.qty as number) : undefined,
    }));
}

/** GET: the trade board — all posts, newest first, with comments. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    // A profile whose board is off gets the lock screen, not a stripped-down
    // board: returning the posts and hiding them client-side would leave the
    // whole board sitting in the page source.
    if (!boardEnabled(profile)) {
      return NextResponse.json({
        migrated: true,
        posts: [],
        myId: user.id,
        boardEnabled: false,
        // Moderators remove content too — the RLS policy says so (043),
      // and a button the server would honour should be visible.
      isAdmin: profile?.role === "admin" || profile?.role === "moderator",
      });
    }
    const supabase = await createClient();

    const { data: posts, error } = await supabase
      .from("trade_posts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      // Table missing = migration 009 not run yet
      if (/trade_posts/i.test(error.message ?? "")) {
        return NextResponse.json({ migrated: false, posts: [], myId: user.id });
      }
      throw error;
    }

    const postIds = (posts ?? []).map((p) => p.id);
    let comments: Array<Record<string, unknown>> = [];
    if (postIds.length > 0) {
      const { data } = await supabase
        .from("trade_post_comments")
        .select("*")
        .in("post_id", postIds)
        .order("created_at")
        .limit(1000);
      comments = data ?? [];
    }

    const { data: profiles } = await supabase.from("profiles").select("*");
    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id as string, (p.display_name || p.email) as string])
    );

    const byPost = new Map<string, TradePostComment[]>();
    for (const c of comments) {
      const list = byPost.get(c.post_id as string) ?? [];
      list.push({
        id: c.id as string,
        post_id: c.post_id as string,
        user_id: c.user_id as string,
        authorName: nameById.get(c.user_id as string) ?? "A member",
        body: c.body as string,
        created_at: c.created_at as string,
      });
      byPost.set(c.post_id as string, list);
    }

    const result: TradePost[] = (posts ?? []).map((p) => ({
      id: p.id,
      user_id: p.user_id,
      authorName: nameById.get(p.user_id) ?? "A member",
      looking_for: p.looking_for,
      offering: p.offering,
      looking_for_cards: sanitizeCards(p.looking_for_cards),
      offering_cards: sanitizeCards(p.offering_cards),
      status: p.status,
      created_at: p.created_at,
      comments: byPost.get(p.id) ?? [],
    }));

    return NextResponse.json({
      migrated: true,
      posts: result,
      myId: user.id,
      boardEnabled: true,
      // The Terms promise the administrator may remove any User Content;
      // this is the flag that puts the button where that promise lives.
      // Moderators remove content too — the RLS policy says so (043),
      // and a button the server would honour should be visible.
      isAdmin: profile?.role === "admin" || profile?.role === "moderator",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: create a trade post.
 *  Body: { lookingFor, offering, lookingForCards?, offeringCards? } */
export async function POST(req: Request) {
  try {
    // Trading is paused product-wide (lib/features). Writes stop here;
    // reads and admin removal still work, so nothing is stranded.
    if (tradingOff()) {
      return NextResponse.json({ error: TRADING_OFF_ERROR }, { status: 403 });
    }
    const { user, profile } = await requireUser();
    if (!boardEnabled(profile)) {
      return NextResponse.json({ error: BOARD_OFF_ERROR }, { status: 403 });
    }
    if ((profile as { can_post_trades?: boolean | null } | null)?.can_post_trades === false) {
      return NextResponse.json(
        { error: "The admin has turned off trade posting for this account." },
        { status: 403 }
      );
    }
    const body = (await req.json()) as {
      lookingFor?: string;
      offering?: string;
      lookingForCards?: unknown;
      offeringCards?: unknown;
    };
    const lookingFor = body.lookingFor?.trim() ?? "";
    const offering = body.offering?.trim() ?? "";
    if (!lookingFor || !offering || lookingFor.length > 1000 || offering.length > 1000) {
      return NextResponse.json(
        { error: "Say what you're looking for and what you're offering (max 1000 chars each)." },
        { status: 400 }
      );
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("trade_posts")
      .insert({
        user_id: user.id,
        looking_for: lookingFor,
        offering,
        looking_for_cards: sanitizeCards(body.lookingForCards),
        offering_cards: sanitizeCards(body.offeringCards),
      })
      .select()
      .single();
    if (error) {
      if (/trade_posts/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "The trade board isn't set up yet — run supabase/migrations/009_trade_board.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ post: data });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("market error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
