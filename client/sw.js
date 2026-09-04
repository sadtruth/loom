/* Service worker: exists so loom is installable as an app and opens in 0ms on mobile.
   Uses NETWORK-FIRST for navigation requests: fetch from the server, cache it on success,
   and fall back to the cached shell only when the network throws (truly offline).
   Why not stale-while-revalidate: when the bundle changes on the server, the cached shell
   names the old chunk URL. The server now answers that URL with a reload stub (finding 3),
   so returning to the app loaded the cached stale shell, the stub fired, and the page loaded
   twice — the flicker the user sees on phone every return to the app. Network-first means a
   live network always produces the current shell with current chunk URLs. */

const CACHE_NAME = "loom-shell-v2";
/* Only the shell's own caches are this worker's to delete. The transcript snapshots live in
   `loom-snap` (client/snapshot.ts), so a blanket "delete everything that is not CACHE_NAME"
   threw every snapshot away the first time a new service worker activated — which is right
   after a deploy, the moment the early paint matters most. */
const SHELL_PREFIX = "loom-shell-";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(SHELL_PREFIX) && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return; // only the document; everything else is hashed or live

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        // Network-first: always try the real server, cache the fresh response.
        const response = await fetch(request);
        void cache.put(request, response.clone());
        return response;
      } catch {
        // Offline or server unreachable: serve the cached shell if we have one.
        const cached = await cache.match(request);
        return cached ?? new Response("offline", { status: 503 });
      }
    }),
  );
});
