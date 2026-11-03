// OM 影音測試頁的 Service Worker——驗證「App 內播放雲端硬碟影片」的代理做法。
// <video src="./drive-media/<檔案 ID>"> 是同源網址：這裡攔下來，帶上記憶體裡的 Google token
// 和原請求的 Range，轉給 Drive API（files.get?alt=media），再把 206 回應交回播放器。
// token 只在這個 Service Worker 的記憶體裡；系統把 SW 停掉再叫醒時 token 會不見，
// 這時向頁面要一次（頁面也只放在記憶體）。頁面本體不快取：測試頁每次都要拿最新版。
'use strict';
const INSTANCE = Math.random().toString(36).slice(2, 8);   // 每次 SW 被叫醒都換一個，用來看出「SW 重新啟動過」
const STARTED = Date.now();
let TOKEN = null;
const sizes = new Map();          // 檔案 ID → 總位元組（Drive 不給 Content-Range 時自己組）
let tokenWaiters = [];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'token') {
    TOKEN = m.token || null;
    const w = tokenWaiters; tokenWaiters = [];
    w.forEach((resolve) => resolve(TOKEN));
  } else if (m.type === 'size') {
    sizes.set(m.id, m.size);
  } else if (m.type === 'hello') {
    event.source && event.source.postMessage({ type: 'sw', instance: INSTANCE, startedAt: STARTED, hasToken: !!TOKEN });
  }
});

async function tell(msg) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const c of list) c.postMessage(Object.assign({ instance: INSTANCE }, msg));
}

// 沒有 token（SW 剛被叫醒）：向頁面要，最多等 4 秒
async function needToken() {
  if (TOKEN) return TOKEN;
  const p = new Promise((resolve) => { tokenWaiters.push(resolve); setTimeout(() => resolve(null), 4000); });
  await tell({ type: 'need-token' });
  return p;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(/\/drive-media\/([A-Za-z0-9_-]{10,})$/);
  if (!m) return;                          // 其餘請求照常走網路
  event.respondWith(proxy(event.request, m[1]));
});

async function proxy(req, id) {
  const t0 = Date.now();
  const range = req.headers.get('range');
  const hadToken = !!TOKEN;
  const token = await needToken();
  if (!token) {
    await tell({ type: 'log', range, status: 'no-token', ms: Date.now() - t0 });
    return new Response('no token', { status: 401, headers: { 'X-Probe': 'no-token' } });
  }
  const headers = { Authorization: 'Bearer ' + token };
  if (range) headers.Range = range;
  let res;
  try {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    await tell({ type: 'log', range, status: 'network-error', error: String(e), ms: Date.now() - t0 });
    return new Response('network error', { status: 502 });
  }
  if (res.status === 401 || res.status === 403) await tell({ type: 'unauthorized', status: res.status });
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  // Drive 的 CORS 回應若沒有公開 Content-Range，就用「請求的起點＋這次長度／總長」自己補
  let synthesized = false;
  if (res.status === 206 && !out.has('content-range')) {
    const total = sizes.get(id);
    const len = Number(res.headers.get('content-length'));
    const start = range ? Number((range.match(/bytes=(\d+)-/) || [])[1] || 0) : 0;
    if (total && len) { out.set('content-range', `bytes ${start}-${start + len - 1}/${total}`); synthesized = true; }
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  await tell({
    type: 'log', range, status: res.status, contentRange: out.get('content-range'), synthesized,
    contentType: out.get('content-type'), length: res.headers.get('content-length'),
    tokenFromPage: !hadToken, ms: Date.now() - t0,
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
