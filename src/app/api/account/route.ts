import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, AuthError } from "@/lib/auth";
import { nameAllowed } from "@/lib/moderation";

/** GET: everything the account page shows about you. */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const p = profile as (typeof profile & {
      friend_code?: string | null;
      allow_friend_requests?: boolean;
      plan?: string;
      plan_expires_at?: string | null;
      stripe_subscription?: string | null;
    }) | null;

    const admin = createAdminClient();
    // Counts, not contents: the page says how much there is to lose before
    // you delete it, which is the one number that makes that button honest.
    const [cards, decks, grades] = await Promise.all([
      admin.from("collection_items").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      admin.from("decks").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      admin.from("grade_reports").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);

    // Owning a family group with other people in it blocks deletion — the
    // page needs to know before it offers the button.
    const { data: group } = await admin
      .from("family_groups")
      .select("id")
      .eq("owner_user", user.id)
      .maybeSingle();
    let familyMembers = 0;
    if (group) {
      const { count } = await admin
        .from("family_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", group.id);
      familyMembers = count ?? 0;
    }

    return NextResponse.json({
      email: user.email ?? p?.email ?? "",
      displayName: p?.display_name ?? "",
      role: p?.role ?? "member",
      plan: p?.plan ?? "free",
      planExpiresAt: p?.plan_expires_at ?? null,
      hasSubscription: !!p?.stripe_subscription,
      createdAt: p?.created_at ?? null,
      shareCollection: p?.share_collection === true,
      allowFriendRequests: p?.allow_friend_requests !== false,
      friendCode: p?.friend_code ?? null,
      counts: {
        cards: cards.count ?? 0,
        decks: decks.count ?? 0,
        grades: grades.count ?? 0,
      },
      ownsFamilyWith: group ? familyMembers : 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE: close the account for good. Body: { confirmEmail }
 *
 *  Deliberately awkward. Typing the address is the confirmation — a dialog
 *  people click through isn't one — and two situations refuse outright rather
 *  than leave a mess behind: a live Stripe subscription would keep billing a
 *  customer who no longer exists, and deleting a family owner would strand
 *  everyone in their group. */
export async function DELETE(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { confirmEmail } = (await req.json().catch(() => ({}))) as { confirmEmail?: string };
    const email = (user.email ?? "").trim().toLowerCase();
    if (!email || (confirmEmail ?? "").trim().toLowerCase() !== email) {
      return NextResponse.json(
        { error: "Type your email address exactly to confirm." },
        { status: 400 }
      );
    }

    const p = profile as (typeof profile & { stripe_subscription?: string | null }) | null;
    if (p?.stripe_subscription) {
      return NextResponse.json(
        {
          error:
            "Cancel your subscription first, from Billing. Deleting the account while it's live " +
            "would leave Stripe billing a customer who no longer exists.",
        },
        { status: 409 }
      );
    }

    const admin = createAdminClient();
    const { data: group } = await admin
      .from("family_groups")
      .select("id")
      .eq("owner_user", user.id)
      .maybeSingle();
    if (group) {
      const { count } = await admin
        .from("family_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", group.id)
        .neq("user_id", user.id);
      if ((count ?? 0) > 0) {
        return NextResponse.json(
          {
            error:
              `Your family still has ${count} other profile${count === 1 ? "" : "s"}. ` +
              "Remove them in Family settings first, so nobody is left without a plan.",
          },
          { status: 409 }
        );
      }
    }

    // Everything owned by the profile is FK'd to it with on delete cascade,
    // and the profile is FK'd to the auth user — so removing the auth user
    // takes the collection, decks, grades, ledger and memberships with it.
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH: set your username (display_name). Body: { displayName } */
export async function PATCH(req: Request) {
  try {
    const { user } = await requireUser();
    const { displayName } = (await req.json()) as { displayName?: string };
    const name = displayName?.trim() ?? "";
    if (name.length < 2 || name.length > 30 || !/^[\p{L}\p{N} ._'-]+$/u.test(name)) {
      return NextResponse.json(
        { error: "Username must be 2-30 characters (letters, numbers, spaces, . _ ' -)." },
        { status: 400 }
      );
    }
    // Other members are forced to read this name everywhere; screen it.
    const verdict = await nameAllowed("display name", name);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }
    const supabase = await createClient();

    // Soft uniqueness: avoid two members with the same visible name
    const { data: clash } = await supabase
      .from("profiles")
      .select("id")
      .ilike("display_name", name)
      .neq("id", user.id)
      .limit(1)
      .maybeSingle();
    if (clash) {
      return NextResponse.json(
        { error: "That username is already taken — try another." },
        { status: 409 }
      );
    }

    const { error } = await supabase
      .from("profiles")
      .update({ display_name: name })
      .eq("id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true, displayName: name });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
