// OM Reader——iPhone 唯讀閱讀器（PWA）。
// 資料：從私有資料 repo（GitHub API＋唯讀 token）差異同步進 IndexedDB，之後全程離線讀。
// 本檔不含任何資料、repo 名稱或 token；設定只存在使用者的裝置上。
// 手機上的每個檔與 token 都以 AES-GCM 加密，金鑰由 Face ID 通行金鑰的 PRF 導出、只放在記憶體；
// App 在背景超過 5 分鐘就丟掉金鑰，回來要重新 Face ID。
'use strict';

/* ════════ 小工具 ════════ */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
function svgIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const dec = (p) => p.split('/').map(decodeURIComponent).join('/');
const pageHref = (p) => '#/p/' + enc(p);
function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
function extOf(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1).toLowerCase(); }

/* ════════ IndexedDB ════════ */
const DB_NAME = 'om-reader';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of ['files', 'shas', 'kv']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
      // files：資料包內路徑 → { size, iv, ct }（加密內容）
      // shas ：資料包內路徑 → git blob sha（小，差異比對只讀這個，不碰加密內容）
      // kv   ：設定（token 加密）、開啟鎖、同步狀態
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
async function idbGet(store, key) { const d = await db(); return reqP(d.transaction(store).objectStore(store).get(key)); }
async function idbPut(store, key, val) {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(val, key);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function idbDel(store, key) {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbShaMap() {
  const d = await db();
  const st = d.transaction('shas').objectStore('shas');
  const [keys, vals] = await Promise.all([reqP(st.getAllKeys()), reqP(st.getAll())]);
  return new Map(keys.map((k, i) => [k, vals[i]]));
}
async function idbPutFile(path, sha, rec) {
  const d = await db();
  const tx = d.transaction(['files', 'shas'], 'readwrite');
  tx.objectStore('files').put(rec, path);
  tx.objectStore('shas').put(sha, path);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function idbPutFiles(list) {   // [[key, sha, rec], …] 同一個交易
  const d = await db();
  const tx = d.transaction(['files', 'shas'], 'readwrite');
  for (const [k, sha, rec] of list) { tx.objectStore('files').put(rec, k); tx.objectStore('shas').put(sha, k); }
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function idbDelFile(path) {
  const d = await db();
  const tx = d.transaction(['files', 'shas'], 'readwrite');
  tx.objectStore('files').delete(path);
  tx.objectStore('shas').delete(path);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbFileCount() { const d = await db(); return reqP(d.transaction('shas').objectStore('shas').count()); }
const kvGet = (k) => idbGet('kv', k);
const kvSet = (k, v) => idbPut('kv', k, v);

/* ════════ 加密與開啟鎖 ════════ */
let KEY = null;                      // AES-GCM 金鑰：只在記憶體，不可匯出
const LOCK_AFTER_MS = 5 * 60 * 1000;
const te = new TextEncoder();
const td = new TextDecoder();
function b64u(buf) {
  let s = '';
  for (const c of new Uint8Array(buf)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function deriveKey(prfOut, hkdfSalt) {
  const ikm = await crypto.subtle.importKey('raw', prfOut, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: te.encode('om-reader data v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(buf, key = KEY) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf) };
}
async function open_(rec, key = KEY) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct); }
async function prfFromPasskey(lock) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: unb64u(lock.credId), transports: ['internal', 'hybrid'] }],
    userVerification: 'required', timeout: 60000,
    extensions: { prf: { eval: { first: unb64u(lock.prfSalt) } } },
  } });
  const r = a.getClientExtensionResults().prf;
  if (!r || !r.results || !r.results.first) throw new Error('這個裝置的通行金鑰不支援 PRF，無法導出加密金鑰');
  return r.results.first;
}
async function setupLock() {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'OM Reader' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'om-reader', displayName: 'OM Reader' },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000, attestation: 'none',
    extensions: { prf: { eval: { first: prfSalt } } },
  } });
  const ext = cred.getClientExtensionResults().prf;
  if (!ext || !ext.enabled) throw new Error('這個裝置的通行金鑰不支援 PRF，無法設定加密');
  const lock = { credId: b64u(cred.rawId), prfSalt: b64u(prfSalt), hkdfSalt: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const prf = ext.results && ext.results.first ? ext.results.first : await prfFromPasskey(lock);
  const key = await deriveKey(prf, unb64u(lock.hkdfSalt));
  lock.check = await seal(te.encode('om-reader-ok'), key);
  await kvSet('lock', lock);
  KEY = key;
}
let updateInfo = null;
async function checkUpdates() {
  try {
    if (!navigator.onLine || !KEY) return;
    const plan = await planSync();
    const n = plan.want.length + plan.stale.length;
    updateInfo = n ? { files: n, bytes: plan.textBytes + plan.mediaBytes } : null;
    const slot = document.querySelector('#update-slot');
    if (slot && updateInfo) slot.replaceChildren(updateBanner());
  } catch (e) { /* 沒網路、token 過期：等使用者自己到同步頁看 */ }
}
function updateBanner() {
  return h('a', { class: 'note update-note', href: '#/settings' }, `有新資料：${fmtMB(updateInfo.bytes)}。到「同步」下載。`);
}
async function unlock() {
  const lock = await kvGet('lock');
  const prf = await prfFromPasskey(lock);
  const key = await deriveKey(prf, unb64u(lock.hkdfSalt));
  try { if (td.decode(await open_(lock.check, key)) !== 'om-reader-ok') throw new Error(); }
  catch (e) { throw new Error('金鑰不符：這把通行金鑰不是當初設定的那一把'); }
  KEY = key;
  setTimeout(checkUpdates, 1500);
}
function lockNow() {
  KEY = null;
  resetCaches();   // 也清掉返回快取：上鎖後畫面上不留任何解密過的內容
  releaseBlobUrls();
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (KEY && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) { lockNow(); route(); }
});
async function getConfig() {
  const c = (await kvGet('config')) || {};
  let token = null;
  if (c.tok && KEY) token = td.decode(await open_(c.tok));
  return { repo: c.repo || '', token };
}
async function setConfig(repo, token) {
  await kvSet('config', { repo, tok: token ? await seal(te.encode(token)) : null });
}

