// The landing page, from Landing.dc.html. Copy is the mock's; the deliberate
// departures (metered credit ranges, hand-set stats with a disclaimer, no
// OAuth buttons, no demo video, real-only footer links) are itemised in the
// phase report rather than smuggled in.

import Image from "next/image";
import Link from "next/link";
import { MarketingNav, MarketingFooter } from "@/components/marketing/Chrome";
import { PricingSection } from "@/components/marketing/Pricing";
import { APP_NAME } from "@/lib/branding";
import type { LiveStat } from "@/lib/liveStats";

const DIFFS = [
  {
    tag: "BULK SCAN",
    title: "One photo, twenty cards",
    body: "Spread the stack on the table and shoot it. Names and collector numbers are read together, matched against the card database, and merged into your existing quantities.",
    vs: "one card per photo, or manual entry off a set list.",
  },
  {
    tag: "TRAINER AI",
    title: "Decks from the cards you own",
    body: "Not a netdeck you can't build. A legal 60-card list from your actual binder, with the swaps that would improve it and what to buy next if you want to.",
    vs: "a price database and a wishlist button.",
  },
  {
    tag: "COACHING",
    title: "It tells you how to play it",
    body: "Ask why you keep losing. The coach reads your deck and answers in plain language — opening plays, what to hold, which line wins the long game.",
    vs: "you go read a forum thread from 2023.",
  },
  {
    tag: "COMMUNITY",
    title: "Play with people you know",
    body: "Share a deck with a friend, borrow theirs for a battle, and browse each other's binders — with live value estimates on every card.",
    vs: "a group chat full of screenshots.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Shoot the pile",
    body: "Cards flat, decent light, collector numbers visible. One photo covers a whole row.",
  },
  {
    n: "02",
    title: "Skim and confirm",
    body: "Confident reads are already right. Only the flagged ones want a look.",
  },
  {
    n: "03",
    title: "Build and play",
    body: "Ask for a deck, get a list you can physically assemble tonight, then have it coached.",
  },
];

const FAMILY_POINTS = [
  "Up to 5 profiles on one bill — each with their own binder and decks.",
  "Kids' accounts can't spend credits without a parent approving it.",
  "Trading inside the family is free and doesn't need approvals.",
  "Coaching answers in plain English, no TCG jargon required.",
];

/** The mock's screenshot slots, kept as hatched placeholders until real
 *  captures exist — shipping someone else's screenshot or none at all are
 *  both worse. */
