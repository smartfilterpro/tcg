"use client";

// The two-tab auth card + "what happens next" rail from the mock's auth view.
// /signup and /login are separate routes sharing this shell, so the tabs are
// links and the browser back button behaves.

import Link from "next/link";

const NEXT_STEPS = [
  {
    n: "01",
    title: "Photograph a stack",
    body: "Lay out up to 20 cards, one photo. We read every name and collector number at once.",
  },
  {
    n: "02",
    title: "Confirm the read",
    body: "A review grid with confidence flags. Fix anything wrong with a live database search, set quantities, save.",
  },
  {
    n: "03",
    title: "Get a deck that's actually yours",
    body: "TrainerAI builds a legal 60-card list from cards you own, tuned to how you like to play.",
  },
  {
    n: "04",
    title: "Bring in the playgroup",
    body: "Add friends, propose trades, and ask the coach why your deck keeps stalling on turn three.",
  },
];

export function AuthShell({
  mode,
  title,
  sub,
  children,
}: {
  mode: "signup" | "login";
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  const tab = (active: boolean) =>
    `flex-1 rounded-[9px] py-[9px] text-center text-[14px] font-medium transition-colors ${
      active ? "bg-brand-panel text-brand-ink shadow-[0_1px_3px_rgba(22,23,27,.12)]" : "text-brand-ink3"
    }`;

  return (
    <div className="flex min-h-[calc(100vh-120px)] items-start justify-center px-6 pb-20 pt-14 [background:linear-gradient(#F2F0EC,#FBFAF8_340px)]">
      <div className="flex w-full max-w-[1060px] flex-wrap items-start gap-12">
        <div className="min-w-[320px] flex-[1_1_400px] rounded-[20px] border border-brand-line bg-brand-panel p-9 shadow-[0_24px_48px_-32px_rgba(22,23,27,.28)]">
          <div className="mb-[26px] flex gap-1 rounded-xl bg-brand-sunken p-1">
            <Link href="/signup" className={tab(mode === "signup")}>
              Create account
            </Link>
            <Link href="/login" className={tab(mode === "login")}>
              Log in
            </Link>
          </div>
          <h1 className="m-0 mb-1.5 font-display text-[27px] font-bold tracking-[-.02em]">{title}</h1>
          <p className="m-0 mb-6 text-[14.5px] leading-[1.55] text-brand-ink3">{sub}</p>
          {children}
        </div>

        <div className="hidden min-w-[300px] flex-[1_1_380px] pt-2 min-[720px]:block">
          <div className="mb-3.5 font-mono text-[11px] uppercase tracking-[.1em] text-brand-ink5">
            What happens next
          </div>
          <div className="flex flex-col gap-0.5">
            {NEXT_STEPS.map((s) => (
              <div key={s.n} className="flex gap-3.5 border-b border-brand-line py-4">
                <span className="w-5 shrink-0 font-display text-[13px] font-bold text-brand-accent">{s.n}</span>
                <div>
                  <div className="font-display text-[16px] font-bold tracking-[-.01em]">{s.title}</div>
                  <div className="mt-[3px] text-[13.5px] leading-[1.55] text-brand-ink3">{s.body}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-[22px] text-[12.5px] leading-[1.6] text-brand-ink5">
            Anyone can create an account. Password resets are self-serve by email.
          </div>
        </div>
      </div>
    </div>
  );
}

export const authInput =
  "w-full rounded-[11px] border border-brand-line-strong bg-brand-panel px-3.5 py-3 text-[16px] text-brand-ink outline-none placeholder:text-brand-ink5 focus:border-brand-accent focus:shadow-[0_0_0_3px_rgba(44,92,255,.16)]";

export const authLabel = "flex flex-col gap-1.5 text-[12.5px] font-medium text-brand-ink3";

export const authButton =
  "mt-1 w-full rounded-[11px] bg-brand-ink px-3.5 py-3.5 text-[15px] font-medium text-brand-canvas transition-colors hover:bg-brand-accent disabled:opacity-50";
