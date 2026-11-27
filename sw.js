// Target Academy — service worker (v71):
// 1) Network-first app-shell caching so students always get the newest version
//    when online AND can still open the app & cached assets when offline.
// 2) Web Push notifications for announcements, homework, live classes & tests.
const CACHE_NAME = "ta-shell-v79";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css?v=78",
  "app.js?v=79",
  "config.js?v=16",
  "icon.svg?v=31",
  "manifest.webmanifest",
  "js/branding.js?v=1",
  "js/csv.js?v=1",
  "js/media.js?v=1",
  "js/enhancements.js?v=2",
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
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
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
