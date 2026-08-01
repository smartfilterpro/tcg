import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { BOOST_PACKS } from "@/lib/boosts";
import { ensureCustomer, stripeEnabled, stripeFetch, StripeError } from "@/lib/stripe";
import { requestOrigin } from "@/lib/requestOrigin";

export const maxDuration = 30;

// A kid asks for a boost; a parent pays for it.
//
// The kid never touches Stripe. Approving is what creates the checkout, and
// it runs under the PARENT's Stripe customer — their card, their receipt —
// while the credits land in the family pool the kid already spends from.

async function familyOf(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data } = await admin
    .from("family_members")
    .select("group_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  return data as { group_id: string; role: "parent" | "kid" } | null;
}

/** GET: the family's boost requests, newest first. */
export async function GET() {
  try {
    const { user } = await requireUser();
    const admin = createAdminClient();
    const me = await familyOf(admin, user.id);
    if (!me) return NextResponse.json({ requests: [], role: null });

    const { data, error } = await admin
      .from("boost_requests")
      .select("id, pack, note, status, requested_by, created_at, decided_at")
      .eq("group_id", me.group_id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      return NextResponse.json(
        {
          requests: [],
          role: me.role,
          migrated: !/boost_requests/.test(error.message),
        },
        { status: 200 }
      );
    }

    const ids = [...new Set((data ?? []).map((r) => r.requested_by as string))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, email, display_name")
        .in("id", ids);
      for (const p of profiles ?? []) {
        names.set(
          p.id as string,
          ((p.display_name as string | null)?.trim() || (p.email as string).split("@")[0]) as string
        );
      }
    }
    return NextResponse.json({
      role: me.role,
      migrated: true,
      requests: (data ?? []).map((r) => {
        const spec = BOOST_PACKS[r.pack as string];
        return {
          id: r.id,
          pack: r.pack,
          credits: spec?.credits ?? 0,
          price: spec ? `$${(spec.cents / 100).toFixed(0)}` : "—",
          note: r.note,
          status: r.status,
          mine: r.requested_by === user.id,
          who: names.get(r.requested_by as string) ?? "A member",
          created_at: r.created_at,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { pack, note? } — a kid asks. Parents don't need this route; they
 *  buy directly. */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { pack, note } = (await req.json().catch(() => ({}))) as {
      pack?: string;
      note?: string;
    };
    if (!pack || !BOOST_PACKS[pack]) {
      return NextResponse.json(
        { error: `Pick a boost pack: ${Object.keys(BOOST_PACKS).join(", ")}.` },
        { status: 400 }
      );
    }
    const admin = createAdminClient();
    const me = await familyOf(admin, user.id);
    if (!me) {
      return NextResponse.json(
        { error: "You're not in a family group — buy a boost directly instead." },
        { status: 400 }
      );
    }

    const { error } = await admin.from("boost_requests").insert({
      group_id: me.group_id,
      requested_by: user.id,
      pack,
      note: (note ?? "").slice(0, 300) || null,
    });
    if (error) {
      // 23505: the one-pending-per-kid index. Not an error worth alarming a
      // child with — they asked twice, which is what children do.
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "You've already asked — a parent just needs to say yes." },
          { status: 409 }
        );
      }
      if (/boost_requests/.test(error.message)) {
        return NextResponse.json(
          { error: "Boost requests need a database update — run supabase/migrations/040_boost_requests.sql." },
          { status: 400 }
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH { id, action: "approve" | "decline" | "cancel" }
 *  approve → a Stripe checkout url for the PARENT to pay. */
export async function PATCH(req: Request) {
  try {
    const { user, profile } = await requireUser();
    const { id, action } = (await req.json().catch(() => ({}))) as {
      id?: string;
      action?: string;
    };
    if (!id || !["approve", "decline", "cancel"].includes(action ?? "")) {
      return NextResponse.json({ error: "Need id and action." }, { status: 400 });
    }
    const admin = createAdminClient();
    const me = await familyOf(admin, user.id);
    if (!me) return NextResponse.json({ error: "Not in a family group." }, { status: 403 });

    const { data: reqRow } = await admin
      .from("boost_requests")
      .select("id, group_id, pack, requested_by, status")
      .eq("id", id)
      .maybeSingle();
    if (!reqRow || reqRow.group_id !== me.group_id) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }
    if (reqRow.status !== "pending") {
      return NextResponse.json({ error: `That request is already ${reqRow.status}.` }, { status: 409 });
    }

    // A kid may withdraw their own ask and nothing else. Deciding is a
    // parent's job, and a kid who could approve their own request would
    // make the whole flow theatre.
    if (action === "cancel") {
      if (reqRow.requested_by !== user.id && me.role !== "parent") {
        return NextResponse.json({ error: "That isn't your request." }, { status: 403 });
      }
      await admin
        .from("boost_requests")
        .update({ status: "cancelled", decided_by: user.id, decided_at: new Date().toISOString() })
        .eq("id", id);
      return NextResponse.json({ ok: true });
    }
    if (me.role !== "parent") {
      return NextResponse.json({ error: "Only a parent can decide this." }, { status: 403 });
    }
    if (action === "decline") {
      await admin
        .from("boost_requests")
        .update({ status: "declined", decided_by: user.id, decided_at: new Date().toISOString() })
        .eq("id", id);
      return NextResponse.json({ ok: true });
    }

    // Approve: the parent pays.
    if (!stripeEnabled()) {
      return NextResponse.json({ error: "Payments aren't configured." }, { status: 503 });
    }
    const spec = BOOST_PACKS[reqRow.pack as string];
    if (!spec) {
      return NextResponse.json({ error: "That pack no longer exists." }, { status: 400 });
    }
    const customer = await ensureCustomer(
      admin,
      user.id,
      user.email ?? null,
      (profile?.stripe_customer as string | null) ?? null
    );
    const origin = requestOrigin(req);
    const session = await stripeFetch("/checkout/sessions", {
      params: {
        mode: "payment",
        customer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: spec.cents,
              product_data: { name: `TrainerDeck Boost — ${spec.label}` },
            },
          },
        ],
        success_url: `${origin}/settings/family?boost=1`,
        cancel_url: `${origin}/settings/family?boost=cancelled`,
        // Credited to the PARENT, which is what puts the credits in the
        // family pool — the pool lives on the group owner's ledger and the
        // kid spends from it already.
        metadata: {
          user_id: user.id,
          kind: "boost",
          pack: reqRow.pack as string,
          credits: String(spec.credits),
        },
      },
    });

    const { data: purchase } = await admin
      .from("boost_purchases")
      .insert({
        user_id: user.id,
        pack: reqRow.pack,
        credits: spec.credits,
        amount_cents: spec.cents,
        status: "pending",
        stripe_checkout_session: session.id as string,
      })
      .select("id")
      .single();

    // Marked approved when checkout OPENS, not when it completes: the
    // webhook credits the pool either way, and leaving it pending would
    // invite a second approval and a second charge. An abandoned checkout
    // costs nothing and the kid can ask again.
    await admin
      .from("boost_requests")
      .update({
        status: "approved",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        purchase_id: purchase?.id ?? null,
      })
      .eq("id", id);

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof StripeError) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
