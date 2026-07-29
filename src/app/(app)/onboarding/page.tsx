"use client";

// Onboarding, from App Screens artboard 01. The mock sketches four steps but
// only defines this one — the play-style question — so this ships as a
// single skippable page rather than a progress bar over steps that don't
// exist. The choice writes play_profiles.style_notes, which the deck
// builder already reads.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SIGNUP_GRANT } from "@/lib/credits";
import { AI_NAME } from "@/lib/branding";

const STYLES = [
  { title: "Aggro", body: "Hit fast, end it by turn four. I'd rather race than plan." },
  { title: "Control", body: "Slow them down, take away their options, win late." },
  { title: "Whatever's fun", body: "I just want a deck that works with what I own." },
  { title: "Budget", body: "Nothing I'd have to buy. Only cards already in my binder." },
  { title: "Tournament", body: "Standard-legal, tuned for the current meta, no cute stuff." },
  { title: "Teaching a kid", body: "Simple lines, easy to explain, hard to misplay." },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function next(save: boolean) {
    if (save && picked) {
      setBusy(true);
      setError(null);
      const style = STYLES.find((s) => s.title === picked)!;
      try {
        const res = await fetch("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ styleNotes: `Play style: ${style.title}. ${style.body}` }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error || "Couldn't save your style");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save your style");
        setBusy(false);
        return;
      }
    }
    router.push("/");
  }

  return (
    <div className="mx-auto max-w-[860px] py-6">
      <h2 className="m-0 mb-2.5 font-display text-[28px] font-bold leading-[1.1] tracking-[-.03em] sm:text-[36px]">
        How do you like to play?
      </h2>
      <p className="m-0 mb-7 max-w-[56ch] text-[16.5px] leading-[1.6] text-brand-ink3">
        {AI_NAME} builds decks around this. You can change it any time, and you don&apos;t have to
        know the jargon — pick what sounds like you.
      </p>

      <div className="mb-7 grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-3">
        {STYLES.map((s) => {
          const sel = picked === s.title;
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => setPicked(s.title)}
              className={`flex flex-col gap-1.5 rounded-2xl border-[1.5px] p-5 text-left ${
                sel ? "border-brand-accent bg-[#F2F5FF]" : "border-brand-line bg-brand-panel"
              }`}
            >
              <span className="flex items-center justify-between">
                <span className="font-display text-[17px] font-bold tracking-[-.01em]">{s.title}</span>
                <span
                  className={`h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] ${
                    sel ? "border-brand-accent bg-brand-accent" : "border-brand-line-strong bg-transparent"
                  }`}
                />
              </span>
              <span className="text-[13.5px] leading-[1.55] text-brand-ink3">{s.body}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-brand-sunken px-[22px] py-5">
        <span className="rounded-md bg-brand-highlight px-2 py-1 font-mono text-[11px] font-medium">
          FREE PLAN
        </span>
        <span className="min-w-[260px] flex-1 text-[14.5px] leading-[1.5] text-brand-ink2">
          You have <b>{SIGNUP_GRANT} {AI_NAME} credits</b> to spend however you like — a few bulk
          scans and your first deck build. Nothing expires and no card is on file.
        </span>
      </div>

      {error && <p className="mt-3 text-sm text-brand-negative">{error}</p>}
      <div className="mt-8 flex items-center gap-3">
        <button
          className="rounded-full bg-brand-ink px-7 py-3.5 text-[15px] font-medium text-brand-canvas transition-colors hover:bg-brand-accent disabled:opacity-50"
          disabled={busy || !picked}
          onClick={() => next(true)}
        >
          {busy ? "Saving…" : "Continue"}
        </button>
        <button className="px-2 py-3.5 text-[15px] text-brand-ink3" disabled={busy} onClick={() => next(false)}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
