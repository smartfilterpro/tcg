import type { Metadata } from "next";
import { PricingSection } from "@/components/marketing/Pricing";
import { APP_NAME, AI_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: `Pricing — ${APP_NAME}`,
  description: `Collecting is free forever. ${AI_NAME} runs on credits, metered by what each request actually costs, with boosts when you need more.`,
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; reason?: string }>;
}) {
  const { checkout, reason } = await searchParams;

  return (
    <>
      {/* Where a failed checkout lands. Without this the redirect was silent —
          someone would click "Go Pro", get bounced back to the price list and
          have no idea why. */}
      {checkout === "failed" && (
        <div className="border-b border-[#F0DFA8] bg-[#FFF8E1]">
          <div className="mx-auto max-w-[1200px] px-[18px] py-3.5 text-[13.5px] leading-[1.6] text-[#7A5A12] min-[1000px]:px-8">
            <b>Checkout couldn&apos;t start.</b>{" "}
            {reason || "Something went wrong opening the payment page."} Nothing was charged — pick
            a plan below to try again.
          </div>
        </div>
      )}
      <PricingSection />
    </>
  );
}
