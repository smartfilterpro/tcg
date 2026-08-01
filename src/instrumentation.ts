/** Runs once when the server boots (Next.js instrumentation hook).
 *  Railway keeps one long-lived Node process, so a plain timer is all the
 *  background scheduling we need — no external cron service. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPriceRefreshLoop } = await import("@/lib/priceRefresh");
    startPriceRefreshLoop();
    const { startArtMirrorLoop } = await import("@/lib/artMirror");
    startArtMirrorLoop();
    const { startPriceSyncLoop } = await import("@/lib/priceTrackerSync");
    startPriceSyncLoop();
  }
}
