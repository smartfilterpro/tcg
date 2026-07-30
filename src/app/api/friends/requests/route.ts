import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { generateFriendCode, normalizeFriendCode } from "@/lib/friendCode";

const MIGRATION_MSG =
  "Pokémon Pals needs a one-time database update — run supabase/migrations/020_pals.sql in the Supabase SQL Editor.";

const CODES_MIGRATION_MSG =
  "Friend codes need a one-time database update — run supabase/migrations/028_friend_codes.sql in the Supabase SQL Editor.";

/** Mint this user's friend code if they haven't got one.
 *
 *  Service role, because the column is revoked from `authenticated`: a code
 *  is an identifier, and a client that could set its own could squat one that
 *  had already been shared. Collisions retry rather than throw — at 32^8 the
 *  loop realistically never runs twice, but a unique index is the only thing
 *  that can actually decide, so it gets to. */
async function ensureFriendCode(userId: string, existing: string | null): Promise<string | null> {
  if (existing) return existing;
  const admin = createAdminClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateFriendCode();
    const { error } = await admin
      .from("profiles")
      .update({ friend_code: code })
      .eq("id", userId)
      .is("friend_code", null);
    if (!error) {
      // The .is() guard means a racing request may have won; read back rather
      // than assume this attempt is the code the user will be shown.
      const { data } = await admin
        .from("profiles")
        .select("friend_code")
        .eq("id", userId)
        .maybeSingle();
      return (data?.friend_code as string | null) ?? code;
    }
    if (error.code !== "23505") return null; // column missing (pre-028), or worse
  }
  return null;
}

function isMissingPals(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? "";
  return /friendships|friend_messages/.test(msg) && /(does not exist|not find|schema cache)/i.test(msg);
}

interface PalMessage {
  id: string;
  mine: boolean;
  authorName: string;
  body: string;
  created_at: string;
}

/** GET: everything the Pals UI needs — accepted pals (with message threads),
 *  incoming/outgoing requests, and members you could still ask. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const supabase = await createClient();

    const [{ data: profiles }, friendshipsRes] = await Promise.all([
      // Still every profile, but only to put names on people you are ALREADY
      // connected to — pals, and requests either way. Nothing derived from
      // this is returned for anyone you have no relationship with.
      supabase.from("profiles").select("id, email, display_name"),
      supabase
        .from("friendships")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);
    if (friendshipsRes.error) {
      if (isMissingPals(friendshipsRes.error)) {
        return NextResponse.json({ migrated: false, pals: [], incoming: [], outgoing: [] });
      }
      throw friendshipsRes.error;
    }

    const nameOf = new Map<string, string>();
    for (const p of profiles ?? []) {
      nameOf.set(
        p.id as string,
        ((p.display_name as string | null)?.trim() || (p.email as string).split("@")[0]) as string
      );
    }
    const rows = friendshipsRes.data ?? [];
    const otherId = (r: { requester: string; addressee: string }) =>
      r.requester === user.id ? r.addressee : r.requester;

    const accepted = rows.filter((r) => r.status === "accepted");
    const messagesByFriendship = new Map<string, PalMessage[]>();
    if (accepted.length > 0) {
      const { data: msgs } = await supabase
        .from("friend_messages")
        .select("id, friendship_id, sender, body, created_at")
        .in("friendship_id", accepted.map((r) => r.id))
        .order("created_at", { ascending: true })
        .limit(500);
      for (const m of msgs ?? []) {
        const list = messagesByFriendship.get(m.friendship_id as string) ?? [];
        list.push({
          id: m.id as string,
          mine: m.sender === user.id,
          authorName: nameOf.get(m.sender as string) ?? "Trainer",
          body: m.body as string,
          created_at: m.created_at as string,
        });
        messagesByFriendship.set(m.friendship_id as string, list);
      }
    }

    const pals = accepted.map((r) => ({
      id: r.id as string,
      userId: otherId(r),
      name: nameOf.get(otherId(r)) ?? "Trainer",
      since: r.updated_at as string,
      messages: (messagesByFriendship.get(r.id as string) ?? []).slice(-50),
    }));
    const incoming = rows
      .filter((r) => r.status === "pending" && r.addressee === user.id)
      .map((r) => ({ id: r.id as string, userId: r.requester as string, name: nameOf.get(r.requester as string) ?? "Trainer" }));
    const outgoing = rows
      .filter((r) => r.status === "pending" && r.requester === user.id)
      .map((r) => ({ id: r.id as string, userId: r.addressee as string, name: nameOf.get(r.addressee as string) ?? "Trainer" }));

    // No `candidates`. Browsing the membership to pick someone was the whole
    // problem: it made the directory readable by anyone with an account. You
    // reach a person now only by holding their code.
    const p = profile as (typeof profile & {
      friend_code?: string | null;
      allow_friend_requests?: boolean;
    }) | null;
    const myCode = await ensureFriendCode(user.id, p?.friend_code ?? null);

    return NextResponse.json({
      migrated: true,
      pals,
      incoming,
      outgoing,
      myCode,
      // Absent column (pre-028) reads as on, so the page works before the
      // migration is run — it just can't show a code yet.
      allowRequests: p?.allow_friend_requests !== false,
      codesReady: myCode != null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: send a pal request. Body: { code } — a friend code, nothing else.
 *
 *  Taking a user id here would leave the old browse-and-add hole open: ids
 *  appear in pal lists and shared decks, so anyone could still have picked one
 *  up and sent a request unasked. The code is the consent. */
