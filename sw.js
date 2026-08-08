// ============================================================
//  Service worker — makes anydoc studio installable and offline.
//  Strategy:
//    • Code (HTML/JS/CSS): network-first, fall back to cache
//      (fresh when online, still works offline).
//    • Assets (wasm/onnx/fonts/models/images) and model CDNs:
//      cache-first (fast, offline after first use).
//    • Never touch non-GET or user endpoints (Ollama, API,
//      LibreTranslate, scraping proxy) — those pass straight
//      through and are never cached.
// ============================================================

const CACHE = 'anydoc-studio-v2';
const CORE = [
  './', './index.html', './styles.css', './app.js', './worker.js',
  './paddle.js', './paddle-worker.js', './translate.js', './bergamot.js',
  './scrape.js', './rag.js', './export.js', './manifest.json',
  './assets/icon-192.png', './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const MODEL_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'bergamot.s3.amazonaws.com', 'huggingface.co'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never cache POSTs (translation, embeddings)
  const url = new URL(req.url);
  // The backend API (documents, bytes, settings) is live database state —
  // never cache it, always go to the network. Caching /api/docs once served
  // a stale empty list forever.
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  const sameOrigin = url.origin === location.origin;
  const isModelCdn = MODEL_HOSTS.some((h) => url.host.endsWith(h));
  if (!sameOrigin && !isModelCdn) return; // Ollama / API / proxy pass through untouched

  const isCode = sameOrigin && (/\.(html|js|mjs|css)$/.test(url.pathname) || url.pathname.endsWith('/'));
  if (isCode) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
  } else {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    })());
  }
});
