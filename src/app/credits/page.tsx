import Link from "next/link";
import { AI_NAME, APP_NAME } from "@/lib/branding";
import { CREDIT_MENU, MONTHLY_GRANT, SIGNUP_GRANT } from "@/lib/credits";
import { BOOST_LIST, BOOSTS_NOTE } from "@/lib/boosts";

// The one page that talks about what things cost.
//
// Costs used to be printed on the buttons — "Grade my card · 8–15 credits",
// "3–5 credits a question" under the chat header. That puts a price tag on
// every action in the product, and turns using it into watching a meter run.
// The balance is in the header for anyone who wants to keep an eye on it;
// the detail is here, once, for anyone who wants to understand it.

export const metadata = {
  title: `What things cost · ${APP_NAME}`,
  description: `What each ${AI_NAME} action typically costs in credits, and how credits work.`,
};

const PANEL = "rounded-[18px] border border-brand-line bg-white p-6";

export default function CreditsPage() {
  return (
    <div className="mx-auto max-w-[44rem] px-4 py-10">
      <h1 className="m-0 mb-1.5 font-display text-[30px] font-bold tracking-[-.03em]">
        What things cost
      </h1>
      <p className="m-0 mb-7 text-[15px] leading-[1.6] text-brand-ink3">
        {AI_NAME} runs on credits. Everything that isn&apos;t an AI request — your collection,
        decks, trades, battles, prices — costs nothing and keeps working whatever your balance
        says.
      </p>

      <div className={`${PANEL} mb-5`}>
        <h2 className="m-0 mb-4 font-display text-[19px] font-bold tracking-[-.02em]">
          Typical cost per action
        </h2>
        <div className="divide-y divide-brand-line-soft">
          {CREDIT_MENU.map((m) => (
            <div key={m.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
              <span className="font-medium">{m.label}</span>
              <span className="font-mono text-[13px] text-brand-ink2">{m.cost} credits</span>
              <span className="w-full text-[13px] leading-[1.5] text-brand-ink4">{m.what}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`${PANEL} mb-5`}>
        <h2 className="m-0 mb-3 font-display text-[19px] font-bold tracking-[-.02em]">
          Why these are ranges
        </h2>
        <p className="m-0 mb-3 text-[14px] leading-[1.65] text-brand-ink2">
          Because they&apos;re measurements, not prices. Each request is charged what it actually
          cost us to run, so the number moves with the work: a photo of two cards is cheaper than
          a photo of twenty, and a deck built from a 4,000-card collection costs more than one
          built from 200. A long conversation costs more than a short one.
        </p>
        <p className="m-0 text-[14px] leading-[1.65] text-brand-ink2">
          <b>Your action can go over.</b> We check your balance before starting, not during — so a
          request that begins with credits left always runs to the end, even if it costs more than
          you had. You&apos;re never cut off mid-answer. The shortfall comes out of the next
          refill.
        </p>
      </div>

      <div className={`${PANEL} mb-5`}>
        <h2 className="m-0 mb-3 font-display text-[19px] font-bold tracking-[-.02em]">
          When something goes wrong
        </h2>
        <p className="m-0 mb-3 text-[14px] leading-[1.65] text-brand-ink2">
          If a request fails before the model answers, it isn&apos;t charged. If it fails partway
          through — a dropped connection, a timeout, an answer that comes back unusable — the work
          has already been done on our side and the credits are spent. We can&apos;t refund
          consumption that already happened, and we don&apos;t guarantee any particular result
          from any particular request.
        </p>
        <p className="m-0 text-[14px] leading-[1.65] text-brand-ink2">
          That said, if something breaks badly or a run misfires in a way that clearly isn&apos;t
          your doing,{" "}
          <Link href="/support" className="underline">
            tell us
          </Link>{" "}
          — we put credits back by hand more often than not.
        </p>
      </div>

      <div className={`${PANEL} mb-5`}>
        <h2 className="m-0 mb-3 font-display text-[19px] font-bold tracking-[-.02em]">
          Where credits come from
        </h2>
        <ul className="m-0 list-disc space-y-1.5 pl-5 text-[14px] leading-[1.6] text-brand-ink2">
          <li>
            <b>{SIGNUP_GRANT} free credits</b> when you sign up, once.
          </li>
          <li>
            <b>Pro — {MONTHLY_GRANT.pro.toLocaleString()} a month.</b> Refills on your billing
            date; unused credits don&apos;t roll over.
          </li>
          <li>
            <b>Family — {MONTHLY_GRANT.family.toLocaleString()} a month</b>, shared across up to
            five profiles, with an optional per-profile cap.
          </li>
          <li>
            <b>Boosts</b> — one-off top-ups:{" "}
            {BOOST_LIST.map((b) => `${b.credits} for ${b.price}`).join(", ")}. {BOOSTS_NOTE}
          </li>
        </ul>
      </div>

      <p className="text-[13px] leading-[1.6] text-brand-ink5">
        Running low doesn&apos;t lock you out of {APP_NAME} — only new AI requests pause.{" "}
        <Link href="/pricing" className="underline">
          See the plans
        </Link>
        .
      </p>
    </div>
  );
}