export async function POST(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { code } = (await req.json().catch(() => ({}))) as { code?: string };
    const normalized = normalizeFriendCode(code ?? "");
    if (!normalized) {
      return NextResponse.json(
        { error: "That doesn't look like a friend code — they're 8 characters, like 7K4Q-M9XZ." },
        { status: 400 }
      );
    }

    // Reciprocal by design: if you don't accept requests, you can't send them
    // either. Otherwise switching it off would buy you a one-way channel —
    // reach everyone, be reachable by nobody — which is the shape of a
    // spammer's account, not a private one.
    const me = profile as (typeof profile & { allow_friend_requests?: boolean }) | null;
    if (me?.allow_friend_requests === false) {
      return NextResponse.json(
        {
          error:
            "Turn on “Let others add me” first — sending requests and receiving them go together.",
        },
        { status: 403 }
      );
    }

    const supabase = await createClient();
    const { data: match, error: lookupErr } = await supabase
      .rpc("find_by_friend_code", { code: normalized })
      .maybeSingle();
    if (lookupErr) {
      if (/find_by_friend_code/.test(lookupErr.message ?? "")) {
        return NextResponse.json({ error: CODES_MIGRATION_MSG }, { status: 400 });
      }
      throw lookupErr;
    }
    // One message whether the code is wrong, unused, or belongs to someone
    // who isn't accepting. Telling them apart would turn this endpoint into
    // the directory it replaced — "does this code exist?" answered 32^8 times.
    const toUserId = (match as { id?: string } | null)?.id;
    if (!toUserId) {
      return NextResponse.json(
        { error: "No trainer is using that code. Double-check it, or ask them to send you their link." },
        { status: 404 }
      );
    }
    if (toUserId === user.id) {
      return NextResponse.json({ error: "That's your own code!" }, { status: 400 });
    }

    const { data: existing, error: exErr } = await supabase
      .from("friendships")
      .select("id, status, requester")
      .or(
        `and(requester.eq.${user.id},addressee.eq.${toUserId}),and(requester.eq.${toUserId},addressee.eq.${user.id})`
      )
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      if (existing.status === "accepted") {
        return NextResponse.json({ error: "You're already pals!" }, { status: 400 });
      }
      if (existing.status === "pending") {
        return NextResponse.json(
          { error: existing.requester === user.id ? "Request already sent." : "They already asked YOU — check your incoming requests." },
          { status: 400 }
        );
      }
      // Declined earlier — re-open as a fresh request from me.
      const { data: updated, error } = await supabase
        .from("friendships")
        .update({ requester: user.id, addressee: toUserId, status: "pending", updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("id");
      if (error) throw error;
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: "Couldn't re-send the request." }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }

    const { error } = await supabase
      .from("friendships")
      .insert({ requester: user.id, addressee: toUserId });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH: answer a request ({ id, action }), or set whether you can be added
 *  at all ({ allowRequests }). */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      action?: string;
      allowRequests?: boolean;
    };
    const { id, action } = body;

    if (typeof body.allowRequests === "boolean") {
      const supabase = await createClient();
      const { error } = await supabase
        .from("profiles")
        .update({ allow_friend_requests: body.allowRequests })
        .eq("id", user.id);
      if (error) {
        if (/allow_friend_requests/.test(error.message ?? "")) {
          return NextResponse.json({ error: CODES_MIGRATION_MSG }, { status: 400 });
        }
        throw error;
      }
      return NextResponse.json({ ok: true, allowRequests: body.allowRequests });
    }

    if (!id || (action !== "accept" && action !== "decline")) {
      return NextResponse.json({ error: "Missing request or action." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("friendships")
      .update({ status: action === "accept" ? "accepted" : "declined", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("addressee", user.id)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "That request isn't waiting on you." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: cancel an outgoing request, or unfriend. Body: { id } */
export async function DELETE(req: Request) {
  try {
    await requireUser();
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.from("friendships").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Nothing was removed." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (isMissingPals(err)) {
    return NextResponse.json({ error: MIGRATION_MSG }, { status: 400 });
  }
  console.error("friends/requests error", err);
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : "Request failed";
  return NextResponse.json({ error: message }, { status: 500 });
}
