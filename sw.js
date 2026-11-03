// OM Reader 的 Service Worker——只快取程式殼，資料在 IndexedDB（不經這裡）。
// 頁面本體 network-first（3 秒逾時才先給快取，網路那一趟照樣跑完寫回快取），
// 殼層靜態檔 cache-first；跨網域請求（api.github.com）完全不經手。
// 殼層檔案有改，CACHE_VERSION 往前推一號。
const CACHE_VERSION = 'om-reader-v12';
const SHELL = ['./', './index.html', './theme.js', './core.js', './reader.js', './app.js', './app.css', './viewer.html', './viewer.js',
  './vendor/markdown-it.min.js', './vendor/purify.min.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-32.png', './icons/mark.png', './icons/mark-center.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('om-reader-') && k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/probe/') || url.pathname.includes('/dev-data/')) return;
  if (req.mode === 'navigate') {
    const key = url.pathname.endsWith('/viewer.html') ? './viewer.html' : './index.html';
    event.respondWith(networkFirst(event, req, key));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

function networkFirst(event, req, key) {
  const net = fetch(req).then(async (res) => {
    if (res && res.ok) {
      const c = await caches.open(CACHE_VERSION);
      await c.put(key, res.clone());
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000)).then(() => caches.match(key));
  return Promise.race([
    net.catch(() => caches.match(key)),
    timeout.then((hit) => hit || net),
  ]).then((res) => res || net);
}
