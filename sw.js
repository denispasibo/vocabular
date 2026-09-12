/* Service worker: offline app shell */
'use strict';

const CACHE = 'vocabular-v15';
const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'reader.js',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only our own static files; API requests always go straight to the network
  if (url.origin !== location.origin) return;

  // Network-first: users always get the latest version right away;
  // the cache serves as the offline fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
