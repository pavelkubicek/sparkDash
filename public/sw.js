// sparkDash service worker — offline app shell, never offline telemetry.
//
// The dashboard's whole job is live numbers (GPU/power/LLM over /api and /ws).
// Serving a stale reading from cache would present old data as fresh, so every
// API/WebSocket/non-GET request is left completely untouched by this worker.
// What IS cached is the static shell: hashed /assets and /icons build output
// (immutable by name → cache-first) and index.html (network-first → a new
// deploy is seen immediately, the cache only answers when offline).
const SHELL_CACHE = "sparkdash-shell";
const ASSET_CACHE = "sparkdash-assets";
const PRECACHE = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  // Best-effort precache: an unreachable server at install time must not
  // strand the worker in "installed" — the runtime caches cover the rest.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)).catch(() => void 0)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live data plane: pass through with no caching, ever.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;

  // Immutable build output: cache-first, backfill on miss.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSET_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Shell documents (navigation): network-first so fresh deploys win; when
  // offline, answer with this very URL from cache, else the app shell root.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || caches.match("/"))
            .then((hit) => hit || Response.error())
        )
    );
    return;
  }

  // Everything else (favicon data-URIs never hit the wire; stray GETs like
  // robots.txt) stays exactly as if no worker existed.
});
