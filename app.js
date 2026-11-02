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
async function unlock() {
  const lock = await kvGet('lock');
  const prf = await prfFromPasskey(lock);
  const key = await deriveKey(prf, unb64u(lock.hkdfSalt));
  try { if (td.decode(await open_(lock.check, key)) !== 'om-reader-ok') throw new Error(); }
  catch (e) { throw new Error('金鑰不符：這把通行金鑰不是當初設定的那一把'); }
  KEY = key;
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
  if (p.startsWith('text/')) return 2;
  if (p.startsWith('index/')) return 3;
  return 4;
}
const isMedia = (p) => p.startsWith('files/');
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
  const want = entries.filter((e) => local.get(e.path) !== e.sha).sort((a, b) => syncPriority(a.path) - syncPriority(b.path));
  const remotePaths = new Set(entries.map((e) => e.path));
  const stale = [...local.keys()].filter((k) => !remotePaths.has(k));
  const sum = (arr) => arr.reduce((s, e) => s + (e.size || 0), 0);
  const textPart = want.filter((e) => !isMedia(e.path));
  const mediaPart = want.filter((e) => isMedia(e.path));
  return { src, commit, entries, want, stale, textBytes: sum(textPart), mediaBytes: sum(mediaPart),
    textFiles: textPart.length, mediaFiles: mediaPart.length, rate: src.rate };
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
          const buf = await (await src.blob(e)).arrayBuffer();
          const sealed = await seal(buf);
          await idbPutFile(e.path, e.sha, { size: buf.byteLength, iv: sealed.iv, ct: sealed.ct });
          doneBytes += e.size || buf.byteLength;
          doneFiles++;
        } catch (err) {
          if (err.rateLimited || err.status === 401 || !KEY) { stopErr = err; break; }
          failed++;
        }
        onProgress({ doneFiles, totalFiles: want.length, doneBytes, totalBytes, failed, rate: src.rate });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (!stopErr) for (const k of plan.stale) await idbDelFile(k);
    const complete = !stopErr && failed === 0;
    const prev = (await kvGet('state')) || {};
    if (complete) {
      await kvSet('state', { commit: plan.commit, syncedAt: Date.now(), files: plan.entries.length,
        pendingMedia: textOnly ? plan.mediaFiles : 0 });
    } else {
      await kvSet('state', Object.assign(prev, { partialAt: Date.now() }));
    }
    resetCaches();
    return { complete, failed, stopErr, downloaded: doneFiles, removed: complete ? plan.stale.length : 0, rate: src.rate, textOnly };
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
async function docText(d) { return d.s == null ? null : ((await shard(d.s))[d.p] ?? null); }

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
function convertWikilinks(body, srcPath) {
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
function renderMarkdown(body, srcPath) {
  const html = md.render(convertWikilinks(body, srcPath));
  const frag = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    ADD_TAGS: ['video'], ADD_ATTR: ['controls', 'playsinline', 'preload', 'target'],
  });
  const wrap = h('div', { class: 'md' });
  wrap.append(frag);
  wrap.querySelectorAll('table').forEach((t) => { const w = h('div', { class: 'table-wrap' }); t.replaceWith(w); w.append(t); });
  return wrap;
}
// 圖片與影片：捲到附近才解密（長頁不必一次解完所有圖）
async function hydrateOne(el, bucket) {
  const d = CAT && CAT.byPath.get(el.getAttribute('data-om'));
  if (!d || !d.f) return;
  const b = await fileBlob(d.f);
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
const laneName = (l) => (CAT && CAT.ui && CAT.ui.lanes && CAT.ui.lanes[l]) || l;
const laneOrder = () => (CAT && CAT.ui && CAT.ui.lane_order) || [];
function docMeta(d) {
  const bits = [laneName(d.l)];
  if (d.d) bits.push(String(d.d).slice(0, 10));
  if (d.a) bits.push(d.a);
  if (d.unrev) bits.push('未審');
  return bits.join('　');
}
function docTitle(d) { return d.t || basename(d.p); }
// 只有領域地圖上色：顏色＝本人在 Notion Category 選單上設的顏色（catalog.ui.area_dyes，依領域頁路徑）。
// 其他地方一律中性色，重點色用紫（本人 2026-11-02）。
function areaColor(el, path) {
  const dye = CAT && CAT.ui && CAT.ui.area_dyes && CAT.ui.area_dyes[path];
  if (dye) { el.style.setProperty('--fam', `var(--dye-${dye})`); el.classList.add('has-area'); }
  return el;
}
function itemLink(d, extra) {
  const a = h('a', { class: 'item', href: pageHref(d.p) },
    h('span', { class: 't' }, docTitle(d)), h('span', { class: 'm' }, docMeta(d)), extra || null);
  return h('li', null, areaColor(a, d.p));
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
  const list = (await getHistory()).filter((x) => x.p !== p);
  list.unshift({ p, at: Date.now() });
  await kvSet('history', await seal(te.encode(JSON.stringify(list.slice(0, 100)))));
}

/* ════════ 畫面 ════════ */
function setView(...kids) {
  view.replaceChildren(...kids.filter((k) => k != null));
  window.scrollTo(0, 0);
}
// 返回快取：文章、清單、搜尋、分類離開時把整個畫面（含展開筆數、篩選、捲動位置）留著，回來直接還原
const viewCache = new Map();
let curHash = null;
const CACHEABLE = /^#\/(p|l|s)\/|^#\/browse/;
function stashView() {
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
  const kids = [];
  const st = (await kvGet('state')) || {};
  if (st.files) {
    const have = await idbFileCount();
    const missing = st.files - (st.pendingMedia || 0) - have;
    if (missing > 0) kids.push(h('p', { class: 'note' }, `手機上少了 ${missing} 個檔（可能被系統清掉了）。到「同步」按「檢查更新」就會補回來。`));
  }
  // 繼續看
  const hist = (await getHistory()).map((x) => cat.byPath.get(x.p)).filter(Boolean).slice(0, 3);
  if (hist.length) kids.push(secTitle('繼續看', '#/history', '全部'), listOf(hist.map((d) => itemLink(d))));
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
        h('span', { class: 'm' }, m[3].replace(/^[●○⊡]\s*/, ''))), d.p));
    }
    if (tiles.length) kids.push(secTitle('領域地圖'), h('div', { class: 'grid' }, tiles));
  }
  // 最近新增
  const skip = new Set(ui.recent_exclude || []);
  const recent = cat.docs.filter((d) => d.d && d.p.endsWith('.md') && !skip.has(d.l))
    .sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 12);
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
    kids.push(secTitle(g.name), h('div', { class: 'grid' }, lanes.map((l) => h('a', { class: 'tile', href: '#/l/' + enc(l) },
      h('span', { class: 't' }, laneName(l)), h('span', { class: 'm' }, `${counts.get(l).toLocaleString()} 則`)))));
  }
  setView(...kids);
}