function Placeholder({ label, dark = false, className }: { label: string; dark?: boolean; className?: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 p-6 text-center ${
        dark
          ? "border border-dark-line2 [background:repeating-linear-gradient(135deg,#22242A_0_8px,#1C1E23_8px_16px)]"
          : "[background:repeating-linear-gradient(135deg,#F2F0EC_0_8px,#E9E6E0_8px_16px)]"
      } ${className ?? ""}`}
    >
      <span className={`font-mono text-[11.5px] ${dark ? "text-dark-ink4" : "text-brand-ink4"}`}>{label}</span>
    </div>
  );
}

/** The hero shot: two phones, the one in front reviewing a scan.
 *
 *  A browser frame with a wide, short window sat here, and a phone capture
 *  in it could only ever show a strip of a screen. The product is used on a
 *  phone, so the frame is a phone.
 *
 *  WHOLE phones, not bled off the band. An earlier pass clipped them at the
 *  section edge, which looked like the layout had run out of room rather
 *  than like a composition. Each frame carries its own aspect ratio and the
 *  screenshot fills it with object-cover anchored to the top: the frame
 *  keeps its shape at every width, and what gets cropped is the bottom of
 *  the screen — the part below the fold on a real phone anyway.
 */
function PhoneStack() {
  return (
    <div className="relative mx-auto flex w-full max-w-[560px] items-center justify-end py-4">
      {/* Behind: a card's detail, tilted and mostly covered. It is there to
          say "there is more than one screen", so it only needs an edge —
          and it hides entirely on narrow screens, where two phones is
          clutter rather than depth. */}
      <div className="absolute bottom-[6%] left-0 hidden aspect-[9/17] w-[50%] -rotate-[8deg] overflow-hidden rounded-[30px] border-[9px] border-brand-ink bg-brand-ink shadow-[0_30px_60px_-25px_rgba(22,23,27,.45)] min-[640px]:block">
        <Image
          src="/shots/hero-card.jpg"
          alt=""
          fill
          sizes="240px"
          className="object-cover object-top"
        />
      </div>

      {/* In front: the scan review, upright and unobstructed — the one
          screen the headline is about. */}
      <div className="relative aspect-[550/935] w-full max-w-[420px] overflow-hidden rounded-[42px] border-[12px] border-brand-ink bg-brand-ink shadow-[0_40px_80px_-30px_rgba(22,23,27,.5)] min-[640px]:w-[76%]">
        <Image
          src="/shots/hero-scan.jpg"
          alt="Reviewing a scan: five cards read in fifteen seconds, each with a confidence badge, set, collector number and price."
          fill
          sizes="(max-width: 640px) 90vw, 420px"
          className="object-cover object-top"
          priority
        />
      </div>

      {/* The claim the screenshot backs up, said out loud. Straddles the
          phone's top-right corner so it reads as a callout rather than as
          part of the UI underneath it. */}
      <span className="absolute right-[-2%] top-[8%] z-10 rounded-full bg-brand-highlight px-3.5 py-1.5 font-mono text-[11px] font-medium tracking-[.06em] text-brand-ink shadow-md">
        5 CARDS · 15s
      </span>
    </div>
  );
}

/** The hero numbers are measured, so they arrive as props from the server
 *  component that reads them rather than being imported as constants. */
export default function Landing({
  stats,
  statsNote,
}: {
  stats: readonly LiveStat[];
  statsNote: string;
}) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-brand-canvas font-body text-brand-ink">
      <MarketingNav />

      {/* ===== hero ===== */}
      <div id="scan" className="border-b border-brand-line [background:linear-gradient(#F2F0EC_0%,#FBFAF8_100%)]">
        <div className="mx-auto max-w-[1200px] px-[18px] pt-10 min-[1000px]:px-8 min-[720px]:pt-[72px]">
          <div className="flex flex-wrap items-center gap-11">
            <div className="min-w-[320px] flex-[1_1_460px]">
              <div className="mb-[26px] inline-flex items-center gap-2 rounded-full border border-brand-line bg-brand-panel py-1.5 pl-2 pr-3.5">
                <span className="rounded-full bg-brand-highlight px-2 py-[3px] font-mono text-[10px] font-medium text-brand-ink">
                  BETA
                </span>
                <span className="whitespace-nowrap text-[12.5px] text-brand-ink3">
                  Open to everyone — free tier, no invite needed
                </span>
              </div>
              <h1 className="m-0 font-display text-[38px] font-bold leading-[1.02] tracking-[-.035em] [text-wrap:balance] min-[1100px]:text-[64px] min-[720px]:text-[52px]">
                Scan the whole pile.
                <br />
                Play the better deck.
              </h1>
              <p className="mt-6 max-w-[48ch] text-[16.5px] leading-[1.58] text-brand-ink2 [text-wrap:pretty] min-[720px]:text-[19px]">
                Most collection apps make you photograph one card at a time, then leave you staring
                at a spreadsheet. {APP_NAME} reads <b>20+ cards from a single photo</b> and then
                helps you actually build and play a deck with the cards you own.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/signup"
                  className="rounded-full bg-brand-ink px-[30px] py-4 text-[16px] font-medium text-brand-canvas transition-colors hover:bg-brand-accent"
                >
                  Start free — 100 AI credits
                </Link>
              </div>
              <div className="mt-10 flex flex-wrap gap-[30px]">
                {stats.map((s) => (
                  <div key={s.value}>
                    <div className="font-display text-[26px] font-bold tracking-[-.03em] min-[720px]:text-[32px]">
                      {s.value}
                    </div>
                    <div className="mt-0.5 max-w-[19ch] text-[13px] leading-[1.45] text-brand-ink3">{s.label}</div>
                  </div>
                ))}
              </div>
              <p className="mb-6 mt-3 max-w-[52ch] text-[11.5px] leading-snug text-brand-ink5">{statsNote}</p>
            </div>

            <div className="min-w-[320px] flex-[1_1_420px]">
              <PhoneStack />
            </div>
          </div>
        </div>
      </div>

      {/* ===== differentiators ===== */}
      <div id="ai" className="mx-auto max-w-[1200px] px-[18px] py-14 min-[1000px]:px-8 min-[720px]:py-[88px]">
        <div className="mb-11 max-w-[52ch]">
          <div className="mb-3.5 font-mono text-[11px] uppercase tracking-[.12em] text-brand-ink5">
            Why it&apos;s different
          </div>
          <h2 className="m-0 font-display text-[30px] font-bold leading-[1.08] tracking-[-.03em] min-[720px]:text-[42px]">
            Other apps are catalogues. This one is a playgroup.
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-4 min-[720px]:grid-cols-2">
          {DIFFS.map((d) => (
            <div key={d.tag} className="flex flex-col gap-3 rounded-[18px] border border-brand-line bg-brand-panel p-[22px] min-[720px]:p-[30px]">
              <span className="self-start rounded-md bg-brand-sunken px-2 py-1 font-mono text-[11px] font-medium text-brand-ink3">
                {d.tag}
              </span>
              <h3 className="m-0 font-display text-[23px] font-bold tracking-[-.02em]">{d.title}</h3>
              <p className="m-0 text-[15px] leading-[1.6] text-brand-ink3 [text-wrap:pretty]">{d.body}</p>
              <div className="mt-auto border-t border-brand-line-soft pt-3.5 text-[13px] text-brand-ink2">
                <b className="font-display">Everywhere else:</b> {d.vs}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ===== how it works ===== */}
      <div className="bg-brand-ink text-brand-canvas">
        <div className="mx-auto max-w-[1200px] px-[18px] py-14 min-[1000px]:px-8 min-[720px]:py-[88px]">
          <h2 className="m-0 mb-11 max-w-[26ch] font-display text-[30px] font-bold leading-[1.08] tracking-[-.03em] min-[720px]:text-[42px]">
            Pile of cards to a playable deck in one evening.
          </h2>
          <div className="grid grid-cols-1 gap-5 min-[720px]:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="flex flex-col gap-4">
                <Placeholder dark label="Screenshot coming soon" className="h-[230px] rounded-2xl" />
                <div className="flex gap-3">
                  <span className="font-display text-[14px] font-bold text-brand-highlight">{s.n}</span>
                  <div>
                    <h3 className="m-0 font-display text-[20px] font-bold tracking-[-.02em]">{s.title}</h3>
                    <p className="mt-1.5 text-[14.5px] leading-[1.6] text-dark-ink3 [text-wrap:pretty]">{s.body}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ===== for families ===== */}
      <div id="families" className="mx-auto max-w-[1200px] px-[18px] py-14 min-[1000px]:px-8 min-[720px]:py-[88px]">
        <div className="flex flex-wrap items-center gap-14">
          <div className="min-w-[300px] flex-[1_1_400px]">
            <div className="mb-3.5 font-mono text-[11px] uppercase tracking-[.12em] text-brand-ink5">For parents</div>
            <h2 className="m-0 mb-[18px] font-display text-[30px] font-bold leading-[1.1] tracking-[-.03em] min-[720px]:text-[42px]">
              You don&apos;t have to learn the game to help your kid win.
            </h2>
            <p className="m-0 mb-[22px] max-w-[46ch] text-[16.5px] leading-[1.62] text-brand-ink2 [text-wrap:pretty]">
              Coaching explains the deck in plain English — what to play first, what to hold, why
              this card matters. Everyone in the house gets their own binder under one bill, and you
              approve any spending.
            </p>
            <div className="flex flex-col gap-2.5">
              {FAMILY_POINTS.map((p) => (
                <div key={p} className="flex items-start gap-2.5 text-[15px] leading-[1.55] text-brand-ink2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent" />
                  <span>{p}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-[300px] flex-[1_1_380px] rounded-[18px] border border-brand-line bg-brand-panel p-[26px]">
            <div className="mb-[18px] font-mono text-[11px] uppercase tracking-[.1em] text-brand-ink5">
              Coach · plain English
            </div>
            <div className="flex flex-col gap-3.5">
              <div className="max-w-[82%] self-end rounded-[14px_14px_4px_14px] bg-brand-sunken px-[15px] py-3 text-[14.5px] leading-[1.5]">
                Why do I keep losing on turn 3?
              </div>
              <div className="max-w-[88%] self-start rounded-[14px_14px_14px_4px] bg-brand-ink px-4 py-[13px] text-[14.5px] leading-[1.55] text-brand-canvas">
                You&apos;re benching one Pokémon and hoping. Put down two Basics on turn 1 — even a
                weak one — so a knockout doesn&apos;t end the game. Your Charizard line needs a turn
                to set up.
              </div>
              <div className="max-w-[82%] self-end rounded-[14px_14px_4px_14px] bg-brand-sunken px-[15px] py-3 text-[14.5px] leading-[1.5]">
                Which of my cards are worth grading?
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="font-mono text-[11px] text-brand-ink5">1–3 credits per reply</span>
                <span className="h-px flex-1 bg-brand-line" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== pricing (shared with /pricing) ===== */}
      <PricingSection />

      {/* ===== closing CTA ===== */}
      <div className="mx-auto max-w-[1200px] px-[18px] py-14 text-center min-[1000px]:px-8 min-[720px]:py-[88px]">
        <h2 className="mx-auto mb-[18px] max-w-[24ch] font-display text-[32px] font-bold leading-[1.06] tracking-[-.035em] min-[720px]:text-[46px]">
          Point your camera at the pile.
        </h2>
        <p className="mx-auto mb-[30px] max-w-[52ch] text-[17px] leading-[1.6] text-brand-ink3">
          Free forever for collecting. 100 TrainerAI credits to see what the assistant does. No
          card, no invite code.
        </p>
        <Link
          href="/signup"
          className="inline-block rounded-full bg-brand-ink px-[34px] py-[17px] text-[16px] font-medium text-brand-canvas transition-colors hover:bg-brand-accent"
        >
          Create your free account
        </Link>
      </div>

      <MarketingFooter />
    </div>
  );
}
