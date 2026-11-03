// OM Reader 測試頁的 Service Worker。
// 頁面本體 network-first（3 秒逾時才先給快取，網路那一趟照樣跑完寫回快取）；
// 殼層靜態檔 cache-first；跨網域請求（api.github.com）完全不經手。
// 殼層檔案有改，CACHE_VERSION 往前推一號。
const CACHE_VERSION = 'om-probe-v1';
const SHELL = ['./', './index.html', './probe.js', './probe.css', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('om-probe-') && k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/probe/media/')) return;   // 影音測試頁有自己的 Service Worker
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(event, req));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

function networkFirst(event, req) {
  const net = fetch(req).then(async (res) => {
    if (res && res.ok) {
      const c = await caches.open(CACHE_VERSION);
      await c.put('./index.html', res.clone());
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000)).then(() => caches.match('./index.html'));
  return Promise.race([
    net.catch(() => caches.match('./index.html')),
    timeout.then((hit) => hit || net),
  ]).then((res) => res || net);
}
