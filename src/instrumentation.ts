/** Runs once when the server boots (Next.js instrumentation hook).
 *  Railway keeps one long-lived Node process, so a plain timer is all the
 *  background scheduling we need — no external cron service. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // First, so the loops' own startup output is in the buffer too.
    const { installLogCapture } = await import("@/lib/logBuffer");
    installLogCapture();
    const { startPriceRefreshLoop } = await import("@/lib/priceRefresh");
    startPriceRefreshLoop();
    const { startArtMirrorLoop } = await import("@/lib/artMirror");
    startArtMirrorLoop();
    const { startPriceSyncLoop } = await import("@/lib/priceTrackerSync");
    startPriceSyncLoop();
    const { startCardImportLoop } = await import("@/lib/cardImport");
    startCardImportLoop();
    const { startMetaSyncLoop } = await import("@/lib/metaSync");
    startMetaSyncLoop();
  }
}
