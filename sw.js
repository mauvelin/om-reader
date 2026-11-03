// OM Reader 的 Service Worker——只快取程式殼，資料在 IndexedDB（不經這裡）。
// 頁面本體 network-first（3 秒逾時才先給快取，網路那一趟照樣跑完寫回快取），
// 殼層靜態檔 cache-first；跨網域請求（api.github.com）完全不經手。
// 殼層檔案有改，CACHE_VERSION 往前推一號。
// 另外代理同源的 drive-media/<檔案 ID>：帶上記憶體裡的 Google token 與 Range 轉給 Drive API（見檔尾）。
const CACHE_VERSION = 'om-reader-v18';
const SHELL = ['./', './index.html', './theme.js', './core.js', './google.js', './drive.js', './player.js', './reader.js', './pdfview.js', './courses.js', './app.js', './app.css', './viewer.html', './viewer.js',
  './vendor/markdown-it.min.js', './vendor/purify.min.js', './vendor/learn-text.js', './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js', './manifest.webmanifest',
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
  const dm = url.pathname.match(/\/drive-media\/([A-Za-z0-9_-]{10,})$/);
  if (dm) { event.respondWith(driveProxy(req, dm[1])); return; }
  if (req.mode === 'navigate') {
    const key = url.pathname.endsWith('/viewer.html') ? './viewer.html' : './index.html';
    event.respondWith(networkFirst(event, req, key));
    return;
  }
  // pdf.js 的字型對照表與標準字型：用到才下載，下載後留在快取（離線也能顯示中文 PDF）
  if (url.pathname.includes('/vendor/pdfjs/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(async (res) => {
      if (res && res.ok) { const c = await caches.open(CACHE_VERSION); await c.put(req, res.clone()); }
      return res;
    })));
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

/* ── 雲端硬碟影音代理 ──
   <video>／<audio> 的 src 是同源的 drive-media/<ID>：這裡帶上 token 與原請求的 Range 轉給 Drive API，把 206 交回播放器。
   token 只在這個 SW 的記憶體；系統把 SW 停掉再叫醒時 token 會不見，就向頁面要一次（頁面也只放記憶體）。
   Drive 的跨網域回應不公開 Content-Range，所以用「請求起點＋這次長度／檔案總長」自己補（總長由頁面在播放前給）。 */
let G_TOKEN = null;
const G_SIZES = new Map();
let tokenWaiters = [];
self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type !== 'gtoken') return;
  G_TOKEN = m.token || null;
  for (const [id, n] of Object.entries(m.sizes || {})) G_SIZES.set(id, n);
  const w = tokenWaiters; tokenWaiters = [];
  w.forEach((resolve) => resolve());
});
async function tellPages(msg) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage(msg);
}
async function needToken(id) {
  if (G_TOKEN && G_SIZES.has(id)) return G_TOKEN;
  const p = new Promise((resolve) => { tokenWaiters.push(resolve); setTimeout(resolve, 4000); });
  await tellPages({ type: 'g-need-token' });
  await p;
  return G_TOKEN;
}
async function driveProxy(req, id) {
  const token = await needToken(id);
  if (!token) { await tellPages({ type: 'g-unauthorized', status: 401 }); return new Response('', { status: 401 }); }
  const range = req.headers.get('range');
  const headers = { Authorization: 'Bearer ' + token };
  if (range) headers.Range = range;
  let res;
  try {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch (e) { return new Response('', { status: 502 }); }
  if (res.status === 401 || res.status === 403) { await tellPages({ type: 'g-unauthorized', status: res.status }); return new Response('', { status: res.status }); }
  const out = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (res.status === 206 && !out.has('content-range')) {
    const total = G_SIZES.get(id);
    const len = Number(res.headers.get('content-length'));
    const start = range ? Number((range.match(/bytes=(\d+)-/) || [])[1] || 0) : 0;
    if (total && len) out.set('content-range', `bytes ${start}-${start + len - 1}/${total}`);
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
