import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { fetchAllRows } from "@/lib/fetchAll";

export interface TicketMessage {
  id: string;
  user_id: string;
  authorName: string;
  isAdmin: boolean;
  body: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  user_id: string;
  authorName: string;
  subject: string;
  status: "open" | "in_progress" | "resolved";
  created_at: string;
  updated_at: string;
  messages: TicketMessage[];
}

/** GET: my tickets — or every ticket for admins (RLS handles visibility;
 *  we scope non-admins to their own explicitly as well). */
export async function GET() {
  try {
    const { user, profile } = await requireUser();
    const supabase = await createClient();
    const isAdmin = profile?.role === "admin";

    let query = supabase
      .from("support_tickets")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (!isAdmin) query = query.eq("user_id", user.id);
    const { data: tickets, error } = await query;
    if (error) {
      if (/support_tickets/i.test(error.message ?? "")) {
        return NextResponse.json({ migrated: false, tickets: [], isAdmin, myId: user.id });
      }
      throw error;
    }

    const ids = (tickets ?? []).map((t) => t.id);
    let messages: Array<Record<string, unknown>> = [];
    if (ids.length > 0) {
      const { data } = await fetchAllRows(() =>
        supabase
          .from("support_ticket_messages")
          .select("*")
          .in("ticket_id", ids)
          .order("created_at")
          .order("id")
      );
      messages = data ?? [];
    }

    const { data: profiles } = await supabase.from("profiles").select("*");
    const profById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
    const nameOf = (id: string) => {
      const p = profById.get(id);
      return (p?.display_name || p?.email || "A member") as string;
    };

    const byTicket = new Map<string, TicketMessage[]>();
    for (const m of messages) {
      const list = byTicket.get(m.ticket_id as string) ?? [];
      list.push({
        id: m.id as string,
        user_id: m.user_id as string,
        authorName: nameOf(m.user_id as string),
        isAdmin: profById.get(m.user_id as string)?.role === "admin",
        body: m.body as string,
        created_at: m.created_at as string,
      });
      byTicket.set(m.ticket_id as string, list);
    }

    const result: Ticket[] = (tickets ?? []).map((t) => ({
      id: t.id,
      user_id: t.user_id,
      authorName: nameOf(t.user_id),
      subject: t.subject,
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
      messages: byTicket.get(t.id) ?? [],
    }));

    return NextResponse.json({ migrated: true, tickets: result, isAdmin, myId: user.id });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST: open a ticket. Body: { subject, body } */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { subject, body } = (await req.json()) as { subject?: string; body?: string };
    const subj = subject?.trim() ?? "";
    const text = body?.trim() ?? "";
    if (!subj || subj.length > 200 || !text || text.length > 4000) {
      return NextResponse.json(
        { error: "Give the ticket a subject (max 200 chars) and a description (max 4000)." },
        { status: 400 }
      );
    }
    const supabase = await createClient();
    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .insert({ user_id: user.id, subject: subj })
      .select()
      .single();
    if (error) {
      if (/support_tickets/i.test(error.message ?? "")) {
        return NextResponse.json(
          { error: "Support isn't set up yet — run supabase/migrations/010_support_usernames.sql first." },
          { status: 400 }
        );
      }
      throw error;
    }
    const { error: msgErr } = await supabase
      .from("support_ticket_messages")
      .insert({ ticket_id: ticket.id, user_id: user.id, body: text });
    if (msgErr) throw msgErr;
    return NextResponse.json({ ticket });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("support error", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed" },
    { status: 500 }
  );
}
