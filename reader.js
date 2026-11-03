// OM Reader——閱讀：Markdown 渲染、搜尋、區塊名稱、看過、各個閱讀畫面（首頁、分類、清單、課程、文章、搜尋）。
'use strict';

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
  if (d.on) bits.push(`出現在〈${d.on}〉${d.on_n > 1 ? `等 ${d.on_n} 篇` : ''}`);   // 附件：檔名不改，標出用在哪篇筆記
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
// 每個畫面一個 AbortController：畫面換掉時，掛在播放器或 window 上的監聽一併拿掉
let viewAbort = new AbortController();
function setView(...kids) {
  if (typeof playerRelease === 'function') playerRelease();   // 借進頁面的播放畫面先還回底部
  viewAbort.abort();
  viewAbort = new AbortController();
  view.replaceChildren(...kids.filter((k) => k != null));
  window.scrollTo(0, 0);
}
// 返回快取：文章、清單、搜尋、分類離開時把整個畫面（含展開筆數、篩選、捲動位置）留著，回來直接還原
const viewCache = new Map();
let curHash = null;
const CACHEABLE = /^#\/(p|l|s|c)\/|^#\/browse/;
function stashView() {
  if (typeof playerRelease === 'function') playerRelease();
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
  if (hist.length) kids.push(secTitle('繼續看', '#/history', '全部看過'), listOf(hist.map((d) => itemLink(d, null, { resume: true }))));
  if (typeof continueSection === 'function') kids.push(...await continueSection().catch(() => []));
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

// 看過：筆記（這支手機的閱讀紀錄）＋講次（學習紀錄的「最近開過」）＋練習（練習進度），合在一起依日期排。
// 從首頁「繼續看」「繼續上課」的「全部」進來；?k=note｜lesson｜practice 只看一種。
async function viewHistory(qs) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const want = new URLSearchParams(qs || '').get('k') || 'all';
  const toMs = (s) => { const t = typeof recTime === 'function' ? recTime(s) / 1000 : Date.parse(s); return Number.isFinite(t) ? t : 0; };
  const hm = (at) => new Date(at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const rows = [];
  for (const x of await getHistory()) {
    const d = cat.byPath.get(x.p);
    if (d) rows.push({ k: 'note', at: x.at, li: () => itemLink(d, h('span', { class: 'm' }, hm(x.at)), { resume: true }) });
  }
  if (typeof lrec === 'function') {
    await lrec();
    const ci = await courseIndex().catch(() => null);
    if (ci) {
      for (const [id, r] of Object.entries(LREC.recent)) {
        const x = ci.lessonById.get(id);
        if (!x) continue;
        const at = toMs(r.at);
        rows.push({ k: 'lesson', at, li: () => {
          const p = lessonProgress(x.lesson);
          const state = p ? (p.completed ? '・已看完' : `・看到 ${clock(p.t_s)}${p.pct != null ? `（${p.pct}%）` : ''}`) : '';
          return h('li', null, areaColor(h('a', { class: 'item', href: '#/lesson/' + encodeURIComponent(x.lesson.id) },
            h('span', { class: 't' }, `${x.lesson.order ? x.lesson.order + '　' : ''}${x.lesson.lesson_title || x.lesson.title}`),
            h('span', { class: 'm' }, `講次・${x.course.title}・${hm(at)}${state}`)), null, x.course.category));
        } });
      }
    }
    const pd = typeof practiceData === 'function' ? await practiceData().catch(() => null) : null;
    if (pd) {
      for (const [id, r] of Object.entries(LREC.practice_progress)) {
        const it = pd.byId.get(id);
        if (!it) continue;
        const at = toMs(r.at);
        rows.push({ k: 'practice', at, li: () => h('li', null, h('a', { class: 'item', href: '#/practice/item/' + encodeURIComponent(id) },
          h('span', { class: 't' }, it.title),
          h('span', { class: 'm' }, `練習・${[it.style, it.teacher].filter(Boolean).join('・')}・${hm(at)}`))) });
      }
    }
  }
  rows.sort((a, b) => b.at - a.at);
  const KINDS = [['all', '全部'], ['note', '筆記'], ['lesson', '講次'], ['practice', '練習']];
  const count = (k) => (k === 'all' ? rows.length : rows.filter((r) => r.k === k).length);
  const chips = h('div', { class: 'filter-row' }, KINDS.filter(([k]) => k === 'all' || count(k)).map(([k, name]) =>
    h('button', { type: 'button', class: 'filter', 'aria-pressed': String(k === want), onclick: () => {
      const q = k === 'all' ? '' : 'k=' + k;
      history.replaceState(null, '', location.pathname + location.search + '#/history' + (q ? '?' + q : ''));
      viewHistory(q);
    } }, `${name} ${count(k)}`)));
  const shown = rows.filter((r) => want === 'all' || r.k === want).slice(0, 200);
  const dayKey = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = dayKey(Date.now());
  const label = (k) => (k === today ? '今天' : k === today - 86400000 ? '昨天' : new Date(k).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }));
  const groups = new Map();
  for (const r of shown) { const k = dayKey(r.at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const kids = [h('h1', null, '看過'), h('p', { class: 'page-sub' }, '筆記的紀錄只存在這支手機（加密，最近 100 頁）；講次與練習來自學習紀錄，會和電腦、其他裝置同步。'), chips];
  if (!shown.length) kids.push(h('p', { class: 'empty-box' }, '還沒有看過任何東西。'));
  for (const [k, xs] of groups) kids.push(secTitle(label(k)), listOf(xs.map((r) => r.li())));
  if ((want === 'all' || want === 'note') && rows.some((r) => r.k === 'note')) {
    const clear = h('button', { type: 'button', class: 'btn quiet' }, '清除筆記的閱讀紀錄');
    clear.addEventListener('click', async () => { await kvSet('history', await seal(te.encode('[]'))); viewHistory(qs); });
    kids.push(h('div', { class: 'row' }, clear));
  }
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
  const order = lane === 'wiki/MOC' && (ui.moc_order || []).length ? new Map(ui.moc_order.map((p, i) => [p, i])) : null;
  const dated = !order && docs.filter((d) => d.d).length >= docs.length * 0.6;
  if (order) docs.sort((a, b) => (order.get(a.p) ?? 999) - (order.get(b.p) ?? 999) || docTitle(a).localeCompare(docTitle(b), 'zh-Hant'));
  else if (dated) docs.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || a.p.localeCompare(b.p));
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
    sub.textContent = `${laneLabel(lane) ? laneLabel(lane) + '・' : ''}${pool.length.toLocaleString()} 則・${order ? '依領域地圖' : dated ? '新到舊' : '依名稱'}`;
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
  const onNote = d.onp && CAT.byPath.get(d.onp);
  if (onNote) chips.append(h('a', { class: 'tag', href: pageHref(onNote.p) }, `出現在〈${d.on}〉${d.on_n > 1 ? `等 ${d.on_n} 篇` : ''}`));
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
      else {
        const reader = h('div', { class: 'pdf-view' });
        const inApp = ext === 'pdf' && typeof pdfInto === 'function'
          ? h('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true; reader.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
            try { await pdfInto(reader, typed); } catch (err) { reader.replaceChildren(h('p', { class: 'note' }, 'App 內顯示失敗：' + err.message + '。可改用「開新視窗」。')); }
          } }, '在 App 內閱讀') : null;
        body.append(h('div', { class: 'card file-card' }, h('div', { class: 'file-ext' }, ext.toUpperCase() || '檔案'),
          h('div', { class: 'file-meta' }, h('div', { class: 't' }, basename(d.p)), h('div', { class: 'muted' }, fmtMB(b.size))),
          h('div', { class: 'row' }, inApp, h('a', { class: inApp ? 'btn' : 'btn primary', href: url, target: '_blank', rel: 'noopener' }, ext === 'pdf' ? (inApp ? '開新視窗' : '打開 PDF') : '打開檔案'))), reader);
      }
    }
  }
  const kids = [head, chips];
  if (actions.childElementCount) kids.push(actions);
  if (typeof conceptLessonRefs === 'function') { const refs = await conceptLessonRefs(d).catch(() => null); if (refs) kids.push(refs); }
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
    const lp = typeof lessonLinkFor === 'function' ? lessonLinkFor(d.p) : null;
    if (lp) row.append(h('a', { class: 'btn primary', href: lp }, '講次頁（播放＋逐字稿）'));
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
