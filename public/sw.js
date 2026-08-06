// TrainerDeck's service worker.
//
// Hand-written, and deliberately small. A service worker sits between the app
// and the network for every request the app makes, forever, including after
// the code that installed it is gone — so the failure mode of a clever one is
// a member seeing yesterday's prices, or a signed-out session that won't sign
// back in, with no way to explain it and no way for them to fix it.
//
// The rules, narrowest first:
//
//   1. Anything that isn't a plain GET → the network, untouched. Scans,
//      saves, sign-ins and every mutation the app makes are POSTs, and a
//      service worker has no business anywhere near them.
//   2. /api/ and /auth/ → the network, untouched. Prices, credits, sessions.
//      A cached price is a wrong number and a cached session is a locked
//      door.
//   3. Immutable build assets (/_next/static/) → cache first. Their URLs
//      contain a content hash, so a cached one can never be stale: a new
//      build is a new URL.
//   4. Page navigations → network first, falling back to the cached shell
//      and then to /offline. This is what makes the app open on the
//      Underground.
//   5. Everything else → network, and don't cache it.
//
// CACHE_VERSION is bumped by hand when these rules change. Old caches are
// deleted on activate, so a version bump is also the eraser.

const CACHE_VERSION = "v1";
const STATIC_CACHE = `trainerdeck-static-${CACHE_VERSION}`;
const PAGE_CACHE = `trainerdeck-pages-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGE_CACHE);
      // Only the offline page. Precaching the real pages would bake a
      // signed-in shell into a cache that outlives the session.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      // Take over on the next load rather than waiting for every tab to
      // close. Not paired with an automatic reload: a scan in flight must
      // not be interrupted by its own page refreshing underneath it.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, PAGE_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith("trainerdeck-") && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

/** Is this one of ours, and safe to touch? */
function sameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!sameOrigin(url)) return; // card art on other hosts: let the browser be the browser
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Build assets: hashed URLs, so a hit is always correct.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })()
    );
    return;
  }

  // Pages. Network first — a collection is live data and being one refresh
  // stale is worse than being one second slower — then the last copy we
  // saw, then the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(PAGE_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })()
    );
  }
});
