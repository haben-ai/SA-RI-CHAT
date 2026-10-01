'use strict';
// Caches ONLY the app shell (same-origin static files). Supabase traffic —
// messages, photos, auth — is never touched or cached by this worker.
// __VERSION__ is replaced at build time with a hash of the app files, so every
// deploy installs a fresh cache and deletes the old one.
const CACHE = 'pc-__VERSION__';
const SHELL = ['./', 'app.js', 'manifest.json', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Any page navigation → the cached app shell (works offline).
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./').then((r) => r || fetch(req)));
    return;
  }

  // Static files: cache first, fill the cache on first use.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
