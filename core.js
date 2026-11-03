// OM Reader——共用核心：小工具、IndexedDB、加密與開啟鎖、資料來源、同步、資料存取。
// 載入順序（index.html）：core.js → reader.js → app.js；都是一般 script，彼此共用全域的函式與變數。
// OM Reader 是 iPhone／iPad 的唯讀閱讀器（PWA）。
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
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of ['files', 'shas', 'kv', 'media']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
      // files：資料包內路徑 → { size, iv, ct }（加密內容）
      // shas ：資料包內路徑 → git blob sha（小，差異比對只讀這個，不碰加密內容）
      // kv   ：設定（token 加密）、開啟鎖、同步狀態
      // media：離線影音，<隨機 ID>:<塊序號> → { iv, ct }（每個檔自己的金鑰加密，offline.js）
    };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; resolve(r.result); };
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
  for (const f of UNLOCK_HOOKS) { try { await f(); } catch (e) { /* 單一模組失敗不擋解鎖 */ } }
  setTimeout(checkUpdates, 1500);
}
// 其他模組在上鎖／解鎖時要做的事（例：雲端硬碟模組清掉記憶體裡解密過的檔名快取；登入回來後接回原頁）
const LOCK_HOOKS = [];
const UNLOCK_HOOKS = [];
function lockNow() {
  KEY = null;
  resetCaches();   // 也清掉返回快取：上鎖後畫面上不留任何解密過的內容
  releaseBlobUrls();
  for (const f of LOCK_HOOKS) { try { f(); } catch (e) { /* 略過 */ } }
}
// 背景超過 5 分鐘就上鎖；但播放中不計時，暫停或停止之後才開始算（播放元件提供 mediaIdleSince）
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    if (typeof mediaOnHide === 'function') mediaOnHide();
    return;
  }
  if (!KEY || !hiddenAt) return;
  const idleFrom = typeof mediaIdleSince === 'function' ? mediaIdleSince(hiddenAt) : hiddenAt;
  if (idleFrom != null && Date.now() - idleFrom > LOCK_AFTER_MS) { lockNow(); route(); }
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
// 下載中的進度與上一次的結果放在全域：離開同步頁再回來，新畫面接得回進度（下載本身不受換頁影響）
let SYNC_NOW = null;    // { p, plan, textOnly }
let SYNC_LAST = null;   // { res, plan, textOnly, at }
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
  SYNC_NOW = { p: null, plan, textOnly };
  const report = onProgress;
  onProgress = (p) => { SYNC_NOW.p = p; report(p); };
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
    const res = { complete, failed, stopErr, downloaded: doneFiles, removed, rate: src.rate, textOnly };
    SYNC_LAST = { res, plan, textOnly, at: Date.now() };
    return res;
  } finally { syncing = false; SYNC_NOW = null; }
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
