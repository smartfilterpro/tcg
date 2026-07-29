"use client";

import { useEffect, useState } from "react";

interface TicketMessage {
  id: string;
  user_id: string;
  authorName: string;
  isAdmin: boolean;
  body: string;
  created_at: string;
}

interface Ticket {
  id: string;
  user_id: string;
  authorName: string;
  subject: string;
  status: "open" | "in_progress" | "resolved";
  created_at: string;
  updated_at: string;
  messages: TicketMessage[];
}

const STATUS_LABELS: Record<Ticket["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

function statusChip(status: Ticket["status"]) {
  return status === "open"
    ? "bg-red-50 text-red-700"
    : status === "in_progress"
      ? "bg-yellow-50 text-yellow-800"
      : "bg-green-50 text-green-700";
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reply, setReply] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/support");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setMigrated(json.migrated !== false);
      setTickets(json.tickets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't create the ticket");
      setComposing(false);
      setSubject("");
      setBody("");
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't create the ticket");
    }
    setBusy(false);
  }

  async function sendReply(t: Ticket) {
    if (!reply.trim() || busy) return;
    setBusy(true);
    const res = await fetch(`/api/support/${t.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: reply }),
    });
    if (res.ok) {
      setReply("");
      await load();
    }
    setBusy(false);
  }

  async function setStatus(t: Ticket, status: Ticket["status"]) {
    await fetch(`/api/support/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Help &amp; Support</h1>
          <p className="text-sm text-slate-500">
            Something broken or confusing? Open a ticket and the admin will take a look. You
            can also review the{" "}
            <a href="/terms" className="text-poke-blue hover:underline">
              Terms of Service
            </a>{" "}
            any time.
          </p>
        </div>
        {!composing && (
          <button className="btn-primary shrink-0" onClick={() => setComposing(true)}>
            + New ticket
          </button>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {!migrated && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          Support needs a one-time database update — ask the admin to run{" "}
          <code>supabase/migrations/010_support_usernames.sql</code>.
        </div>
      )}

      {composing && (
        <form onSubmit={submit} className="card-panel space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Subject</label>
            <input
              className="input"
              required
              maxLength={200}
              placeholder="e.g. A card scanned as the wrong set"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              What happened?
            </label>
            <textarea
              className="input"
              rows={4}
              required
              maxLength={4000}
              placeholder="What did you do, what did you expect, and what happened instead? Include the card/page if relevant."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy}>
              {busy ? "Sending…" : "Open ticket"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">My tickets ({tickets.length})</h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-slate-400">No tickets yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {tickets.map((t) => (
              <li key={t.id} className="py-3">
                <button
                  className="flex w-full items-center justify-between gap-2 text-left"
                  onClick={() => {
                    setExpanded(expanded === t.id ? null : t.id);
                    setReply("");
                  }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.subject}</div>
                    <div className="text-xs text-slate-400">
                      updated {new Date(t.updated_at).toLocaleDateString()} ·{" "}
                      {t.messages.length} message{t.messages.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span className={`chip shrink-0 ${statusChip(t.status)}`}>
                    {STATUS_LABELS[t.status]}
                  </span>
                </button>
                {expanded === t.id && (
                  <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
                    {t.messages.map((m) => (
                      <div
                        key={m.id}
                        className={`rounded-lg p-2 text-sm ${
                          m.isAdmin ? "mr-6 bg-poke-blue/10" : "ml-0 bg-slate-50"
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-500">
                          {m.authorName}
                          {m.isAdmin && " (admin)"} ·{" "}
                          {new Date(m.created_at).toLocaleString()}
                        </div>
                        <p className="whitespace-pre-wrap text-slate-800">{m.body}</p>
                      </div>
                    ))}
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        sendReply(t);
                      }}
                    >
                      <input
                        className="input text-sm"
                        placeholder="Add more details…"
                        value={reply}
                        maxLength={4000}
                        onChange={(e) => setReply(e.target.value)}
                      />
                      <button className="btn-secondary shrink-0 text-sm" disabled={busy}>
                        Reply
                      </button>
                    </form>
                    {t.status !== "resolved" ? (
                      <button
                        className="text-xs text-green-700 hover:underline"
                        onClick={() => setStatus(t, "resolved")}
                      >
                        ✓ Mark as resolved
                      </button>
                    ) : (
                      <button
                        className="text-xs text-slate-500 hover:underline"
                        onClick={() => setStatus(t, "open")}
                      >
                        Reopen
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