/* ════════ 資料來源 ════════ */
class GitHubSource {
  constructor(repo, token) { this.repo = repo; this.token = token; this.rate = null; }
  async api(path, accept) {
    const res = await fetch('https://api.github.com' + path, {
      headers: { Accept: accept || 'application/vnd.github+json', Authorization: 'Bearer ' + this.token, 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    this.rate = { remaining: res.headers.get('x-ratelimit-remaining'), reset: res.headers.get('x-ratelimit-reset') };
    if (!res.ok) {
      const err = new Error(`GitHub HTTP ${res.status}`);
      err.status = res.status;
      err.rateLimited = (res.status === 403 || res.status === 429) && this.rate.remaining === '0';
      throw err;
    }
    return res;
  }
  async tree() {
    const info = await (await this.api(`/repos/${this.repo}`)).json();
    const br = info.default_branch || 'main';
    const t = await (await this.api(`/repos/${this.repo}/git/trees/${encodeURIComponent(br)}?recursive=1`)).json();
    if (t.truncated) throw new Error('檔案樹過大被截斷，需改成分層讀取');
    return { commit: t.sha, entries: t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size })) };
  }
  async blob(entry) {
    const res = await this.api(`/repos/${this.repo}/git/blobs/${entry.sha}`, 'application/vnd.github.raw+json');
    return res.blob();
  }
}
// 開發用：只在 localhost 生效，從同源的 dev-data/ 讀（該目錄不在 repo 內）
class DevSource {
  constructor(base) { this.base = base; this.rate = null; }
  async tree() {
    const t = await (await fetch(this.base + 'tree.json', { cache: 'no-store' })).json();
    return { commit: t.commit, entries: t.entries };
  }
  async blob(entry) {
    const res = await fetch(this.base + entry.path.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
    if (!res.ok) throw new Error('dev HTTP ' + res.status);
    return res.blob();
  }
}
async function getSource() {
  const cfg = await getConfig();
  if (cfg.repo === 'local' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return new DevSource('./dev-data/');
  if (!cfg.repo || !cfg.token) return null;
  return new GitHubSource(cfg.repo, cfg.token);
}

/* ════════ 同步 ════════ */
// 先抓目錄、連結、文字、索引，最後才是圖片與其他二進位：中斷時文字已經可用
function syncPriority(p) {
  if (p === 'catalog.json.gz') return 0;
  if (p === 'links.json.gz') return 1;
  if (p.startsWith('text/') || p.startsWith('packs/t')) return 2;
  if (p.startsWith('index/')) return 3;
  return 4;
}
const isMedia = (p) => p.startsWith('files/') || p.startsWith('packs/m');
const isPack = (p) => p.startsWith('packs/');
const MEMBER = 'm:';          // 包拆出來的檔：以「m:＋原路徑」存，雜湊記在 shas
let catPrefetch = null;       // 檢查更新時已下載的新目錄（同一個 sha 不重抓）
async function hex16(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const BUILD_ONLY = new Set(['imgmap.json', 'build-report.md', 'README.md']);   // 只給建置用，手機不下載
let syncing = false;
// 第一步：比對檔案樹，算出這次要下載多少（還沒下載任何東西）
async function planSync() {
  const src = await getSource();
  if (!src) throw new Error('還沒設定資料來源');
  const tree = await src.tree();
  const commit = tree.commit;
  const entries = tree.entries.filter((e) => !BUILD_ONLY.has(e.path));
  const local = await idbShaMap();
  const remotePaths = new Set(entries.map((e) => e.path));
  const packed = entries.some((e) => isPack(e.path));
  let want, stale;
  if (!packed) {   // 舊版資料包：逐檔比對
    want = entries.filter((e) => local.get(e.path) !== e.sha);
    stale = [...local.keys()].filter((k) => !remotePaths.has(k));
  } else {
    // 第 3 版：先拿到新目錄，依每個檔的內容雜湊決定要抓哪幾包——包裡全是手機已有的內容就不抓
    const catE = entries.find((e) => e.path === 'catalog.json.gz');
    let catBuf = null, meta;
    if (local.get(catE.path) === catE.sha) meta = await gunzipJSON(await fileBlob(catE.path));
    else {
      catBuf = catPrefetch && catPrefetch.sha === catE.sha ? catPrefetch.buf : await (await src.blob(catE)).arrayBuffer();
      catPrefetch = { sha: catE.sha, buf: catBuf };
      meta = await gunzipJSON(new Blob([catBuf]));
    }
    const packs = meta.packs || [];
    const need = new Map(), keep = new Set();
    for (const d of meta.docs) {
      if (!d.x) continue;
      keep.add(MEMBER + d.p);
      if (local.get(MEMBER + d.p) === d.h) continue;
      const pn = 'packs/' + packs[d.x[0]];
      if (!need.has(pn)) need.set(pn, []);
      need.get(pn).push({ p: d.p, h: d.h, x: d.x });
    }
    want = [];
    for (const e of entries) {
      if (e.path === catE.path) { if (catBuf) want.push(Object.assign({}, e, { buf: catBuf })); }
      else if (isPack(e.path)) { if (need.has(e.path)) want.push(Object.assign({}, e, { members: need.get(e.path) })); }
      else if (local.get(e.path) !== e.sha) want.push(e);
    }
    stale = [...local.keys()].filter((k) => (k.startsWith(MEMBER) ? !keep.has(k) : !remotePaths.has(k)));
  }
  want.sort((a, b) => syncPriority(a.path) - syncPriority(b.path));
  const sum = (arr) => arr.reduce((s, e) => s + (e.size || 0), 0);
  const textPart = want.filter((e) => !isMedia(e.path));
  const mediaPart = want.filter((e) => isMedia(e.path));
  return { src, commit, entries, want, stale, packed, textBytes: sum(textPart), mediaBytes: sum(mediaPart),
    requests: want.filter((e) => !e.buf).length, textFiles: textPart.length, mediaFiles: mediaPart.length, rate: src.rate };
}
// 第二步：照計畫下載。textOnly＝先不抓圖片等二進位（流量有限時用），之後再同步會補
async function runSync(plan, { textOnly = false } = {}, onProgress = () => {}) {
  if (syncing) return { busy: true };
  syncing = true;
  try {
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 略過 */ } }
    const { src } = plan;
    const want = textOnly ? plan.want.filter((e) => !isMedia(e.path)) : plan.want;
    const totalBytes = want.reduce((s, e) => s + (e.size || 0), 0);
    let doneBytes = 0, doneFiles = 0, failed = 0, stopErr = null, next = 0;
    onProgress({ doneFiles, totalFiles: want.length, doneBytes, totalBytes });
    const worker = async () => {
      while (!stopErr && next < want.length) {
        const e = want[next++];
        try {
          let buf = e.buf || await (await src.blob(e)).arrayBuffer();
          if (e.members) {   // 包：拆出手機還沒有的檔，逐一驗雜湊、加密，一個交易寫入
            const size = buf.byteLength;
            if (e.path.startsWith('packs/t')) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            const rows = [];
            for (const m of e.members) {
              const part = buf.slice(m.x[1], m.x[1] + m.x[2]);
              if (await hex16(part) !== m.h) throw new Error('內容雜湊不符：' + m.p);
              const sealed = await seal(part);
              rows.push([MEMBER + m.p, m.h, { size: part.byteLength, iv: sealed.iv, ct: sealed.ct }]);
            }
            await idbPutFiles(rows);
            doneBytes += e.size || size;
          } else {
            const sealed = await seal(buf);
            await idbPutFile(e.path, e.sha, { size: buf.byteLength, iv: sealed.iv, ct: sealed.ct });
            doneBytes += e.size || buf.byteLength;
          }
          doneFiles++;
        } catch (err) {
          if (err.rateLimited || err.status === 401 || !KEY) { stopErr = err; break; }
          failed++;
        }
        onProgress({ doneFiles, totalFiles: want.length, doneBytes, totalBytes, failed, rate: src.rate });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    // 舊版的圖片（files/…）在只下載文字時先留著：新版的圖還沒下載前，頁面照樣用舊的顯示
    let removed = 0;
    if (!stopErr) for (const k of plan.stale) if (!(textOnly && k.startsWith('files/'))) { await idbDelFile(k); removed++; }
    const complete = !stopErr && failed === 0;
    const prev = (await kvGet('state')) || {};
    if (complete) {
      await kvSet('state', { commit: plan.commit, syncedAt: Date.now(), files: plan.entries.length,
        pendingMedia: textOnly ? plan.mediaFiles : 0 });
    } else {
      await kvSet('state', Object.assign(prev, { partialAt: Date.now() }));
    }
    resetCaches();
    if (complete) catPrefetch = null;
    return { complete, failed, stopErr, downloaded: doneFiles, removed, rate: src.rate, textOnly };
  } finally { syncing = false; }
}

/* ════════ 資料存取（記憶體快取） ════════ */
let CAT = null;          // { docs, byPath, byName, byStem, built_at, source_commit }
let LINKS = null;        // { out: Map, back: Map }
const shardCache = new Map();
const indexCache = new Map();
let blobUrls = [];   // 目前畫面的 blob URL；畫面進返回快取時整桶帶走
function resetCaches() { CAT = null; LINKS = null; INDEX_META = null; shardCache.clear(); indexCache.clear(); clearViewCache(); }

async function fileBlob(path) {
  const r = await idbGet('files', path);
  if (!r) return null;
  return new Blob([await open_(r)]);
}
async function gunzipJSON(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
async function catalog() {
  if (CAT) return CAT;
  const b = await fileBlob('catalog.json.gz');
  if (!b) return null;
  const meta = await gunzipJSON(b);
  const byPath = new Map(), byName = new Map(), byStem = new Map();
  meta.docs.forEach((d, i) => {
    d.i = i;
    if (d.x && !d.f) d.s = 0;   // 第 3 版的文字檔：沒有分片編號，但其餘畫面以「有 s」判斷是文字
    byPath.set(d.p, d);
    const base = basename(d.p).toLowerCase();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(d);
    if (base.endsWith('.md')) {
      const stem = base.slice(0, -3);
      if (!byStem.has(stem)) byStem.set(stem, []);
      byStem.get(stem).push(d);
    }
  });
  CAT = Object.assign(meta, { byPath, byName, byStem });
  return CAT;
}
async function links() {
  if (LINKS) return LINKS;
  const b = await fileBlob('links.json.gz');
  const out = new Map(Object.entries(b ? await gunzipJSON(b) : {}));
  const back = new Map();
  for (const [src, tgts] of out) for (const t of tgts) {
    if (!back.has(t)) back.set(t, []);
    back.get(t).push(src);
  }
  LINKS = { out, back };
  return LINKS;
}
async function shard(n) {
  if (shardCache.has(n)) return shardCache.get(n);
  const b = await fileBlob(`text/${String(n).padStart(3, '0')}.json.gz`);
  const obj = b ? await gunzipJSON(b) : {};
  if (shardCache.size > 24) shardCache.delete(shardCache.keys().next().value);
  shardCache.set(n, obj);
  return obj;
}
async function docText(d) {
  if (d.x) { const r = await idbGet('files', MEMBER + d.p); return r ? td.decode(await open_(r)) : null; }
  return d.s == null ? null : ((await shard(d.s))[d.p] ?? null);
}
// 圖片與附件：第 3 版在包拆出的那一筆；還沒下載到時，先用舊版資料包留下的 files/…
async function mediaBlob(d) {
  if (!d.x) return fileBlob(d.f);
  return (await fileBlob(MEMBER + d.p)) || fileBlob('files/' + d.f);
}

// wikilink 解析——與 tools/pwa/build.py 的 resolve() 同規則
function resolveLink(target, srcPath) {
  const t = target.trim();
  if (!t) return null;
  const dir = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/') + 1) : '';
  const roots = (CAT.ui && CAT.ui.link_roots) || [];
  for (const base of [...roots, '', dir]) for (const c of [base + t, base + t + '.md']) if (CAT.byPath.has(c)) return CAT.byPath.get(c);
  const tail = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
  const hits = CAT.byName.get(tail) || CAT.byStem.get(tail);
  if (!hits) return null;
  if (hits.length === 1) return hits[0];
  return hits.find((x) => roots.some((r) => x.p.startsWith(r))) || hits[0];
}

/* ════════ Markdown 渲染 ════════ */
if (typeof window.markdownit !== 'function' || !window.DOMPurify) {
  document.body.textContent = '程式沒有載入完整。請把 App 從多工畫面關掉再打開；還是不行就在有網路時打開一次。';
  throw new Error('vendor scripts missing');
}
const md = window.markdownit({ html: true, linkify: true, breaks: true, typographer: false });
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp']);
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const tok = tokens[idx];
  const src = tok.attrGet('src') || '';
  if (src.startsWith('om:')) {
    const alt = self.renderInlineAsText(tok.children, opts, env);
    return `<img data-om="${md.utils.escapeHtml(decodeURIComponent(src.slice(3)))}" alt="${md.utils.escapeHtml(alt)}">`;
  }
  return defaultImage(tokens, idx, opts, env, self);
};
function splitFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: '', body: text };
}
// 把 [[...]] 與 ![[...]] 換成一般 markdown（程式碼區塊內不動）
function convertWikilinks(body, srcPath, fn) {
  if (fn) body = body.replace(/[ \t]+[—–][ \t]+(?=\[\[raw\/)/g, ' ');
  const parts = body.split(/(^[ \t]*(?:```|~~~)[\s\S]*?^[ \t]*(?:```|~~~)[^\n]*$|`[^`\n]*`)/m);
  return parts.map((seg, i) => {
    if (i % 2 === 1) return seg;
    return seg.replace(/(!?)\[\[([^\]|#^]*)((?:[#^][^\]|]*)?)(?:\|([^\]]*))?\]\]/g, (all, bang, target, anchor, alias) => {
      const d = resolveLink(target, srcPath);
      const label = (alias || target + (anchor || '')).replace(/[[\]]/g, '');
      if (!d) return `<span class="wl-missing">${md.utils.escapeHtml(label || target)}</span>`;
      const ext = extOf(d.p);
      if (bang && IMG_EXT.has(ext)) return `![${label.replace(/[[\]]/g, '')}](om:${encodeURIComponent(d.p)})`;
      if (bang && (ext === 'mp4' || ext === 'mov')) return `<video data-om="${md.utils.escapeHtml(d.p)}" controls playsinline preload="metadata"></video>`;
      if (fn && d.l === 'raw' && !bang) {   // 概念頁、人物頁：引用 raw 的地方改成上標編號註腳
        if (!fn.map.has(d.p)) fn.map.set(d.p, fn.map.size + 1);
        return `<sup class="fn"><a href="${pageHref(d.p)}">${fn.map.get(d.p)}</a></sup>`;
      }
      const title = d.t || basename(d.p).replace(/\.md$/, '');
      return `[${(alias || title).replace(/[[\]]/g, '')}](${pageHref(d.p)})`;
    });
  }).join('');
}
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:/i.test(href)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  }
});
// 逐字稿：每行開頭的 [hh:mm:ss] 獨立成段、時間戳另起一行；摘要裡的時間點可以點，跳到逐字稿那一段
const TS_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*/gm;
function tsSec(a, b, c) { return (+a) * 3600 + (+b) * 60 + (+c); }
function formatTranscript(body) {
  if ((body.match(TS_LINE) || []).length < 5) return body;
  return body.replace(TS_LINE, (m, a, b, c) => `\n\n<span class="ts" data-ts="${tsSec(a, b, c)}">${a}:${b}:${c}</span>\n`);
}
function renderMarkdown(body, srcPath, fn) {
  const html = md.render(convertWikilinks(formatTranscript(body), srcPath, fn));
  const frag = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    ADD_TAGS: ['video'], ADD_ATTR: ['controls', 'playsinline', 'preload', 'target', 'data-ts'],
  });
  const wrap = h('div', { class: 'md' });
  wrap.append(frag);
  // 摘要裡的「[00:03:18]」：有逐字稿段落時變成可點的跳轉
  const stamps = [...wrap.querySelectorAll('.ts[data-ts]')];
  if (stamps.length) {
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\[\d{2}:\d{2}:\d{2}\]/.test(n.nodeValue)) hits.push(n);
    for (const n of hits) {
      const frag2 = document.createDocumentFragment();
      n.nodeValue.split(/(\[\d{2}:\d{2}:\d{2}\])/).forEach((part, k) => {
        if (!(k % 2)) { if (part) frag2.append(part); return; }
        const [a, b, c] = part.slice(1, -1).split(':');
        const sec = tsSec(a, b, c);
        frag2.append(h('button', { type: 'button', class: 'ts-jump', onclick: () => {
          const target = stamps.find((x) => +x.dataset.ts >= sec) || stamps[stamps.length - 1];
          target.scrollIntoView({ block: 'center' });
          target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1600);
        } }, part.slice(1, -1)));
      });
      n.replaceWith(frag2);
    }
  }
  // 圖片點了全螢幕
  wrap.querySelectorAll('img').forEach((im) => im.addEventListener('click', () => zoomImage(im)));
  wrap.querySelectorAll('table').forEach((t) => { const w = h('div', { class: 'table-wrap' }); t.replaceWith(w); w.append(t); });
  return wrap;
}
// 圖片與影片：捲到附近才解密（長頁不必一次解完所有圖）
async function hydrateOne(el, bucket) {
  const d = CAT && CAT.byPath.get(el.getAttribute('data-om'));
  if (!d || !d.f) return;
  const b = await mediaBlob(d);
  if (!b) { if (el.tagName === 'IMG') el.alt = (el.alt || '') + '（圖片尚未同步）'; return; }
  const url = URL.createObjectURL(new Blob([b], { type: mimeOf(d.f) }));
  bucket.push(url);
  el.src = url;
}
function hydrateMedia(root) {
  const bucket = blobUrls;
  const els = [...root.querySelectorAll('[data-om]')];
  if (!('IntersectionObserver' in window)) { els.forEach((el) => hydrateOne(el, bucket)); return; }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); hydrateOne(en.target, bucket); }
  }, { rootMargin: '1200px 0px' });
  els.forEach((el) => io.observe(el));
}
function zoomImage(im) {
  if (!im.src) return;
  const big = h('img', { src: im.src, alt: im.alt || '' });
  const box = h('div', { class: 'zoom', role: 'dialog', 'aria-label': '圖片' },
    h('button', { type: 'button', class: 'btn zoom-close', onclick: () => box.remove() }, '關閉'), h('div', { class: 'zoom-scroll' }, big));
  document.body.append(box);
}
// 頁內大綱：三個以上 ## / ### 才出現；點了捲到該處（hash 給路由用，不用 #id 錨點）
function outline(mdRoot) {
  const hs = [...mdRoot.querySelectorAll('h2, h3')];
  if (hs.length < 3) return null;
  const list = h('ol', { class: 'toc-list' });
  hs.forEach((x) => {
    list.append(h('li', { class: x.tagName === 'H3' ? 'sub' : null },
      h('button', { type: 'button', class: 'toc-link', onclick: () => x.scrollIntoView({ block: 'start' }) }, x.textContent)));
  });
  return h('details', { class: 'toc' }, h('summary', null, `目錄（${hs.length}）`), list);
}
function releaseBlobUrls() { while (blobUrls.length) URL.revokeObjectURL(blobUrls.pop()); }

/* ════════ 搜尋 ════════ */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const WORD_RE = /[a-z0-9][a-z0-9_\-.]*[a-z0-9]|[a-z0-9]/g;
function queryTokens(q) {
  const t = q.toLowerCase();
  const out = new Set();
  for (const run of t.match(CJK_RE) || []) {
    if (run.length === 1) out.add(run);
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  for (const w of t.match(WORD_RE) || []) if (w.length >= 2) out.add(w);
  return [...out];
}
function fnv1a(s) {  // 與 build.py 的 index_shard_of() 同算法（UTF-16 碼元）
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
let INDEX_META = null;   // { baseDocs: string[], delta: {docs, stale, idx}, staleSet }
async function indexMeta() {
  if (INDEX_META) return INDEX_META;
  const b = await fileBlob('index/base.json.gz');
  const d = await fileBlob('index/delta.json.gz');
  if (!b) return null;
  const base = await gunzipJSON(b);
  const delta = d ? await gunzipJSON(d) : { docs: [], stale: [], idx: {} };
  INDEX_META = { baseDocs: base.docs.map((x) => x[0]), shards: base.shards, delta, staleSet: new Set(delta.stale) };
  return INDEX_META;
}
async function indexShard(k) {
  if (indexCache.has(k)) return indexCache.get(k);
  const b = await fileBlob(`index/b-${String(k).padStart(2, '0')}.json.gz`);
  const obj = b ? await gunzipJSON(b) : {};
  indexCache.set(k, obj);
  return obj;
}
function decodePostings(s) {
  const out = [];
  let prev = 0;
  for (const part of s.split(',')) { prev += parseInt(part, 36); out.push(prev); }
  return out;
}
// 回傳命中的文件路徑集合：基底索引（剔除之後改過或刪掉的）＋ delta 索引
async function search(q) {
  const toks = queryTokens(q);
  if (!toks.length) return { paths: [], toks };
  const im = await indexMeta();
  if (!im) return { paths: [], toks };
  let acc = null;
  for (const t of toks) {
    const hit = new Set();
    const shardObj = await indexShard(fnv1a(t) % im.shards);
    if (shardObj[t]) for (const i of decodePostings(shardObj[t])) {
      const p = im.baseDocs[i];
      if (!im.staleSet.has(p)) hit.add(p);
    }
    if (im.delta.idx[t]) for (const i of decodePostings(im.delta.idx[t])) hit.add(im.delta.docs[i]);
    acc = acc ? new Set([...acc].filter((p) => hit.has(p))) : hit;
    if (!acc.size) break;
  }
  return { paths: [...(acc || [])], toks };
}
// 摘要：先去掉 markdown 記號，再取第一個詞附近的一段，所有查詢詞都標記
function plainText(text) {
  return splitFrontmatter(text).body
    .replace(/!\[\[[^\]]*\]\]/g, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*_`~]{1,3}/g, '').replace(/\s+/g, ' ');
}
function snippet(text, terms) {
  const body = plainText(text);
  const low = body.toLowerCase();
  const hits = terms.map((t) => low.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  if (hits.length < terms.length) return null;
  const i = Math.min(...hits);
  const start = Math.max(0, i - 30);
  const piece = (start > 0 ? '…' : '') + body.slice(start, i + 90) + (i + 90 < body.length ? '…' : '');
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return piece.split(new RegExp(`(${esc})`, 'ig')).map((part, k) => (k % 2 ? h('mark', null, part) : part));
}

/* ════════ 區塊名稱 ════════ */
// 區塊名稱與排序來自資料包（catalog.ui），公開的程式殼裡不寫內容結構
const laneName = (l) => l;   // 區塊一律以資料夾名顯示（本人 2026-11-03）
const laneLabel = (l) => (CAT && CAT.ui && CAT.ui.lane_labels && CAT.ui.lane_labels[l]) || '';
const laneFull = (l) => (laneLabel(l) ? `${l}・${laneLabel(l)}` : l);
const laneOrder = () => (CAT && CAT.ui && CAT.ui.lane_order) || [];
function docMeta(d) {
  const bits = [laneName(d.l)];
  if (d.ar) bits.push(d.ar);
  if (d.d && !docTitle(d).includes(String(d.d).slice(0, 10))) bits.push(String(d.d).slice(0, 10));
  if (d.a) bits.push(d.a);
  if (d.unrev) bits.push('未審');
  return bits.join('　');
}
function docTitle(d) { return d.t || basename(d.p); }
// 只有領域地圖上色：顏色＝本人在 Notion Category 選單上設的顏色（catalog.ui.area_dyes，依領域頁路徑）。
// 其他地方一律中性色，重點色用紫（本人 2026-11-02）。
function dyeOf(area) { return area && CAT && CAT.ui && CAT.ui.area_dyes ? CAT.ui.area_dyes[area] : null; }
function areaColor(el, d, area) {
  const dye = dyeOf(area || (d && d.ar));
  if (dye) { el.style.setProperty('--fam', `var(--dye-${dye})`); el.style.setProperty('--fam-ink', `var(--ink-${dye})`); el.classList.add('has-area'); }
  return el;
}
// 領域 chip：方點＋名稱，有 MOC 頁就可點（顏色一定和名稱一起出現，不單靠顏色）
function areaChip(area) {
  const page = CAT && CAT.ui && CAT.ui.area_pages && CAT.ui.area_pages[area];
  const el = page ? h('a', { class: 'tag area-tag', href: pageHref(page) }, h('span', { class: 'dot' }), area)
    : h('span', { class: 'tag area-tag' }, h('span', { class: 'dot' }), area);
  return areaColor(el, null, area);
}
let restoreOnOpen = null;   // 從「繼續看／看過」點進去時，回到上次讀到的位置
function itemLink(d, extra, opts) {
  const a = h('a', { class: 'item', href: pageHref(d.p) },
    h('span', { class: 't' }, docTitle(d)), h('span', { class: 'm' }, docMeta(d)), extra || null);
  if (opts && opts.resume) a.addEventListener('click', () => { restoreOnOpen = d.p; });
  return h('li', null, areaColor(a, d));
}
function listOf(items, emptyText) {
  const ul = h('ul', { class: 'list' }, items);
  if (!items.length) ul.append(h('li', { class: 'empty' }, emptyText || '沒有內容'));
  return ul;
}
function secTitle(text, linkHref, linkText) {
  return h('div', { class: 'sec-title' }, h('span', null, text), linkHref ? h('a', { href: linkHref }, linkText) : null);
}
function laneCounts(cat) {
  const counts = new Map();
  for (const d of cat.docs) if (d.s != null || /\.(pdf|html?|mp4)$/i.test(d.p)) counts.set(d.l, (counts.get(d.l) || 0) + 1);
  return counts;
}

/* ════════ 看過（存在 kv、加密） ════════ */
async function getHistory() {
  const rec = await kvGet('history');
  if (!rec || !KEY) return [];
  try { return JSON.parse(td.decode(await open_(rec))); } catch (e) { return []; }
}
async function pushHistory(p) {
  const old = await getHistory();
  const prevEntry = old.find((x) => x.p === p);
  const list = old.filter((x) => x.p !== p);
  list.unshift({ p, at: Date.now(), y: prevEntry ? prevEntry.y : 0 });
  await kvSet('history', await seal(te.encode(JSON.stringify(list.slice(0, 100)))));
}
async function savePos(p, y) {
  const list = await getHistory();
  const e = list.find((x) => x.p === p);
  if (!e || Math.abs((e.y || 0) - y) < 200) return;
  e.y = Math.round(y);
  await kvSet('history', await seal(te.encode(JSON.stringify(list))));
}

/* ════════ 畫面 ════════ */
function setView(...kids) {
  view.replaceChildren(...kids.filter((k) => k != null));
  window.scrollTo(0, 0);
}
// 返回快取：文章、清單、搜尋、分類離開時把整個畫面（含展開筆數、篩選、捲動位置）留著，回來直接還原
const viewCache = new Map();
let curHash = null;
const CACHEABLE = /^#\/(p|l|s|c)\/|^#\/browse/;
function stashView() {
  if (curHash && curHash.startsWith('#/p/') && KEY) savePos(dec(curHash.slice(4)), window.scrollY).catch(() => {});
  if (curHash && CACHEABLE.test(curHash) && view.childNodes.length) {
    viewCache.delete(curHash);
    viewCache.set(curHash, { nodes: [...view.childNodes], scroll: window.scrollY, urls: blobUrls });
    blobUrls = [];
    while (viewCache.size > 8) {
      const [k, v] = viewCache.entries().next().value;
      v.urls.forEach((u) => URL.revokeObjectURL(u));
      viewCache.delete(k);
    }
  } else releaseBlobUrls();
}
function restoreView(hash) {
  const c = viewCache.get(hash);
  if (!c) return false;
  viewCache.delete(hash);
  view.replaceChildren(...c.nodes);
  blobUrls = c.urls;
  requestAnimationFrame(() => window.scrollTo(0, c.scroll));
  return true;
}
function clearViewCache() {
  for (const v of viewCache.values()) v.urls.forEach((u) => URL.revokeObjectURL(u));
  viewCache.clear();
}
function emptyState() {
  setView(h('h1', null, '還沒有資料'),
    h('p', null, '先到設定填入資料 repo 與唯讀 token，再按「檢查更新」。第一次全部下載約 300 MB，建議在 Wi-Fi 下進行；流量有限時可以先只下載文字。'),
    h('a', { class: 'btn primary', href: '#/settings' }, '前往設定'));
}

async function viewHome() {
  const cat = await catalog();
  if (!cat) return emptyState();
  const ui = cat.ui || {};
  const kids = [h('div', { id: 'update-slot' }, updateInfo ? updateBanner() : null)];
  const st = (await kvGet('state')) || {};
  if (st.files) {
    const have = await idbFileCount();
    const missing = st.files - (st.pendingMedia || 0) - have;
    if (missing > 0) kids.push(h('p', { class: 'note' }, `手機上少了 ${missing} 個檔（可能被系統清掉了）。到「同步」按「檢查更新」就會補回來。`));
  }
  // 繼續看
  const hist = (await getHistory()).map((x) => cat.byPath.get(x.p)).filter(Boolean).slice(0, 3);
  if (hist.length) kids.push(secTitle('繼續看', '#/history', '全部'), listOf(hist.map((d) => itemLink(d, null, { resume: true }))));
  // 領域地圖：讀 catalog.ui.home_map 指定的頁面裡「### 名稱 → [[頁面]] 說明」的行
  const idx = ui.home_map ? cat.byPath.get(ui.home_map) : null;
  if (idx) {
    const text = await docText(idx);
    const tiles = [];
    for (const line of (text || '').split('\n')) {
      const m = /^###\s+(.+?)\s*→\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*(.*)$/.exec(line);
      if (!m) continue;
      const d = resolveLink(m[2], idx.p);
      if (!d) continue;
      tiles.push(areaColor(h('a', { class: 'tile area', href: pageHref(d.p) }, h('span', { class: 't' }, m[1].trim()),
        h('span', { class: 'm' }, m[3].replace(/^[●○⊡]\s*/, ''))), d));
    }
    if (tiles.length) kids.push(secTitle('領域地圖'), h('div', { class: 'grid' }, tiles));
  }
  // 最近新增
  const skip = new Set(ui.recent_exclude || []);
  const recent = cat.docs.filter((d) => d.d && d.p.endsWith('.md') && !skip.has(d.l))
    .sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 12);
  const changed = cat.docs.filter((d) => d.m && d.s != null && !skip.has(d.l)).sort((a, b) => String(b.m).localeCompare(String(a.m)));
  if (changed.length) kids.push(secTitle(`最近更新（${changed[0].m}）`), listOf(changed.slice(0, 12).map((d) => itemLink(d))));
  kids.push(secTitle('最近新增'), listOf(recent.map((d) => itemLink(d))));
  if (st.syncedAt) kids.push(h('p', { class: 'muted more' }, `資料版本 ${String(cat.source_commit || '').slice(0, 7)}・同步於 ${new Date(st.syncedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })}`));
  setView(...kids);
}

async function viewBrowse() {
  const cat = await catalog();
  if (!cat) return emptyState();
  const counts = laneCounts(cat);
  const order = laneOrder();
  const byOrder = (a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || laneName(a).localeCompare(laneName(b));
  };
  // 分組＝repo 原本的資料夾（catalog.ui.lane_groups，建置時從實際路徑算出；不另立分類系統）
  const groupList = ((cat.ui && cat.ui.lane_groups) || [{ name: '全部', lanes: [...counts.keys()] }]);
  const nText = cat.docs.filter((d) => d.s != null).length;
  const nFiles = cat.docs.filter((d) => d.f).length;
  const kids = [h('h1', null, '分類'), h('p', { class: 'page-sub' }, `${nText.toLocaleString()} 則文字・${nFiles.toLocaleString()} 個圖片與附件`)];
  for (const g of groupList) {
    const lanes = g.lanes.filter((l) => counts.has(l)).sort(byOrder);
    if (!lanes.length) continue;
    const rows = listOf(lanes.map((l) => h('li', null, h('a', { class: 'item', href: '#/l/' + enc(l) },
      h('span', { class: 't' }, laneName(l)), h('span', { class: 'm' }, `${laneLabel(l) ? laneLabel(l) + '・' : ''}${counts.get(l).toLocaleString()} 則`)))));
    if (g.name === '/') kids.push(h('details', { class: 'aux' }, h('summary', null, `/（repo 根目錄下的資料夾，${lanes.length} 個）`), rows));
    else kids.push(secTitle(g.name), rows);
  }
  setView(...kids);
}

async function viewCourse(ci) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const c = ((cat.ui && cat.ui.courses) || [])[ci];
  if (!c) return setView(h('h1', null, '找不到這門課'));
  const head = areaColor(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/l/' + enc('self/resources') }, 'self/resources')), h('h1', null, c.t)), null, c.cat);
  const kids = [head, h('div', { class: 'chips' }, c.cat ? areaChip(c.cat) : null, h('span', { class: 'tag' }, `${c.lessons.length} 講`))];
  if (c.digests.length) kids.push(secTitle('課程摘錄'), listOf(c.digests.map((p) => cat.byPath.get(p)).filter(Boolean).map((x) => itemLink(x))));
  if (c.notes.length) kids.push(secTitle('我的筆記'), listOf(c.notes.map((p) => cat.byPath.get(p)).filter(Boolean).map((x) => itemLink(x))));
  kids.push(secTitle('逐字稿'), h('ol', { class: 'list lessons' }, c.lessons.map((l) => {
    const d = cat.byPath.get(l.p);
    return h('li', null, h('a', { class: 'item', href: pageHref(l.p) }, h('span', { class: 't' }, `${l.o ? l.o + '　' : ''}${l.t}`),
      h('span', { class: 'm' }, l.ho.length ? `有講義・${d && d.n ? Math.round(d.n / 1000) + 'k 字' : ''}` : (d && d.n ? Math.round(d.n / 1000) + 'k 字' : ''))));
  })));
  if (c.handouts.length) kids.push(h('details', { class: 'aux' }, h('summary', null, `講義（${c.handouts.length}）`), listOf(c.handouts.map((p) => cat.byPath.get(p)).filter(Boolean).map((x) => itemLink(x)))));
  setView(...kids);
}

async function viewHistory() {
  const cat = await catalog();
  if (!cat) return emptyState();
  const hist = (await getHistory()).map((x) => [cat.byPath.get(x.p), x.at]).filter((x) => x[0]);
  const clear = h('button', { type: 'button', class: 'btn quiet' }, '清除紀錄');
  clear.addEventListener('click', async () => { await kvSet('history', await seal(te.encode('[]'))); viewHistory(); });
  const dayKey = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = dayKey(Date.now());
  const label = (k) => (k === today ? '今天' : k === today - 86400000 ? '昨天' : new Date(k).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }));
  const groups = new Map();
  for (const [d, at] of hist) { const k = dayKey(at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push([d, at]); }
  const kids = [h('h1', null, '看過'), h('p', { class: 'page-sub' }, '最近打開過的 100 頁，只存在這支手機（加密）。')];
  if (!hist.length) kids.push(h('p', { class: 'empty-box' }, '還沒有看過任何一頁。'));
  for (const [k, xs] of groups) kids.push(secTitle(label(k)), listOf(xs.map(([d, at]) => itemLink(d, h('span', { class: 'm' }, new Date(at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })), { resume: true }))));
  if (hist.length) kids.push(h('div', { class: 'row' }, clear));
  setView(...kids);
}

