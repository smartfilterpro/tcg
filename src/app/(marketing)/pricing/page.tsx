import type { Metadata } from "next";
import { PricingSection } from "@/components/marketing/Pricing";
import { APP_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: `Pricing — ${APP_NAME}`,
  description:
    "Collecting is free forever. Trainer AI runs on credits — 1 credit is one cent of AI, metered per request, with boosts when you need more.",
};

export default function PricingPage() {
  return <PricingSection />;
}