async function viewHistory() {
  const cat = await catalog();
  if (!cat) return emptyState();
  const hist = (await getHistory()).map((x) => [cat.byPath.get(x.p), x.at]).filter((x) => x[0]);
  const fmt = (t) => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const clear = h('button', { type: 'button', class: 'btn quiet' }, '清除紀錄');
  clear.addEventListener('click', async () => { await kvSet('history', await seal(te.encode('[]'))); viewHistory(); });
  setView(h('h1', null, '看過'), h('p', { class: 'page-sub' }, '最近打開過的 100 頁，只存在這支手機（加密）。'),
    listOf(hist.map(([d, at]) => itemLink(d, h('span', { class: 'm' }, `看過 ${fmt(at)}`))), '還沒有看過任何一頁。'),
    hist.length ? h('div', { class: 'row' }, clear) : null);
}

const isAux = (d) => /^_/.test(basename(d.p)) || basename(d.p) === 'index.md' || /\.(json|jsonl)$/.test(d.p);
async function viewLane(lane) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const all = cat.docs.filter((d) => d.l === lane && (d.s != null || /\.(pdf|html?|mp4)$/i.test(d.p)));
  const docs = all.filter((d) => !isAux(d));
  const aux = all.filter(isAux);
  const dated = docs.filter((d) => d.d).length >= docs.length * 0.6;
  if (dated) docs.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || a.p.localeCompare(b.p));
  else docs.sort((a, b) => docTitle(a).localeCompare(docTitle(b), 'zh-Hant'));
  const list = h('ul', { class: 'list' });
  let shown = 0;
  const more = h('button', { class: 'btn more', type: 'button' }, '再多 100 則');
  const add = () => {
    for (const d of docs.slice(shown, shown + 100)) list.append(itemLink(d));
    shown = Math.min(docs.length, shown + 100);
    more.hidden = shown >= docs.length;
  };
  more.addEventListener('click', add);
  add();
  const head = h('div', { class: 'doc-head' }, h('h1', null, laneName(lane)));
  const auxBox = aux.length ? h('details', { class: 'aux' }, h('summary', null, `總覽與附檔（${aux.length}）`), listOf(aux.map((d) => itemLink(d)))) : null;
  setView(head, h('p', { class: 'page-sub' }, `${docs.length.toLocaleString()} 則・${dated ? '新到舊' : '依名稱'}`), list, more, auxBox);
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
  const crumb = h('nav', { class: 'crumb', 'aria-label': '所在位置' }, h('a', { href: '#/l/' + enc(d.l) }, laneName(d.l)));
  const title = h('h1', { class: docTitle(d).length > 28 ? 'long' : null }, docTitle(d));
  const head = areaColor(h('div', { class: 'doc-head' }, crumb, title), d.p);
  const chips = h('div', { class: 'chips' }, [d.d && String(d.d).slice(0, 10), d.a, d.src]
    .filter(Boolean).map((x) => h('span', { class: 'tag' }, x)), d.unrev ? h('span', { class: 'tag warn' }, '未審') : null);
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
      const mdRoot = renderMarkdown(splitFrontmatter(text).body, d.p);
      const toc = outline(mdRoot);
      if (toc) body.append(toc);
      body.append(mdRoot);
    }
    else if (ext === 'csv' || ext === 'tsv') body.append(csvTable(text, ext === 'tsv' ? '\t' : ','));
    else body.append(h('pre', { class: 'raw' + (ext === 'txt' || ext === 'jsonl' ? ' wrap' : '') }, text));
  } else if (d.f) {
    const b = await fileBlob(d.f);
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
        body.append(await htmlFrame(b), h('p', { class: 'muted' }, 'HTML 頁在隔離框架中執行，讀不到 App 的資料，也不會連到外部網站（地圖圖磚這類線上資源不顯示）。'));
      }
      else body.append(h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, ext === 'pdf' ? '打開 PDF' : '打開檔案'), h('p', { class: 'muted' }, fmtMB(b.size)));
    }
  }
  const kids = [head, chips];
  if (actions.childElementCount) kids.push(actions);
  kids.push(body);
  // 來源（論點卡的 sources、概念頁引用的 raw）與反向連結
  const L = await links();
  const outs = (L.out.get(d.p) || []).map((p) => cat.byPath.get(p)).filter((x) => x && x.nid && x.p !== d.p);
  if (outs.length && !d.nid) {
    kids.push(secTitle(`引用的來源（${outs.length}）`), listOf(outs.slice(0, 60).map((x) => itemLink(x))));
  }
  const backs = (L.back.get(d.p) || []).map((p) => cat.byPath.get(p)).filter(Boolean);
  if (backs.length) kids.push(secTitle(`被引用（${backs.length}）`), listOf(backs.slice(0, 200).map((x) => itemLink(x))));
  setView(...kids);
  hydrateMedia(view);
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
        out.textContent = `下載中 ${p.doneFiles}／${p.totalFiles} 個檔（${fmtMB(p.doneBytes)}／${fmtMB(p.totalBytes)}）${p.failed ? `，失敗 ${p.failed}` : ''}`;
      });
      if (res.busy) out.textContent = '已在同步中。';
      else if (res.complete) out.textContent = `同步完成：下載 ${res.downloaded} 個檔，移除 ${res.removed} 個舊檔。${textOnly ? '圖片與附件留到下次。' : ''}`;
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
      const total = plan.textBytes + plan.mediaBytes;
      if (!plan.want.length && !plan.stale.length) { out.textContent = '已是最新，沒有要下載的。'; return; }
      out.textContent = `這次要下載 ${plan.want.length} 個檔、共 ${fmtMB(total)}：文字與索引 ${fmtMB(plan.textBytes)}，圖片與附件 ${fmtMB(plan.mediaBytes)}。`;
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
      h('div', { class: 'row' }, checkBtn), out, choice, prog),
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
  const deep = /^#\/(p|l|s)\//.test(hash);
  $('#back').hidden = locked || !deep || navDepth === 0;
  $('#brand').hidden = !$('#back').hidden;
  const tab = hash.startsWith('#/browse') || hash.startsWith('#/l/') ? 'browse'
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