const isAux = (d) => /^_/.test(basename(d.p)) || basename(d.p) === 'index.md' || /\.(json|jsonl)$/.test(d.p);
async function viewLane(arg) {
  const [lane, qs] = arg.split('?');
  const params = new URLSearchParams(qs || '');
  const cat = await catalog();
  if (!cat) return emptyState();
  const ui = cat.ui || {};
  if (lane === 'self/resources' && (ui.courses || []).length && !params.has('all')) return viewCourses(cat, lane);
  const all = cat.docs.filter((d) => d.l === lane && (d.s != null || /\.(pdf|html?|mp4)$/i.test(d.p)));
  let docs = all.filter((d) => !isAux(d));
  const aux = all.filter(isAux);
  const pinned = (ui.pinned || []).map((p) => cat.byPath.get(p)).filter((d) => d && d.l === lane);
  const dated = docs.filter((d) => d.d).length >= docs.length * 0.6;
  if (dated) docs.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || a.p.localeCompare(b.p));
  else docs.sort((a, b) => docTitle(a).localeCompare(docTitle(b), 'zh-Hant'));
  docs = pinned.concat(docs.filter((d) => !pinned.includes(d)));
  const head = h('div', { class: 'doc-head' }, h('h1', null, laneName(lane)));
  const sub = h('p', { class: 'page-sub' });
  const list = h('ul', { class: 'list' });
  const more = h('button', { class: 'btn more', type: 'button' }, '再多 100 則');
  const filters = h('div', { class: 'filter-row' });
  const state = { year: params.get('y'), written: lane === ui.journal_lane, area: null };
  let pool = docs, shown = 0;
  const apply = () => {
    pool = docs.filter((d) => (!state.year || String(d.d || '').startsWith(state.year))
      && (!state.written || lane !== ui.journal_lane || d.w) && (!state.area || (d.areas || [d.ar]).includes(state.area)));
    list.replaceChildren(); shown = 0; add();
    sub.textContent = `${laneLabel(lane) ? laneLabel(lane) + '・' : ''}${pool.length.toLocaleString()} 則・${dated ? '新到舊' : '依名稱'}`;
  };
  const add = () => {
    for (const d of pool.slice(shown, shown + 100)) list.append(itemLink(d));
    shown = Math.min(pool.length, shown + 100);
    more.hidden = shown >= pool.length;
    if (!pool.length) list.append(h('li', { class: 'empty' }, '沒有符合的項目'));
  };
  more.addEventListener('click', add);
  const chip = (label, on, fnc) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(!!on), onclick: (e) => { fnc(); filters.querySelectorAll('button').forEach((b) => { if (b.dataset.g === e.currentTarget.dataset.g) b.setAttribute('aria-pressed', 'false'); }); e.currentTarget.setAttribute('aria-pressed', 'true'); apply(); } }, label);
  if (lane === ui.journal_lane) {   // 日記：只看有手寫內容的日子、跳年份
    const w = h('button', { type: 'button', class: 'filter', 'aria-pressed': 'true', onclick: (e) => { state.written = !state.written; e.currentTarget.setAttribute('aria-pressed', String(state.written)); apply(); } }, '只看有手寫內容');
    const years = [...new Set(docs.map((d) => String(d.d || '').slice(0, 4)).filter(Boolean))].sort().reverse();
    const yc = [chip('全部年份', !state.year, () => { state.year = null; }), ...years.map((y) => chip(y, state.year === y, () => { state.year = y; }))];
    yc.forEach((b) => { b.dataset.g = 'y'; });
    filters.append(w, ...yc);
  } else if (docs.some((d) => d.areas && d.areas.length)) {   // 論點卡：依 16 領域（卡片自己的 areas）
    const counts = new Map();
    docs.forEach((d) => (d.areas || []).forEach((a) => counts.set(a, (counts.get(a) || 0) + 1)));
    const ac = [chip(`全部 ${docs.length}`, true, () => { state.area = null; }),
      ...[...counts].sort((a, b) => b[1] - a[1]).map(([a, n]) => areaColor(chip(`${a} ${n}`, false, () => { state.area = a; }), null, a))];
    ac.forEach((b) => { b.dataset.g = 'a'; if (b.classList.contains('has-area')) b.prepend(h('span', { class: 'dot' })); });
    filters.append(...ac);
  }
  const auxBox = aux.length ? h('details', { class: 'aux' }, h('summary', null, `總覽與附檔（${aux.length}）`), listOf(aux.map((d) => itemLink(d)))) : null;
  setView(head, filters.childElementCount ? filters : null, sub, list, more, auxBox);
  apply();
}
// 學習筆記：照既有的課程索引（_courses.json）分課程，課程內照講次
function viewCourses(cat, lane) {
  const cs = cat.ui.courses;
  const byCat = new Map();
  cs.forEach((c, i) => { const k = c.cat || '其他'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push([c, i]); });
  const inCourse = new Set(cs.flatMap((c) => [...c.lessons.map((l) => l.p), ...c.handouts, ...c.notes]));
  const loose = cat.docs.filter((d) => d.l === lane && d.s != null && !inCourse.has(d.p) && !isAux(d));
  const kids = [h('div', { class: 'doc-head' }, h('h1', null, laneName(lane))), h('p', { class: 'page-sub' }, `${laneLabel(lane) ? laneLabel(lane) + '・' : ''}${cs.length} 門課・${cs.reduce((n, c) => n + c.lessons.length, 0)} 講・依課程`)];
  for (const [k, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
    kids.push(h('div', { class: 'sec-title' }, h('span', null, areaColor(h('span', { class: 'sec-dot' }), null, k), k)),
      listOf(list.map(([c, i]) => h('li', null, areaColor(h('a', { class: 'item', href: '#/c/' + i }, h('span', { class: 't' }, c.t),
        h('span', { class: 'm' }, `${c.lessons.length} 講${c.handouts.length ? `・講義 ${c.handouts.length}` : ''}${c.notes.length ? `・我的筆記 ${c.notes.length}` : ''}`)), null, c.cat)))));
  }
  if (loose.length) kids.push(h('details', { class: 'aux' }, h('summary', null, `不屬於任何課程（${loose.length}）`), listOf(loose.map((d) => itemLink(d)))));
  kids.push(h('p', { class: 'muted more' }, h('a', { href: '#/l/' + enc(lane) + '?all=1' }, '改看全部檔案清單')));
  setView(...kids);
}

// iPhone 實測：www.notion.so 的連結會直接叫起 Notion App（2026-11-02）
const notionUrl = (nid) => `https://www.notion.so/${nid}`;
function notionButtons(nid) {
  return [h('a', { class: 'btn', href: notionUrl(nid), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), 'Notion')];
}

async function viewPage(path) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const d = cat.byPath.get(path);
  if (!d) return setView(h('h1', null, '找不到這一頁'), h('p', { class: 'muted' }, path));
  const crumb = h('nav', { class: 'crumb', 'aria-label': '所在位置' }, h('a', { href: '#/l/' + enc(d.l) }, laneFull(d.l)));
  const title = h('h1', { class: docTitle(d).length > 28 ? 'long' : null }, docTitle(d));
  const head = areaColor(h('div', { class: 'doc-head' }, crumb, title), d);
  const areas = d.areas && d.areas.length ? d.areas : (d.ar && !/^vault\/wiki\/MOC\//.test(d.p) ? [d.ar] : []);
  const ns = d.ns && cat.ui && cat.ui.nonself ? cat.ui.nonself[d.ns] : null;
  const chips = h('div', { class: 'chips' }, areas.map(areaChip), [d.d && String(d.d).slice(0, 10), d.a, d.src, d.l === 'self/cards' && d.prov && `來源：${d.prov}`]
    .filter(Boolean).map((x) => h('span', { class: 'tag' }, x)), ns ? h('span', { class: 'tag ns' }, ns) : null,
    d.unrev ? h('span', { class: 'tag warn' }, '未審') : null,
    d.st === 'raw' ? h('span', { class: 'tag ns' }, '還沒折進 wiki') : null);
  pushHistory(d.p).catch(() => {});
  const actions = h('div', { class: 'doc-actions' });
  if (d.nid) actions.append(...notionButtons(d.nid));
  if (d.u && /^https?:/i.test(d.u) && !/(^|\.)notion\.(so|site|com)\//i.test(d.u.replace(/^https?:\/\//, ''))) actions.append(h('a', { class: 'btn', href: d.u, target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '原文'));
  const body = h('div');
  const ext = extOf(d.p);
  if (d.s != null) {
    const text = await docText(d);
    if (text == null) body.append(h('p', { class: 'note' }, '這一頁的內容還沒同步。'));
    else if (ext === 'md') {
      const fn = /^wiki\/(concepts|people)$/.test(d.l) ? { map: new Map() } : null;
      const mdRoot = renderMarkdown(splitFrontmatter(text).body, d.p, fn);
      const pageDye = dyeOf(d.ar);
      if (pageDye) mdRoot.style.setProperty('--link-line', `var(--ink-${pageDye})`);
      d._fn = fn;
      labelSections(mdRoot, d);
      foldRoutingRules(mdRoot, d);
      const toc = outline(mdRoot);
      if (toc) body.append(toc);
      body.append(mdRoot);
    }
    else if (ext === 'csv' || ext === 'tsv') body.append(csvTable(text, ext === 'tsv' ? '\t' : ','));
    else body.append(h('pre', { class: 'raw' + (ext === 'txt' || ext === 'jsonl' ? ' wrap' : '') }, text));
  } else if (d.f) {
    const b = await mediaBlob(d);
    if (!b) body.append(h('p', { class: 'note' }, '這個檔案還沒同步。'));
    else {
      const typed = new Blob([b], { type: mimeOf(d.f) });
      const url = URL.createObjectURL(typed);
      blobUrls.push(url);
      if (IMG_EXT.has(extOf(d.f))) body.append(h('img', { class: 'media-full', src: url, alt: '' }));
      else if (['mp4', 'mov'].includes(ext)) body.append(h('video', { class: 'media-full', src: url, controls: true, playsinline: true }));
      else if (ext === 'html' || ext === 'htm') {
        const online = cat.ui && cat.ui.html_online && cat.ui.html_online[d.p];
        if (online) actions.append(h('a', { class: 'btn', href: online, target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '開線上版'));
        const frame = await htmlFrame(b);
        const ttl = ((await b.text()).match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1];
        if (ttl) title.textContent = ttl.trim();
        actions.append(h('button', { type: 'button', class: 'btn', onclick: () => { frame.classList.add('full'); closeFull.hidden = false; } }, '全螢幕'));
        const closeFull = h('button', { type: 'button', class: 'btn full-close', hidden: true, onclick: () => { frame.classList.remove('full'); closeFull.hidden = true; } }, '關閉全螢幕');
        body.append(frame, closeFull, h('p', { class: 'muted' }, 'HTML 頁在隔離框架中執行，讀不到 App 的資料，也不會連到外部網站（地圖圖磚這類線上資源不顯示）。'));
      }
      else body.append(h('div', { class: 'card file-card' }, h('div', { class: 'file-ext' }, ext.toUpperCase() || '檔案'),
        h('div', { class: 'file-meta' }, h('div', { class: 't' }, basename(d.p)), h('div', { class: 'muted' }, fmtMB(b.size))),
        h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, ext === 'pdf' ? '打開 PDF' : '打開檔案')));
    }
  }
  const kids = [head, chips];
  if (actions.childElementCount) kids.push(actions);
  const nav = docNav(d);
  if (nav) kids.push(nav);
  kids.push(body);
  if (nav) kids.push(docNav(d));
  // 來源（論點卡的 sources、概念頁引用的 raw）與反向連結
  const L = await links();
  if (d._fn && d._fn.map.size) {   // 註腳：照正文出現順序編號
    const ordered = [...d._fn.map.entries()].sort((a, b) => a[1] - b[1]).map(([p, n]) => [cat.byPath.get(p), n]).filter((x) => x[0]);
    kids.push(secTitle(`來源（${ordered.length}）`), h('ol', { class: 'list fn-list' }, ordered.map(([x, n]) => itemLink(x, null).firstChild ? h('li', { value: n }, itemLink(x).firstChild) : null)));
  } else {
    const outs = (L.out.get(d.p) || []).map((p) => cat.byPath.get(p)).filter((x) => x && x.nid && x.p !== d.p);
    if (outs.length && !d.nid) kids.push(secTitle(`引用的來源（${outs.length}）`), listOf(outs.slice(0, 60).map((x) => itemLink(x))));
  }
  if (d.l === 'wiki/people') {   // 人物頁：此作者的原始筆記（raw 的 author 對上人物頁的 handle 或名字）
    const keys = [d.hd, docTitle(d)].filter(Boolean).map((k) => String(k).toLowerCase().replace(/^@/, ''));
    const own = cat.docs.filter((x) => x.l === 'raw' && x.a && keys.some((k) => String(x.a).toLowerCase().replace(/^@/, '').includes(k)))
      .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
    if (own.length) kids.push(h('details', { class: 'aux', open: own.length <= 8 }, h('summary', null, `此作者的原始筆記（${own.length}）`), listOf(own.slice(0, 200).map((x) => itemLink(x)))));
  }
  const mocArea = (d.p.match(/^vault\/wiki\/MOC\/(.+)\.md$/) || [])[1];
  if (mocArea) kids.push(...areaExtras(cat, mocArea));
  const backs = (L.back.get(d.p) || []).map((p) => cat.byPath.get(p)).filter(Boolean);
  if (backs.length) kids.push(secTitle(`被引用（${backs.length}）`), listOf(backs.slice(0, 200).map((x) => itemLink(x))));
  setView(...kids);
  hydrateMedia(view);
  if (restoreOnOpen === d.p) {
    restoreOnOpen = null;
    const e = (await getHistory()).find((x) => x.p === d.p);
    if (e && e.y) requestAnimationFrame(() => window.scrollTo(0, e.y));
  }
}
// 非本人陳述的段落標示（SCHEMA 既有定義，字樣在資料包 catalog.ui.section_labels）
function labelSections(root, d) {
  const map = CAT.ui && CAT.ui.section_labels && CAT.ui.section_labels[d.l];
  if (!map) return;
  root.querySelectorAll('h2').forEach((x) => { const lab = map[x.textContent.trim()]; if (lab) x.append(' ', h('span', { class: 'tag ns' }, lab)); });
}
// MOC 底部給 /compile 看的「分類總則」預設摺疊（它是路由規則，不是閱讀內容）
function foldRoutingRules(root, d) {
  if (!/^vault\/wiki\/MOC\//.test(d.p)) return;
  root.querySelectorAll('blockquote').forEach((bq) => {
    if (!/^\s*分類總則/.test(bq.textContent)) return;
    const det = h('details', { class: 'aux' }, h('summary', null, '分類總則（給 /compile 的路由規則）'));
    bq.replaceWith(det); det.append(bq);
  });
}
// 領域頁底部：本領域的其他內容（照 d.ar：論點卡 areas、課程 Category…），MOC 本體不動
function areaExtras(cat, area) {
  const groups = new Map();
  for (const x of cat.docs) {
    if (x.ar !== area || /^wiki\//.test(x.l) || x.s == null) continue;
    if (!groups.has(x.l)) groups.set(x.l, []);
    groups.get(x.l).push(x);
  }
  if (!groups.size) return [];
  const out = [secTitle('本領域的其他內容')];
  for (const [l, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    xs.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
    out.push(h('details', { class: 'aux' }, h('summary', null, `${laneName(l)}（${xs.length}）`), listOf(xs.slice(0, 200).map((x) => itemLink(x)))));
  }
  return out;
}
// 文章頁導覽：課程（上一講／下一講／講義／課程頁）、日記（前一天／後一天）
function courseOf(p) {
  const cs = (CAT.ui && CAT.ui.courses) || [];
  for (let ci = 0; ci < cs.length; ci++) {
    const li = cs[ci].lessons.findIndex((l) => l.p === p);
    if (li >= 0) return { ci, li, c: cs[ci], kind: 'lesson' };
    if (cs[ci].handouts.includes(p) || cs[ci].notes.includes(p)) return { ci, li: -1, c: cs[ci], kind: 'other' };
  }
  return null;
}
function docNav(d) {
  const cs = courseOf(d.p);
  if (cs) {
    const row = h('div', { class: 'doc-nav' });
    const prev = cs.kind === 'lesson' ? cs.c.lessons[cs.li - 1] : null;
    const next = cs.kind === 'lesson' ? cs.c.lessons[cs.li + 1] : null;
    row.append(prev ? h('a', { class: 'btn', href: pageHref(prev.p), 'aria-label': `上一講 ${prev.o || ''}` }, svgIcon('back'), prev.o || '上一講') : h('span'),
      h('a', { class: 'btn quiet', href: '#/c/' + cs.ci }, '課程目錄'),
      next ? h('a', { class: 'btn', href: pageHref(next.p), 'aria-label': `下一講 ${next.o || ''}` }, next.o || '下一講', svgIcon('chev')) : h('span'));
    const lesson = cs.kind === 'lesson' ? cs.c.lessons[cs.li] : null;
    if (lesson && lesson.ho.length) row.append(...lesson.ho.map((p, i) => h('a', { class: 'btn quiet', href: pageHref(p) }, lesson.ho.length > 1 ? `講義 ${i + 1}` : '講義')));
    return row;
  }
  if (CAT.ui && d.l === CAT.ui.journal_lane) {
    const days = CAT.docs.filter((x) => x.l === d.l && x.d).sort((a, b) => String(a.d).localeCompare(String(b.d)));
    const i = days.findIndex((x) => x.p === d.p);
    const prev = days[i - 1], next = days[i + 1];
    return h('div', { class: 'doc-nav' },
      prev ? h('a', { class: 'btn', href: pageHref(prev.p) }, svgIcon('back'), String(prev.d).slice(5, 10)) : h('span'),
      h('a', { class: 'btn quiet', href: '#/l/' + enc(d.l) + '?y=' + String(d.d).slice(0, 4) }, `${String(d.d).slice(0, 4)} 年`),
      next ? h('a', { class: 'btn', href: pageHref(next.p) }, String(next.d).slice(5, 10), svgIcon('chev')) : h('span'));
  }
  return null;
}
function mimeOf(p) {
  return ({ webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', html: 'text/html', htm: 'text/html' })[extOf(p)] || 'application/octet-stream';
}
function csvTable(text, sep) {
  const LIMIT = 2000;
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [hd, ...rest] = rows;
  const state = { newestFirst: false };
  const wrap = h('div', { class: 'table-wrap csv-wrap' });
  const note = h('p', { class: 'page-sub' });
  const toggle = h('button', { type: 'button', class: 'btn' }, '從最後一列開始');
  const isNum = (x) => /^-?[\d,]+(\.\d+)?%?$/.test(x.trim());
  const draw = () => {
    const body = state.newestFirst ? rest.slice(-LIMIT).reverse() : rest.slice(0, LIMIT);
    const t = h('table', { class: 'csv' }, h('thead', null, h('tr', null, (hd || []).map((x) => h('th', null, x)))),
      h('tbody', null, body.map((r) => h('tr', null, r.map((x) => h('td', { class: [isNum(x) ? 'num' : '', x.length > 24 ? 'long' : ''].join(' ').trim() || null, title: x.length > 24 ? x : null }, x))))));
    wrap.replaceChildren(t);
    note.textContent = `共 ${rest.length.toLocaleString()} 列${rest.length > LIMIT ? `，顯示${state.newestFirst ? '最後' : '前'} ${LIMIT.toLocaleString()} 列` : ''}`;
    toggle.textContent = state.newestFirst ? '從第一列開始' : '從最後一列開始';
  };
  toggle.addEventListener('click', () => { state.newestFirst = !state.newestFirst; draw(); });
  draw();
  return h('div', null, h('div', { class: 'row' }, note, rest.length > 1 ? toggle : null), wrap);
}
// HTML 檔：sandbox（不給 allow-same-origin）＝不透明來源，讀不到 App 的 IndexedDB 與 token
async function htmlFrame(blob) {
  const html = await blob.text();
  const frame = h('iframe', { class: 'htmlview', sandbox: 'allow-scripts allow-popups', src: 'viewer.html', title: 'HTML 檢視' });
  frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'om-html', html }, '*'), { once: true });
  return frame;
}

async function viewSearch(q) {
  $('#q').value = q;
  const cat = await catalog();
  if (!cat) return emptyState();
  const terms = q.trim().split(/\s+/).filter(Boolean);
  const { paths, toks } = await search(q);
  if (!toks.length || (terms.length === 1 && [...terms[0]].length === 1)) {
    return setView(h('h1', null, '搜尋'), h('p', { class: 'empty-box' }, '請輸入至少兩個字（多個詞用空白分開，每個詞都要出現）。'));
  }
  const tl = terms.map((t) => t.toLowerCase());
  const ql = q.trim().toLowerCase();
  const rank = (d) => { const t = docTitle(d).toLowerCase(); return t === ql ? 0 : tl.every((x) => t.includes(x)) ? 1 : 2; };
  const cands = paths.map((p) => cat.byPath.get(p)).filter(Boolean);
  cands.sort((a, b) => rank(a) - rank(b) || String(b.d || '').localeCompare(String(a.d || '')));
  if (!cands.length) return setView(h('h1', null, `「${q}」`), h('p', { class: 'empty-box' }, '沒有找到。'));
  const laneCountsQ = new Map();
  for (const d of cands) laneCountsQ.set(d.l, (laneCountsQ.get(d.l) || 0) + 1);
  const state = { lane: null, cursor: 0, shown: 0 };
  const list = h('ul', { class: 'list' });
  const info = h('p', { class: 'page-sub' });
  const more = h('button', { type: 'button', class: 'btn more', hidden: true }, '再多 50 則');
  const chipRow = h('div', { class: 'filter-row' });
  const pool = () => (state.lane ? cands.filter((d) => d.l === state.lane) : cands);
  // 逐篇驗證：每個詞都要真的出現在標題或內文（索引是二字組，會有假陽性）
  const page = async () => {
    more.hidden = true;
    const all = pool();
    let added = 0;
    while (state.cursor < all.length && added < 50) {
      const d = all[state.cursor++];
      const text = await docText(d);
      const sn = text ? snippet(text, terms) : null;
      const title = docTitle(d).toLowerCase();
      if (!sn && !tl.every((x) => title.includes(x))) continue;
      added++; state.shown++;
      list.append(itemLink(d, sn ? h('span', { class: 'snip' }, ...sn) : null));
    }
    info.textContent = `${state.shown} 則${state.cursor < all.length ? `・還有 ${all.length - state.cursor} 則待比對` : ''}`;
    if (!state.shown && state.cursor >= all.length) list.replaceChildren(h('li', { class: 'empty' }, '索引有候選，但沒有一則同時包含所有詞。'));
    more.hidden = state.cursor >= all.length;
  };
  more.addEventListener('click', page);
  const render = () => { list.replaceChildren(); state.cursor = 0; state.shown = 0; return page(); };
  chipRow.append(h('button', { type: 'button', class: 'filter', 'aria-pressed': 'true', onclick: (e) => pick(e, null) }, `全部 ${cands.length}`),
    ...[...laneCountsQ].sort((a, b) => b[1] - a[1]).map(([l, c]) => h('button', { type: 'button', class: 'filter', 'aria-pressed': 'false', onclick: (e) => pick(e, l) }, `${laneName(l)} ${c}`)));
  function pick(e, lane) {
    state.lane = lane;
    chipRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    render();
  }
  setView(h('h1', null, `「${q}」`), laneCountsQ.size > 1 ? chipRow : null, info, list, more);
  await render();
}

async function wipeAll() {
  lockNow();
  const d = await db(); d.close(); dbp = null;
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = res; });
}

async function viewSettings() {
  const cfg = await getConfig();
  const repo = h('input', { id: 'cfg-repo', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'owner/repo', value: cfg.repo || '' });
  const token = h('input', { id: 'cfg-token', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: cfg.token ? '（已存，留空表示不變）' : 'github_pat_…' });
  const out = h('p', { class: 'status', role: 'status' });
  const quota = h('p', { class: 'muted quota', hidden: true });
  const showQuota = (rate) => {
    if (!rate || rate.remaining == null) return;
    quota.hidden = false;
    quota.textContent = `GitHub 額度：這一小時還剩 ${Number(rate.remaining).toLocaleString()} 次` +
      (rate.reset ? `，${new Date(rate.reset * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 重置` : '') + '（所有 token 共用）';
  };
  const prog = h('progress', { max: '100', value: '0', hidden: true });
  const checkBtn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('sync'), '檢查更新');
  const choice = h('div', { class: 'row', hidden: true });
  const info = h('dl', { class: 'kv' });
  const fillInfo = async () => {
    info.replaceChildren();
    const s = (await kvGet('state')) || {};
    const add = (k, v) => info.append(h('dt', null, k), h('dd', null, v));
    add('上次同步', s.syncedAt ? new Date(s.syncedAt).toLocaleString('zh-TW') : '尚未');
    add('資料版本', s.commit ? s.commit.slice(0, 7) : '—');
    if (s.pendingMedia) add('尚未下載', `${s.pendingMedia} 個圖片與附件`);
    if (navigator.storage && navigator.storage.estimate) {
      try { const e = await navigator.storage.estimate(); add('手機已用', `${fmtMB(e.usage || 0)}／配額 ${fmtMB(e.quota || 0)}`); } catch (e) { /* 略過 */ }
    }
    if (navigator.storage && navigator.storage.persisted) {
      try { add('持久儲存', (await navigator.storage.persisted()) ? '是' : '否'); } catch (e) { /* 略過 */ }
    }
  };
  const doSync = async (plan, textOnly) => {
    choice.hidden = true; checkBtn.disabled = true; prog.hidden = false;
    try {
      const res = await runSync(plan, { textOnly }, (p) => {
        prog.max = Math.max(1, p.totalBytes); prog.value = p.doneBytes;
        out.textContent = `下載中 ${p.doneFiles}／${p.totalFiles}（${fmtMB(p.doneBytes)}／${fmtMB(p.totalBytes)}）${p.failed ? `，失敗 ${p.failed}` : ''}`;
        showQuota(p.rate);
      });
      showQuota(res.rate);
      if (res.complete) updateInfo = null;
      if (res.busy) out.textContent = '已在同步中。';
      else if (res.complete) out.textContent = `同步完成：下載 ${res.downloaded} ${plan.packed ? '包' : '個檔'}，清掉 ${res.removed} 筆舊資料。${textOnly ? '圖片與附件留到下次。' : ''}`;
      else if (res.stopErr && res.stopErr.rateLimited) out.textContent = `GitHub 每小時額度用完，已下載的都保留了。${res.rate && res.rate.reset ? new Date(res.rate.reset * 1000).toLocaleTimeString('zh-TW') + ' 後' : '稍後'}再同步會接著下載。`;
      else if (res.stopErr) out.textContent = `同步中止：${res.stopErr.message}`;
      else out.textContent = `同步未完成：${res.failed} 個檔下載失敗，再同步一次會補抓。`;
    } catch (e) {
      out.textContent = '同步失敗：' + (e.message || e);
    } finally {
      checkBtn.disabled = false; checkBtn.className = 'btn primary'; prog.hidden = true; fillInfo();
    }
  };
  checkBtn.addEventListener('click', async () => {
    const r = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const tk = token.value.trim() || cfg.token;
    if (!(r === 'local' || /^[\w.-]+\/[\w.-]+$/.test(r)) || (!tk && r !== 'local')) { out.textContent = '請填 repo（擁有者/名稱）與 token。'; return; }
    await setConfig(r, tk);
    token.value = '';
    checkBtn.disabled = true; choice.hidden = true;
    out.textContent = '比對檔案清單…';
    try {
      const plan = await planSync();
      showQuota(plan.rate);
      const total = plan.textBytes + plan.mediaBytes;
      if (!plan.want.length && !plan.stale.length) { out.textContent = '已是最新，沒有要下載的。'; return; }
      out.textContent = `這次要下載 ${plan.want.length} ${plan.packed ? '包' : '個檔'}、共 ${fmtMB(total)}（約 ${plan.requests} 次請求）：文字與索引 ${fmtMB(plan.textBytes)}，圖片與附件 ${fmtMB(plan.mediaBytes)}。`;
      checkBtn.className = 'btn';
      choice.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => doSync(plan, false) }, `全部下載（${fmtMB(total)}）`));
      if (plan.mediaFiles) choice.append(h('button', { type: 'button', class: 'btn', onclick: () => doSync(plan, true) }, `只下載文字（${fmtMB(plan.textBytes)}）`));
      choice.hidden = false;
    } catch (e) {
      out.textContent = e.status === 401 ? 'token 無效或已過期，請貼上新的 token。' : e.status === 404 ? '找不到 repo：名稱錯誤或 token 沒授權。' : '檢查失敗：' + (e.message || e);
    } finally { checkBtn.disabled = false; }
  });
  const lockBtn = h('button', { type: 'button', class: 'btn', onclick: () => { lockNow(); route(); } }, svgIcon('lock'), '立刻上鎖');
  const clearBtn = h('button', { type: 'button', class: 'btn quiet danger' }, '刪除手機上的全部資料');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('刪除這支手機上的全部資料、token 與開啟鎖設定？（資料 repo 不受影響，之後可以重新同步）')) return;
    await wipeAll();
    location.hash = '#/';
    route();
  });
  setView(h('h1', null, '同步與設定'),
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('label', { for: 'cfg-repo' }, '資料 repo（擁有者/名稱）'), repo),
      h('div', { class: 'field' }, h('label', { for: 'cfg-token' }, '唯讀 token'), token),
      h('div', { class: 'row' }, checkBtn), out, choice, prog, quota),
    secTitle('這支手機'), h('div', { class: 'card' }, info),
    h('p', { class: 'muted' }, '只下載有變動的檔。repo 名稱與 token 只存在這支手機，token 與所有資料都以 Face ID 導出的金鑰加密。token 到期後在這裡貼上新的即可。'),
    h('div', { class: 'row' }, lockBtn, clearBtn));
  fillInfo();
}

