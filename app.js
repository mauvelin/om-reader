// OM Reader——iPhone 唯讀閱讀器（PWA）。
// 資料：從私有資料 repo（GitHub API＋唯讀 token）差異同步進 IndexedDB，之後全程離線讀。
// 本檔不含任何資料、repo 名稱或 token；設定只存在使用者的裝置上。
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
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('files');   // key：資料包內路徑 → { sha, size, blob }
      d.createObjectStore('kv');      // 設定與同步狀態
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
  // 只取 key→sha，不把 blob 讀進記憶體
  const d = await db();
  const out = new Map();
  return new Promise((res, rej) => {
    const cur = d.transaction('files').objectStore('files').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.set(c.key, c.value.sha);
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}
const kvGet = (k) => idbGet('kv', k);
const kvSet = (k, v) => idbPut('kv', k, v);

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
  const cfg = (await kvGet('config')) || {};
  if (cfg.repo === 'local' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return new DevSource('./dev-data/');
  if (!cfg.repo || !cfg.token) return null;
  return new GitHubSource(cfg.repo, cfg.token);
}

/* ════════ 同步 ════════ */
// 先抓目錄、連結、索引、文字，最後才是圖片與其他二進位：中斷時文字已經可用
function syncPriority(p) {
  if (p === 'catalog.json') return 0;
  if (p === 'links.json.gz') return 1;
  if (p.startsWith('text/')) return 2;
  if (p.startsWith('index/')) return 3;
  return 4;
}
let syncing = false;
async function runSync(onProgress) {
  if (syncing) return { busy: true };
  syncing = true;
  try {
    const src = await getSource();
    if (!src) throw new Error('還沒設定資料來源');
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 略過 */ } }
    onProgress({ phase: 'tree' });
    const { commit, entries } = await src.tree();
    const local = await idbShaMap();
    const want = entries.filter((e) => local.get(e.path) !== e.sha).sort((a, b) => syncPriority(a.path) - syncPriority(b.path));
    const remotePaths = new Set(entries.map((e) => e.path));
    const stale = [...local.keys()].filter((k) => !remotePaths.has(k));
    const totalBytes = want.reduce((s, e) => s + (e.size || 0), 0);
    let doneBytes = 0, doneFiles = 0, failed = 0, stopErr = null;
    onProgress({ phase: 'download', doneFiles, totalFiles: want.length, doneBytes, totalBytes });
    let next = 0;
    const worker = async () => {
      while (!stopErr && next < want.length) {
        const e = want[next++];
        try {
          const blob = await src.blob(e);
          await idbPut('files', e.path, { sha: e.sha, size: blob.size, blob });
          doneBytes += e.size || blob.size;
          doneFiles++;
        } catch (err) {
          if (err.rateLimited || err.status === 401) { stopErr = err; break; }
          failed++;
        }
        onProgress({ phase: 'download', doneFiles, totalFiles: want.length, doneBytes, totalBytes, failed, rate: src.rate });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (!stopErr) for (const k of stale) await idbDel('files', k);
    const complete = !stopErr && failed === 0;
    if (complete) await kvSet('state', { commit, syncedAt: Date.now(), files: entries.length });
    else {
      const prev = (await kvGet('state')) || {};
      await kvSet('state', Object.assign(prev, { partialAt: Date.now() }));
    }
    resetCaches();
    return { complete, failed, stopErr, downloaded: doneFiles, removed: complete ? stale.length : 0, rate: src.rate };
  } finally { syncing = false; }
}

/* ════════ 資料存取（記憶體快取） ════════ */
let CAT = null;          // { docs, byPath, byName, byStem, built_at, source_commit }
let LINKS = null;        // { out: Map, back: Map }
const shardCache = new Map();
const indexCache = new Map();
const blobUrls = [];
function resetCaches() { CAT = null; LINKS = null; shardCache.clear(); indexCache.clear(); }

async function fileBlob(path) { const r = await idbGet('files', path); return r ? r.blob : null; }
async function gunzipJSON(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
async function catalog() {
  if (CAT) return CAT;
  const b = await fileBlob('catalog.json');
  if (!b) return null;
  const meta = JSON.parse(await b.text());
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
async function hydrateMedia(root) {
  for (const el of root.querySelectorAll('[data-om]')) {
    const d = CAT.byPath.get(el.getAttribute('data-om'));
    if (!d || !d.f) continue;
    const b = await fileBlob(d.f);
    if (!b) { if (el.tagName === 'IMG') el.alt = (el.alt || '') + '（圖片尚未同步）'; continue; }
    const url = URL.createObjectURL(b);
    blobUrls.push(url);
    el.src = url;
  }
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
async function indexShard(k) {
  if (indexCache.has(k)) return indexCache.get(k);
  const b = await fileBlob(`index/${String(k).padStart(2, '0')}.json.gz`);
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
function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return out;
}
async function search(q) {
  const cat = await catalog();
  const toks = queryTokens(q);
  if (!toks.length) return { ids: [], toks };
  const n = cat.index_shards || 64;
  const lists = [];
  for (const t of toks) {
    const idx = await indexShard(fnv1a(t) % n);
    if (!idx[t]) return { ids: [], toks };
    lists.push(decodePostings(idx[t]));
  }
  lists.sort((a, b) => a.length - b.length);
  let ids = lists[0];
  for (let i = 1; i < lists.length && ids.length; i++) ids = intersect(ids, lists[i]);
  return { ids, toks };
}
function snippet(text, q) {
  const body = splitFrontmatter(text).body.replace(/!\[\[[^\]]*\]\]/g, '').replace(/\s+/g, ' ');
  const i = body.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 30);
  return { pre: (start > 0 ? '…' : '') + body.slice(start, i), hit: body.slice(i, i + q.length), post: body.slice(i + q.length, i + q.length + 60) + '…' };
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
function itemLink(d, extra) {
  return h('li', null, h('a', { class: 'item', href: pageHref(d.p) },
    h('span', { class: 't' }, docTitle(d)), h('span', { class: 'm' }, docMeta(d)), extra || null));
}

/* ════════ 畫面 ════════ */
function setView(...kids) {
  releaseBlobUrls();
  view.replaceChildren(...kids);
  window.scrollTo(0, 0);
}
function emptyState() {
  setView(h('h1', null, '還沒有資料'),
    h('p', null, '先到設定填入資料 repo 與唯讀 token，再按「同步」。第一次同步約 300 MB，建議在 Wi-Fi 下進行。'),
    h('a', { class: 'btn primary', href: '#/settings' }, '前往設定'));
}

async function viewHome() {
  const cat = await catalog();
  if (!cat) return emptyState();
  const kids = [];
  // 領域地圖：讀 catalog.ui.home_map 指定的頁面裡「### 名稱 → [[頁面]] 說明」的行
  const ui = cat.ui || {};
  const idx = ui.home_map ? cat.byPath.get(ui.home_map) : null;
  if (idx) {
    const text = await docText(idx);
    const tiles = [];
    for (const line of (text || '').split('\n')) {
      const m = /^###\s+(.+?)\s*→\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*(.*)$/.exec(line);
      if (!m) continue;
      const d = resolveLink(m[2], idx.p);
      if (!d) continue;
      tiles.push(h('a', { class: 'tile', href: pageHref(d.p) }, h('span', { class: 't' }, m[1].trim()), h('span', { class: 'm' }, m[3].replace(/^[●○⊡]\s*/, ''))));
    }
    if (tiles.length) kids.push(h('div', { class: 'sec-title' }, '領域地圖'), h('div', { class: 'grid' }, tiles));
  }
  // 區塊
  const counts = new Map();
  for (const d of cat.docs) if (d.s != null || /\.(pdf|html?)$/i.test(d.p)) counts.set(d.l, (counts.get(d.l) || 0) + 1);
  const order = laneOrder();
  const lanes = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  kids.push(h('div', { class: 'sec-title' }, '全部內容'),
    h('div', { class: 'grid' }, lanes.map((l) => h('a', { class: 'tile', href: '#/l/' + enc(l) }, h('span', { class: 't' }, laneName(l)), h('span', { class: 'm' }, `${counts.get(l)} 則`)))));
  // 最近
  const skip = new Set(ui.recent_exclude || []);
  const recent = cat.docs.filter((d) => d.d && d.p.endsWith('.md') && !skip.has(d.l))
    .sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 15);
  kids.push(h('div', { class: 'sec-title' }, '最近新增'), h('ul', { class: 'list' }, recent.map((d) => itemLink(d))));
  const st = (await kvGet('state')) || {};
  if (st.syncedAt) kids.push(h('p', { class: 'muted' }, `資料版本 ${String(cat.source_commit || '').slice(0, 7)}，同步於 ${new Date(st.syncedAt).toLocaleString('zh-TW')}`));
  setView(...kids);
}

async function viewLane(lane) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const docs = cat.docs.filter((d) => d.l === lane && (d.s != null || /\.(pdf|html?|mp4)$/i.test(d.p)));
  docs.sort((a, b) => (b.d ? String(b.d) : '').localeCompare(a.d ? String(a.d) : '') || a.p.localeCompare(b.p));
  const list = h('ul', { class: 'list' });
  let shown = 0;
  const more = h('button', { class: 'more', type: 'button' }, '再多 100 則');
  const add = () => {
    for (const d of docs.slice(shown, shown + 100)) list.append(itemLink(d));
    shown = Math.min(docs.length, shown + 100);
    more.hidden = shown >= docs.length;
  };
  more.addEventListener('click', add);
  add();
  setView(h('h1', null, laneName(lane)), h('p', { class: 'muted' }, `${docs.length} 則`), list, more);
}

function notionButtons(nid) {
  return [
    h('a', { class: 'btn', href: `notion://www.notion.so/${nid}` }, 'Notion App'),
    h('a', { class: 'btn', href: `https://www.notion.so/${nid}`, target: '_blank', rel: 'noopener noreferrer' }, 'Notion 網頁'),
  ];
}

async function viewPage(path) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const d = cat.byPath.get(path);
  if (!d) return setView(h('h1', null, '找不到這一頁'), h('p', { class: 'muted' }, path));
  const head = h('div', { class: 'doc-head' }, h('div', { class: 'path' }, d.p), h('h1', null, docTitle(d)));
  const chips = h('div', { class: 'chips' }, [laneName(d.l), d.k, d.d && String(d.d).slice(0, 10), d.a, d.src, d.unrev && '未審']
    .filter(Boolean).map((x) => h('span', { class: 'chip' }, x)));
  const actions = h('div', { class: 'doc-actions' });
  if (d.nid) actions.append(...notionButtons(d.nid));
  if (d.u && /^https?:/i.test(d.u)) actions.append(h('a', { class: 'btn', href: d.u, target: '_blank', rel: 'noopener noreferrer' }, '原文'));
  const body = h('div');
  const ext = extOf(d.p);
  if (d.s != null) {
    const text = await docText(d);
    if (text == null) body.append(h('p', { class: 'note' }, '這一頁的內容還沒同步。'));
    else if (ext === 'md') body.append(renderMarkdown(splitFrontmatter(text).body, d.p));
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
      else if (ext === 'html' || ext === 'htm') body.append(await htmlFrame(b), h('p', { class: 'muted' }, 'HTML 頁在隔離框架中執行，讀不到 App 的資料。'));
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
    kids.push(h('div', { class: 'sec-title' }, `引用的來源（${outs.length}）`),
      h('ul', { class: 'list' }, outs.slice(0, 60).map((x) => itemLink(x, h('span', { class: 'm' }, h('a', { href: `notion://www.notion.so/${x.nid}` }, '在 Notion App 開啟'))))));
  }
  const backs = (L.back.get(d.p) || []).map((p) => cat.byPath.get(p)).filter(Boolean);
  if (backs.length) kids.push(h('div', { class: 'sec-title backlinks' }, `被引用（${backs.length}）`), h('ul', { class: 'list' }, backs.slice(0, 200).map((x) => itemLink(x))));
  setView(...kids);
  await hydrateMedia(view);
}
function mimeOf(p) {
  return ({ webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', html: 'text/html', htm: 'text/html' })[extOf(p)] || 'application/octet-stream';
}
function csvTable(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < 2000; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [hd, ...rest] = rows;
  const t = h('table', { class: 'csv' }, h('thead', null, h('tr', null, (hd || []).map((x) => h('th', null, x)))),
    h('tbody', null, rest.map((r) => h('tr', null, r.map((x) => h('td', null, x))))));
  return h('div', { class: 'table-wrap' }, t);
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
  const t0 = performance.now();
  const { ids, toks } = await search(q);
  if (!toks.length) return setView(h('h1', null, '搜尋'), h('p', { class: 'muted' }, '請輸入至少兩個字。'));
  const ql = q.trim().toLowerCase();
  let cands = ids.map((i) => cat.docs[i]);
  // 標題命中排前面，其餘依日期新到舊
  cands.sort((a, b) => (docTitle(b).toLowerCase().includes(ql) - docTitle(a).toLowerCase().includes(ql)) || String(b.d || '').localeCompare(String(a.d || '')));
  const laneCounts = new Map();
  for (const d of cands) laneCounts.set(d.l, (laneCounts.get(d.l) || 0) + 1);
  const state = { lane: null };
  const list = h('ul', { class: 'list' });
  const info = h('p', { class: 'muted' });
  const chipRow = h('div', { class: 'chips' });
  const render = async () => {
    list.replaceChildren();
    const pool = state.lane ? cands.filter((d) => d.l === state.lane) : cands;
    let shown = 0, checked = 0;
    for (const d of pool) {
      if (shown >= 50 || checked >= 200) break;
      checked++;
      const text = await docText(d);
      const sn = text ? snippet(text, q.trim()) : null;
      const titleHit = docTitle(d).toLowerCase().includes(ql);
      if (!sn && !titleHit) continue;   // 二字組都在但整串不連續：略過
      shown++;
      list.append(itemLink(d, sn ? h('span', { class: 'snip' }, sn.pre, h('mark', null, sn.hit), sn.post) : null));
    }
    info.textContent = `${pool.length} 則候選，顯示前 ${shown} 則完全符合（${Math.round(performance.now() - t0)} ms）`;
    if (!shown) list.append(h('li', null, h('p', { class: 'muted' }, '沒有完全符合的結果。')));
  };
  chipRow.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: (e) => pick(e, null) }, `全部 ${cands.length}`),
    ...[...laneCounts].sort((a, b) => b[1] - a[1]).map(([l, c]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => pick(e, l) }, `${laneName(l)} ${c}`)));
  function pick(e, lane) {
    state.lane = lane;
    chipRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    render();
  }
  setView(h('h1', null, `「${q}」`), chipRow, info, list);
  await render();
}

