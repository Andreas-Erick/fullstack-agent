// Service worker for the phone client: caches the app shell only. Conversations and every /api/
// response go straight to the network and are never stored.
const CACHE = 'nexus-shell-v16';
// Every file of the built-in faces (renderer/js/faces/registry.mjs FACE_FILES, under /js/). A classic worker
// can't import that module: test/facesregistry.test.js keeps this list equal to it.
const FACES = ['/js/themecore.js', '/js/faces/env.js', '/js/faces/common.js', '/js/faces/registry.mjs', '/js/faces/siren.js', '/js/visualizer.js', '/js/faces/radial.js', '/js/faces/rain.js', '/js/faces/neural.js', '/js/faces/companion.js'];
// The phone client's modules (main/companion.js STATIC; test/sync.test.js keeps the two in step).
const MODULES = ['/state.js', '/ui.js', '/net.js', '/pairing.js', '/stream.js', '/offline.js', '/chatview.js', '/conversations.js', '/approvals.js', '/voiceout.js', '/talk.js', '/face.js', '/schedule.js', '/nav.js', '/hud.js', '/boot.js'];
const SHELL = ['/', '/app.js', ...MODULES, '/screens.js', '/sync.js', '/styles.css', '/manifest.webmanifest', '/icon.png', '/vendor/marked.js', '/vendor/purify.js', '/vendor/katex.js', '/js/mathtext.js', '/js/chatcore.js', '/js/braintable.mjs', '/js/turnstate.js', ...FACES];

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
