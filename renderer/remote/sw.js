// Service worker for the phone client: caches the app shell only. Conversations and every /api/
// response go straight to the network and are never stored.
const CACHE = 'nexus-shell-v4';
const FACES = ['/js/themecore.js', '/js/visualizer.js', '/js/faces/env.js', '/js/faces/common.js', '/js/faces/radial.js', '/js/faces/rain.js', '/js/faces/neural.js', '/js/faces/companion.js'];
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.png', '/vendor/marked.js', '/vendor/purify.js', ...FACES];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Shell: network first (so updates on the desktop show up at once), the cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
