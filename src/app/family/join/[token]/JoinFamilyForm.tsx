"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Accept or decline, for a visitor who is already signed in. */
export default function JoinFamilyForm({
  token,
  invitedEmail,
  signedInAs,
}: {
  token: string;
  invitedEmail: string;
  signedInAs: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"joined" | "declined" | null>(null);

  // The server enforces this too — it is the rule that stops a forwarded
  // link from handing the seat to whoever opens it first. Checked here as
  // well so the mismatch is visible before anyone presses anything.
  const wrongAccount = invitedEmail.toLowerCase() !== signedInAs.toLowerCase();

  async function answer(accept: boolean) {
    setBusy(accept ? "accept" : "decline");
    setError(null);
    try {
      const res = await fetch("/api/family/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, accept }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't answer that invitation");
      setDone(json.joined ? "joined" : "declined");
      if (json.joined) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't answer that invitation");
    }
    setBusy(null);
  }

  if (done === "joined") {
    return (
      <div className="rounded-[14px] border border-brand-line bg-brand-panel p-4 text-[14px] text-brand-positive">
        You&apos;re in. Your credits now come from the family pool —{" "}
        <a href="/settings/family" className="underline">
          see the family
        </a>
        .
      </div>
    );
  }
  if (done === "declined") {
    return (
      <div className="rounded-[14px] border border-brand-line bg-brand-panel p-4 text-[14px] text-brand-ink3">
        Declined. Nothing about your account changed, and they haven&apos;t been told anything
        beyond that you said no.
      </div>
    );
  }

  if (wrongAccount) {
    return (
      <div className="rounded-[14px] border border-brand-line bg-brand-panel p-4 text-[14px] leading-[1.6] text-brand-ink2">
        This invitation was sent to <b>{invitedEmail}</b>, but you&apos;re signed in as{" "}
        <b>{signedInAs}</b>. Sign in with the invited account to answer it.
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-full bg-brand-ink px-[18px] py-2.5 text-[13.5px] font-medium text-brand-canvas disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => answer(true)}
        >
          {busy === "accept" ? "Joining…" : "Join the family"}
        </button>
        <button
          className="rounded-full border border-brand-line-strong px-[18px] py-2.5 text-[13.5px] font-medium disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => answer(false)}
        >
          {busy === "decline" ? "Declining…" : "No thanks"}
        </button>
      </div>
      {error && <p className="mb-0 mt-3 text-[13px] text-brand-negative">{error}</p>}
    </div>
  );
}
