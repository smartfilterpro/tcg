"use client";

import { useEffect, useState } from "react";
import type { Profile } from "@/lib/types";

interface Invite {
  id: string;
  email: string;
  created_at: string;
}

interface UserUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costUsd30d: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function AdminPage() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [usage, setUsage] = useState<Record<string, UserUsage>>({});
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/admin/users");
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed to load (are you an admin?)");
    } else {
      setUsers(json.users);
      setInvites(json.invites);
      setUsage(json.usage ?? {});
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error);
    } else {
      setMessage(
        `${email} is invited! Send them the app link — they can create their account on the login page.`
      );
      setEmail("");
      load();
    }
  }

  async function resetPassword(id: string, userEmail: string) {
    const password = prompt(
      `Set a new password for ${userEmail} (8+ characters).\nShare it with them privately — they can keep using it or you can change it again later.`
    );
    if (!password) return;
    const res = await fetch(`/api/admin/users/${id}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    else setMessage(`Password updated for ${userEmail}.`);
  }

  async function revoke(inviteEmail: string) {
    await fetch("/api/admin/invite", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    load();
  }

  async function removeUser(id: string, userEmail: string) {
    if (!confirm(`Remove ${userEmail}? Their collection and decks will be deleted.`)) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) setError(json.error);
    load();
  }

  if (loading) return <p className="text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-sm text-slate-500">Invite friends and manage who has access.</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</div>}

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Invite a friend</h2>
        <p className="mb-2 text-xs text-slate-500">
          Adds their email to the allow-list. Then just send them the app link — they&apos;ll
          create their own password on the login page.
        </p>
        <form onSubmit={invite} className="flex gap-2">
          <input
            type="email"
            required
            className="input"
            placeholder="friend@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn-primary shrink-0">Send invite</button>
        </form>
      </div>

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Members ({users.length})</h2>
        <p className="mb-1 text-xs text-slate-400">
          AI usage = scans, deck builds, and coach questions. Costs are estimates at standard
          API rates.
        </p>
        <ul className="divide-y divide-slate-100">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm font-medium">{u.display_name || u.email}</div>
                <div className="text-xs text-slate-400">
                  {u.email} · joined {new Date(u.created_at).toLocaleDateString()}
                </div>
                <div className="text-xs text-slate-500">
                  {usage[u.id] ? (
                    <>
                      🤖 {usage[u.id].calls} AI call{usage[u.id].calls === 1 ? "" : "s"} ·{" "}
                      {formatTokens(usage[u.id].inputTokens + usage[u.id].outputTokens)} tokens ·{" "}
                      <span className="font-semibold">
                        ~${usage[u.id].costUsd.toFixed(2)} all-time
                      </span>{" "}
                      · ~${usage[u.id].costUsd30d.toFixed(2)} last 30d
                    </>
                  ) : (
                    "🤖 No AI usage yet"
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`chip ${
                    u.role === "admin" ? "bg-poke-gold/30 text-yellow-900" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {u.role}
                </span>
                <button
                  className="btn text-xs text-slate-500 hover:bg-slate-100"
                  onClick={() => resetPassword(u.id, u.email)}
                >
                  Reset password
                </button>
                {u.role !== "admin" && (
                  <button
                    className="btn text-xs text-red-600 hover:bg-red-50"
                    onClick={() => removeUser(u.id, u.email)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card-panel p-4">
        <h2 className="mb-2 font-semibold">Pending invites ({invites.length})</h2>
        {invites.length === 0 ? (
          <p className="text-sm text-slate-400">No pending invites.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-2">
                <div className="text-sm">{inv.email}</div>
                <button
                  className="btn text-xs text-red-600 hover:bg-red-50"
                  onClick={() => revoke(inv.email)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
