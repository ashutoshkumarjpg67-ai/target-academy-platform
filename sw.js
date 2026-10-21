// Target Academy — service worker: phone push notifications (v20).
// Deliberately no offline caching of the app itself, so students
// always get the newest version; this worker only handles push.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", () => { /* network passthrough */ });

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