function lockScreen(title, text, btnLabel, action, extra) {
  const out = h('p', { class: 'status', role: 'status' });
  const btn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('lock'), btnLabel);
  btn.addEventListener('click', async () => {
    btn.disabled = true; out.textContent = '';
    try { await action(); route(); }
    catch (e) { out.textContent = '沒有成功：' + (e.name === 'NotAllowedError' ? '取消了，或逾時' : (e.message || e)); btn.disabled = false; }
  });
  setView(h('div', { class: 'lock' }, h('img', { src: 'icons/icon-192.png', alt: '' }), h('h1', null, title),
    text ? h('p', { class: 'muted' }, text) : null, btn, out, extra || null));
  btn.focus();
}
async function viewSetupLock() {
  lockScreen('先設定開啟鎖', '手機上的資料會用 Face ID 導出的金鑰加密，沒有你的臉就讀不到。接下來 iOS 會問你要不要把「OM Reader」的通行金鑰存進「密碼」，請同意。',
    '用 Face ID 建立開啟鎖', async () => { await setupLock(); location.hash = '#/settings'; });
}
async function viewLock() {
  const reset = h('button', { type: 'button', class: 'btn quiet' }, '解不開？重設這支手機');
  reset.addEventListener('click', async () => {
    if (!confirm('找不到通行金鑰或一直解不開時才用：刪除這支手機上的全部資料，重新設定開啟鎖、重新同步。資料 repo 不受影響。')) return;
    await wipeAll(); route();
  });
  lockScreen('OM Reader', null, '用 Face ID 解鎖', unlock, reset);
}

