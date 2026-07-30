"use client";

// What happens after Stripe takes the money.
//
// Checkout's success_url is `/?upgraded=1`, and nothing read that parameter.
// So the browser came back to a page rendered from a profile that still said
// "free", with no confirmation of any kind — and the plan only appeared once
// the person found their way to Billing and pressed "Already paid? Refresh".
//
// That is not a flake, it's a race the webhook cannot win. Stripe redirects
// the browser the instant the payment succeeds; the webhook is a separate,
// asynchronous delivery to our server. The redirect is a round trip to the
// user's own browser, the webhook is a queued POST — the page will usually
// render before the plan lands, and if the endpoint is misconfigured it never
// lands at all. Waiting and hoping is not a design.
//
// So the return does what the manual button does: asks Stripe directly. That
// call is already proven — it is the thing people were being made to press.
// The webhook stays the normal path and this is idempotent with it: both
// write the same plan from the same source of truth.

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const PLAN_NAMES: Record<string, string> = { pro: "Pro", family: "Family" };

export default function UpgradeReturn() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "syncing" | "done" | "failed">("idle");
  const [plan, setPlan] = useState<string | null>(null);

  const upgraded = params.get("upgraded") === "1";

  // A ref, not the state value, guards against running twice.
  //
  // Guarding on `state` means `state` has to be a dependency — and then
  // setting it to "syncing" re-runs the effect, which fires the previous
  // run's cleanup, which sets that closure's `live` to false while its fetch
  // is still in the air. Every handler then bails and the banner sits on
  // "Confirming…" forever. A ref keeps the guard out of the dependency list.
  const started = useRef(false);

  useEffect(() => {
    if (!upgraded || started.current) return;
    started.current = true;
    let live = true;
    setState("syncing");

    fetch("/api/billing/sync", { method: "POST" })
      .then((r) => r.json().catch(() => ({})))
      .then((json: { plan?: string; error?: string }) => {
        if (!live) return;
        if (json.plan && json.plan !== "free") {
          setPlan(json.plan);
          setState("done");
          // The header's plan badge, the credit meter and every locked nav
          // item are server-rendered, so they need the server to run again.
          router.refresh();
        } else {
          // Paid, but Stripe doesn't show it yet. Rare, and recoverable by
          // the same button as before — so say that rather than claiming a
          // failure the reader can't act on.
          setState("failed");
        }
      })
      .catch(() => {
        if (live) setState("failed");
      });

    return () => {
      live = false;
    };
  }, [upgraded, router]);

  // Clear the parameter once we're finished, so a refresh or a shared link
  // doesn't replay this. Left in place while syncing: losing it mid-flight
  // would strand someone on a page that never resolves.
  useEffect(() => {
    if (state === "done" || state === "failed") {
      const t = setTimeout(() => {
        const next = new URLSearchParams(params.toString());
        next.delete("upgraded");
        const qs = next.toString();
        // Current path, not a hardcoded "/": success_url points at the root
        // today, and a component that silently navigates elsewhere if that
        // ever changes is a trap for whoever changes it.
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }, 6000);
      return () => clearTimeout(t);
    }
  }, [state, params, pathname, router]);

  if (!upgraded) return null;

  return (
    <div
      role="status"
      className="mb-4 rounded-[14px] border border-brand-line bg-white px-4 py-3 text-[13.5px]"
    >
      {state === "syncing" && <span className="text-brand-ink3">Confirming your payment…</span>}
      {state === "done" && (
        <span className="text-brand-positive">
          Payment received — you&apos;re on {PLAN_NAMES[plan ?? ""] ?? "your new plan"}. Your
          credits are available now.
        </span>
      )}
      {state === "failed" && (
        <span className="text-brand-ink2">
          Payment received, but the plan hasn&apos;t applied yet. Give it a moment, then use{" "}
          <a href="/settings/billing" className="underline">
            Billing → Already paid? Refresh
          </a>
          .
        </span>
      )}
    </div>
  );
}
