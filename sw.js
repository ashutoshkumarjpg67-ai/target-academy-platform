// Target Academy — service worker (v82):
// 1) Cache-first for versioned static assets (?v=...) so CSS/JS load instantly (0ms).
// 2) Fast network-first (2.5s timeout) for index.html so users get updates quickly
//    without ever waiting on slow mobile data.
// 3) Web Push notifications for announcements, homework, live classes & tests.
const CACHE_NAME = "ta-shell-v82";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css?v=82",
  "app.js?v=82",
  "config.js?v=16",
  "icon.svg?v=31",
  "manifest.webmanifest",
  "js/branding.js?v=1",
  "js/csv.js?v=1",
  "js/media.js?v=1",
  "js/enhancements.js?v=3",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL_ASSETS).catch(() => {})).catch(() => {})
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Versioned static assets (styles.css?v=..., app.js?v=..., js/*, icon.svg): Cache-First for instant load
  if (url.search.includes("v=") || /\.(css|js|svg|png|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // HTML navigation: Network-First with 2.5s timeout fallback to cache
  e.respondWith(
    Promise.race([
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2500)),
    ]).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});

self.addEventListener("push", (e) => {
  let d = { title: "Target Academy", body: "", url: "./" };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) { /* keep defaults */ }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: "icon.svg?v=31",
    badge: "icon.svg?v=31",
    data: { url: d.url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) { try { c.navigate(url); } catch (_) {} return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
