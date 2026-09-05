// Canonical source of truth for the bytes served at GET /sw.js — the Worker
// embeds an identical copy in src/index.ts (SW_JS_SOURCE); keep both in sync.
//
// This is a CLEANUP worker, not a feature. 27c.site once registered a worker
// that imported remote logic from a third-party ad host and took control of
// this whole origin. A registered service worker persists until it is
// explicitly unregistered, so this file now uninstalls itself: browsers that
// still hold the old installation pick it up on their next update check and
// deregister. The homepage no longer registers anything.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(self.registration.unregister().then(function () { return self.clients.claim(); }));
});
