// Minimal service worker whose only job is to satisfy Chrome's Android installability check
// (a registered service worker with a fetch handler), which is what turns "add to home screen"
// into a real full-screen app shortcut instead of a plain bookmark that still shows the URL bar.
//
// It deliberately does NOT cache anything — every request is passed straight through to the
// network. Caching here risks reintroducing the exact "can't see updates" bug that was already
// hit twice with browser/CDN caching; a pure pass-through carries none of that risk.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
