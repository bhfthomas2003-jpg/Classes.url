/* ============================================================================
   service-worker.js — caches ONLY the offline app's own shell (this folder).
   Scope: because this file is served from /offline/, the browser gives it
   the default scope "/offline/" — it CANNOT intercept or cache requests to
   the main portal (e.g. /index.html at the repository root) unless that
   page registers a service worker itself, which we do not touch. This is a
   deliberate safety property, not just a side effect: the existing portal
   stays completely outside anything this file can affect.

   Strategy:
   - App shell (HTML/CSS/JS/icons/manifest in this folder): cache-first,
     falling back to network, and refreshing the cache in the background.
   - Any POST request (all Code.gs API calls) and anything cross-origin
     (script.google.com, drive.google.com): never intercepted — always goes
     straight to the network, and if it fails it fails normally. Dynamic,
     sensitive, per-student data is deliberately never put in the Cache API;
     that data lives only in IndexedDB (see database.js), which the app
     controls explicitly.
   ============================================================================ */
const CACHE_NAME = "mta-offline-shell-v1";
const SHELL_FILES = [
  "./offline.html",
  "./offline.css",
  "./config.js",
  "./database.js",
  "./sync.js",
  "./assignments.js",
  "./offline.js",
  "./manifest.json",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-192.png",
  "./icons/icon-256.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png",
  "./icons/logo-mark.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch API calls, cross-origin requests, or anything that isn't a GET —
  // those must always go to the real network (or fail honestly).
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Only handle requests inside this app's own scope.
  if (!url.pathname.includes("/offline/")) return;

  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached); // offline: fall back to whatever we have cached

      return cached || network;
    })
  );
});
