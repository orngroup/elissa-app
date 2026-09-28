// Elissa Revision service worker – makes the app open instantly and work offline.
const CACHE = "elissa-v4";
const SHELL = ["./", "./index.html", "./app.js", "./player.js", "./presets.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || /(gstatic\.com\/firebasejs|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)/.test(url.href);
  if (!cacheable) return; // Firebase data and sign-in calls go straight to the network

  // Network first so updates arrive quickly; fall back to the cache when offline
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
