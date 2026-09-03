/* Service worker: exists so loom is installable as an app and opens in 0ms on mobile.
   Uses stale-while-revalidate for the HTML document navigation request so returning to loom
   opens instantly without a blank white screen, while fetching fresh HTML in the background.
   When the bundle changes on the server, `watchBuild()` and `reloadIfBundleStale()` in app.ts
   detect the new build hash and prompt/reload cleanly. Assets are content-hashed and live. */

const CACHE_NAME = "loom-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return; // only the document; everything else is hashed or live

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((response) => {
          if (response.ok) {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached ?? new Response("offline", { status: 503 }));

      return cached ?? networkPromise;
    }),
  );
});
