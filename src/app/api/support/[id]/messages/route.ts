import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** POST: reply on a ticket (owner or admin — enforced by RLS). */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const { body } = (await req.json()) as { body?: string };
    const text = body?.trim() ?? "";
    if (!text || text.length > 4000) {
      return NextResponse.json({ error: "Write a reply (max 4000 chars)." }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("support_ticket_messages")
      .insert({ ticket_id: id, user_id: user.id, body: text })
      .select()
      .single();
    if (error) throw error;
    // Bump the ticket so it sorts to the top for whoever needs to respond
    await supabase
      .from("support_tickets")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ message: data });
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