async function viewSettings() {
  const cfg = (await kvGet('config')) || {};
  const st = (await kvGet('state')) || {};
  const repo = h('input', { id: 'cfg-repo', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'owner/repo', value: cfg.repo || '' });
  const token = h('input', { id: 'cfg-token', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: cfg.token ? '（已存，留空表示不變）' : 'github_pat_…' });
  const out = h('p', { class: 'muted', role: 'status' });
  const prog = h('progress', { max: '100', value: '0', hidden: true });
  const syncBtn = h('button', { type: 'button', class: 'primary' }, '同步');
  const info = h('dl', { class: 'kv' });
  const fillInfo = async () => {
    info.replaceChildren();
    const s = (await kvGet('state')) || {};
    const add = (k, v) => info.append(h('dt', null, k), h('dd', null, v));
    add('上次同步', s.syncedAt ? new Date(s.syncedAt).toLocaleString('zh-TW') : '尚未');
    add('資料版本', s.commit ? s.commit.slice(0, 7) : '—');
    if (navigator.storage && navigator.storage.estimate) {
      try { const e = await navigator.storage.estimate(); add('手機已用', `${fmtMB(e.usage || 0)}／配額 ${fmtMB(e.quota || 0)}`); } catch (e) { /* 略過 */ }
    }
    if (navigator.storage && navigator.storage.persisted) {
      try { add('持久儲存', (await navigator.storage.persisted()) ? '是' : '否'); } catch (e) { /* 略過 */ }
    }
  };
  syncBtn.addEventListener('click', async () => {
    const r = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const tk = token.value.trim() || cfg.token;
    if (!(r === 'local' || /^[\w.-]+\/[\w.-]+$/.test(r)) || (!tk && r !== 'local')) { out.textContent = '請填 repo（擁有者/名稱）與 token。'; return; }
    await kvSet('config', { repo: r, token: tk });
    token.value = '';
    syncBtn.disabled = true; prog.hidden = false;
    try {
      const res = await runSync((p) => {
        if (p.phase === 'tree') { out.textContent = '讀取檔案清單…'; return; }
        prog.max = Math.max(1, p.totalBytes); prog.value = p.doneBytes;
        out.textContent = p.totalFiles ? `下載中 ${p.doneFiles}／${p.totalFiles} 個檔（${fmtMB(p.doneBytes)}／${fmtMB(p.totalBytes)}）${p.failed ? `，失敗 ${p.failed}` : ''}` : '已是最新，沒有要下載的檔。';
      });
      if (res.busy) out.textContent = '已在同步中。';
      else if (res.complete) out.textContent = `同步完成：下載 ${res.downloaded} 個檔，移除 ${res.removed} 個舊檔。`;
      else if (res.stopErr && res.stopErr.rateLimited) out.textContent = `GitHub 每小時額度用完，已下載的都保留了。${res.rate && res.rate.reset ? new Date(res.rate.reset * 1000).toLocaleTimeString('zh-TW') + ' 後' : '稍後'}再按一次同步會接著下載。`;
      else if (res.stopErr) out.textContent = `同步中止：${res.stopErr.message}（token 無效或過期？）`;
      else out.textContent = `同步未完成：${res.failed} 個檔下載失敗，再按一次同步會補抓。`;
    } catch (e) {
      out.textContent = '同步失敗：' + (e.message || e);
    } finally {
      syncBtn.disabled = false; prog.hidden = true; fillInfo();
    }
  });
  const clearBtn = h('button', { type: 'button' }, '刪除手機上的全部資料');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('刪除這支手機上的全部資料與 token？（資料 repo 不受影響，之後可以重新同步）')) return;
    resetCaches();
    const d = await db(); d.close(); dbp = null;
    await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = res; });
    location.hash = '#/settings';
    viewSettings();
  });
  setView(h('h1', null, '設定與同步'),
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('label', { for: 'cfg-repo' }, '資料 repo（擁有者/名稱）'), repo),
      h('div', { class: 'field' }, h('label', { for: 'cfg-token' }, '唯讀 token'), token),
      h('div', { class: 'row' }, syncBtn), prog, out),
    h('div', { class: 'card' }, info),
    h('p', { class: 'muted' }, 'repo 名稱與 token 只存在這支手機。token 到期後，在這裡貼上新的再同步即可。'),
    h('div', { class: 'row' }, clearBtn));
  fillInfo();
}

/* ════════ 路由 ════════ */
async function route() {
  const hash = location.hash || '#/';
  try {
    if (hash.startsWith('#/p/')) await viewPage(dec(hash.slice(4)));
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
window.addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