/* ════════ 路由 ════════ */
async function route() {
  const hash = location.hash || '#/';
  try {
    if (!window.PublicKeyCredential || !window.crypto || !crypto.subtle) {
      return setView(h('h1', null, '這個瀏覽器不支援'), h('p', null, '需要通行金鑰與 Web Crypto（iOS 18 的 Safari／主畫面 App 都有）。'));
    }
    const hasLock = !!(await kvGet('lock'));
    const locked = !hasLock || !KEY;
    document.body.classList.toggle('locked', locked);
    updateChrome(hash, locked);
    if (!hasLock) return viewSetupLock();
    if (!KEY) return viewLock();
    if (!hash.startsWith('#/s/')) $('#q').value = '';
    stashView();
    curHash = hash;
    if (restoreView(hash)) return;
    if (hash.startsWith('#/browse')) await viewBrowse();
    else if (hash.startsWith('#/history')) await viewHistory();
    else if (hash.startsWith('#/p/')) await viewPage(dec(hash.slice(4)));
    else if (hash.startsWith('#/l/')) await viewLane(dec(hash.slice(4)));
    else if (hash.startsWith('#/c/')) await viewCourse(+hash.slice(4));
    else if (hash.startsWith('#/s/')) await viewSearch(decodeURIComponent(hash.slice(4)));
    else if (hash.startsWith('#/settings')) await viewSettings();
    else await viewHome();
  } catch (e) {
    setView(h('h1', null, '出錯了'), h('pre', { class: 'raw wrap' }, String(e && e.stack || e)));
  }
}
$('#qform').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) location.hash = '#/s/' + encodeURIComponent(q);
  $('#q').blur();
});
// 頂列：深層頁（文章、清單、搜尋）顯示「上一頁」；底部分頁標出目前位置
let navDepth = 0;
window.addEventListener('hashchange', () => { navDepth++; route(); });
function updateChrome(hash, locked) {
  const deep = /^#\/(p|l|s|c)\//.test(hash);
  $('#back').hidden = locked || !deep || navDepth === 0;
  $('#brand').hidden = !$('#back').hidden;
  const tab = hash.startsWith('#/browse') || hash.startsWith('#/l/') || hash.startsWith('#/c/') ? 'browse'
    : hash.startsWith('#/history') ? 'history'
      : hash.startsWith('#/settings') ? 'settings'
        : hash.startsWith('#/p/') || hash.startsWith('#/s/') ? null : 'home';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
$('#back').addEventListener('click', () => { navDepth = Math.max(0, navDepth - 2); history.back(); });
// 回到頂端：捲過一個半畫面才出現
const toTop = h('button', { type: 'button', class: 'btn to-top', 'aria-label': '回到頂端', hidden: true, onclick: () => window.scrollTo(0, 0) }, svgIcon('up'));
document.body.append(toTop);
window.addEventListener('scroll', () => { toTop.hidden = document.body.classList.contains('locked') || window.scrollY < window.innerHeight * 1.5; }, { passive: true });
// 明暗：跟隨系統 → 淺色 → 深色（選擇只存在這台裝置）
const THEMES = [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']];
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  try { if (t === 'auto') localStorage.removeItem('om-reader-theme'); else localStorage.setItem('om-reader-theme', t); } catch (e) { /* 略過 */ }
  const tc = { light: '#f8f6f1', dark: '#16171b' };
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('data-media') || m.getAttribute('media');
    if (!m.getAttribute('data-media')) m.setAttribute('data-media', media);
    if (t === 'auto') { m.setAttribute('media', media); m.content = /dark/.test(media) ? tc.dark : tc.light; }
    else { m.removeAttribute('media'); m.content = tc[t]; }
  });
  const btn = $('#theme');
  btn.querySelector('use').setAttribute('href', '#i-' + (t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', '明暗：' + THEMES.find((x) => x[0] === t)[1]);
}
let themeNow = document.documentElement.getAttribute('data-theme') || 'auto';
applyTheme(themeNow);
$('#theme').addEventListener('click', () => {
  themeNow = THEMES[(THEMES.findIndex((x) => x[0] === themeNow) + 1) % THEMES.length][0];
  applyTheme(themeNow);
});

route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
