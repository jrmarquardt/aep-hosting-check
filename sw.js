// Offline cache for this page's own files (the hosted app would do the same).
// Requests to Ollama or any other site are never touched.
const CACHE = 'aep-hosting-check-v2';
const FILES = ['./', './index.html', './check.js', './worker.js', './style.css', './courses.html', './courses.js', './courses-key.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first so updates show up at once; cached copy when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
