// OM Reader——網址清理（本人 2026-11-06 起）：在頂端搜尋框貼網址就到這裡，不搜內容。
// - Threads：貼文網址本身不需要任何參數，一律全拿掉（xmt＝誰分享的、slof 也是分享參數）
// - 其他網站：只拿掉已知的追蹤參數；X 另拿 s、t（別的網站的 t 可能是時間，不動）
// - threads.com/share/<代碼>/：分享者資訊就是網址本身，要由 Threads 伺服器轉址才知道是哪一篇。
//   瀏覽器不讓網頁讀別站的轉址、iPhone 上 Safari 打開又會被 Threads App 接走，所以交給本人自己 Google 帳號裡的
//   Apps Script 代為打開（只接受 Threads 分享網址；分享代碼只經過本人的 Google 與 Threads）。
//   它的網址由本人在同步頁填、加密存在各台裝置，不寫進這個公開的程式殼（2026-11-16 iPhone 實測可用）
'use strict';

const TRACK_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igsh|igshid|si|xmt|slof|ref_src|ref_url)$/i;
const X_TRACK = /^(s|t)$/;
const PARAM_NAMES = { xmt: 'xmt（誰分享的）', slof: 'slof', si: 'si（分享追蹤）', igsh: 'igsh（分享追蹤）', igshid: 'igshid（分享追蹤）', fbclid: 'fbclid（點擊追蹤）' };
const RESOLVER_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

// 回傳 { url, host, removed: [參數名…], share: 是不是 Threads 分享代碼網址 }；不是網址回 null
function cleanUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const threads = /^threads\.(com|net)$/.test(host);
  const isX = /^(x|twitter)\.com$/.test(host);
  const removed = [];
  for (const k of [...u.searchParams.keys()]) {
    if (threads || TRACK_PARAMS.test(k) || (isX && X_TRACK.test(k))) { removed.push(k); u.searchParams.delete(k); }
  }
  if (u.hash === '#') u.hash = '';
  return { url: u.toString(), host, removed: [...new Set(removed)], share: threads && /^\/share\//.test(u.pathname) };
}

/* ── 分享代碼網址的轉換服務（Apps Script） ── */
const RESOLVER_SCRIPT = `// OM Reader：還原 Threads 分享網址（只接受 threads.com/share/…）
function doGet(e) {
  var u = (e && e.parameter && e.parameter.u) || '';
  if (!/^https:\\/\\/(www\\.)?threads\\.(com|net)\\/share\\/[A-Za-z0-9_-]+\\/?$/.test(u)) return out({ error: '只接受 Threads 分享網址' });
  for (var i = 0; i < 4; i++) {
    var r = UrlFetchApp.fetch(u, { followRedirects: false, muteHttpExceptions: true });
    var h = r.getHeaders();
    var loc = h.Location || h.location;
    if (!loc) return out({ error: 'Threads 沒有轉址（HTTP ' + r.getResponseCode() + '）' });
    u = loc.indexOf('http') === 0 ? loc : 'https://www.threads.com' + loc;
    if (!/\\/share\\//.test(u)) return out({ url: u });
  }
  return out({ error: '轉址太多次' });
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`;

async function resolverUrl() {
  const rec = await kvGet('resolver');
  if (!rec || !KEY) return '';
  try { return td.decode(await open_(rec)); } catch (e) { return ''; }
}
async function resolveShare(url) {
  const base = await resolverUrl();
  if (!base) { const e = new Error('還沒設定'); e.unset = true; throw e; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${base}?u=${encodeURIComponent(url)}`, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    const j = await r.json();
    if (!j.url) throw new Error(j.error || '沒有拿到網址');
    return j.url;
  } catch (e) { throw e.name === 'AbortError' ? new Error('轉換服務 20 秒沒有回應') : e; }
  finally { clearTimeout(timer); }
}

/* ── 結果頁 ── */
async function viewCleanUrl(raw) {
  const head = h('h1', null, '網址清理');
  let r = cleanUrl(raw);
  if (!r) return setView(head, h('p', { class: 'empty-box' }, '這看起來不是完整的網址。'));
  let restored = false;
  if (r.share) {   // 先還原成貼文網址，再照一般 Threads 網址清
    setView(head, h('p', { class: 'muted' }, '還原 Threads 分享網址中…'));
    try {
      const r2 = cleanUrl(await resolveShare(r.url));
      if (!r2 || r2.share) throw new Error('還原出來的不是貼文網址');
      r = r2; restored = true;
    } catch (e) {
      return setView(head, h('div', { class: 'note' },
        h('p', null, 'threads.com/share/… 是分享代碼網址：分享者的資訊就在網址裡，要先還原成貼文網址。'),
        h('p', null, e.unset ? '還沒設定轉換服務：到「同步」頁的「網址清理」設定一次，之後貼上就會自動還原。' : '還原失敗：' + (e.message || e))),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/settings' }, '到同步頁')));
    }
  }
  const status = h('p', { class: 'status', role: 'status' });
  const what = [restored ? '已還原 Threads 分享網址' : '', r.removed.length ? '拿掉 ' + r.removed.map((k) => PARAM_NAMES[k] || k).join('、') : ''].filter(Boolean).join('；');
  setView(head, h('p', { class: 'page-sub' }, r.host),
    h('div', { class: 'card clean-url' }, h('p', { class: 'clean-out' }, r.url),
      h('p', { class: 'muted' }, what || '這個網址沒有要拿掉的追蹤參數。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: async () => { status.textContent = (await copyText(r.url)) ? '已複製。' : '自動複製失敗，請長按上面的網址複製。'; } }, '複製'),
        h('a', { class: 'btn', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '打開')),
      status));
  if (what) copyText(r.url).then((ok) => { if (ok) status.textContent = '已自動複製。'; });
}

/* ── 同步頁「網址清理」：設定好之後只留一行狀態與「測試」，設定步驟收進「重新設定」 ── */
async function resolverSection() {
  const cur = await resolverUrl();
  const out = h('p', { class: 'status', role: 'status' });
  const input = h('input', { id: 'resolver-url', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://script.google.com/macros/s/…/exec', value: cur });
  const save = h('button', { type: 'button', class: 'btn' }, '儲存');
  save.addEventListener('click', async () => {
    const v = input.value.trim();
    if (v && !RESOLVER_RE.test(v)) { out.textContent = '網址應該長這樣：https://script.google.com/macros/s/…/exec'; return; }
    await kvSet('resolver', v ? await seal(te.encode(v)) : null);
    out.textContent = v ? '已儲存。按「測試」確認一下。' : '已清除。';
  });
  const runTest = async () => {
    out.textContent = '測試中…';
    try { out.textContent = '可以用：' + cleanUrl(await resolveShare('https://www.threads.com/share/BAOMwSwmDa/')).url; }
    catch (e) { out.textContent = e.unset ? '先貼上網址並儲存。' : '測試失敗：' + (e.message || e); }
  };
  const testBtn = () => h('button', { type: 'button', class: 'btn', onclick: runTest }, '測試');   // 上方一顆、設定裡一顆
  const copy = h('button', { type: 'button', class: 'btn' }, '複製程式碼');
  copy.addEventListener('click', async () => { out.textContent = (await copyText(RESOLVER_SCRIPT)) ? '已複製程式碼。' : '自動複製失敗，請長按下面的程式碼複製。'; });
  const setup = h('details', { class: 'set-more', open: !cur }, h('summary', null, cur ? '重新設定' : '設定 Threads 分享網址的轉換服務（只需一次）'),
    h('ol', { class: 'steps' },
      h('li', null, '在 script.google.com 新增專案，內容整個換成下面的程式碼，儲存。'),
      h('li', null, '「部署」→「新增部署作業」→ 網頁應用程式；執行身分「我」、誰可以存取「所有人」→ 部署，照提示授權。'),
      h('li', null, '把「網頁應用程式」網址（…/exec）貼到下面，按「儲存」再按「測試」。')),
    h('div', { class: 'row' }, copy),
    h('pre', { class: 'raw wrap resolver-code' }, RESOLVER_SCRIPT),
    h('div', { class: 'field' }, h('label', { for: 'resolver-url' }, 'Apps Script 網頁應用程式網址'), input),
    h('div', { class: 'row' }, save, testBtn()),
    h('p', { class: 'muted' }, '它只接受 Threads 分享網址；分享代碼只經過你自己的 Google 與 Threads。網址加密存在這台裝置，每台裝置各設定一次。'));
  return [secTitle('網址清理'), h('div', { class: 'card' },
    h('p', { class: 'muted set-line' }, cur ? '在頂端搜尋框貼網址就會清掉追蹤；Threads 分享網址（threads.com/share/…）會自動還原。' : '在頂端搜尋框貼網址就會清掉追蹤；Threads 分享網址要先設定下面的轉換服務。'),
    cur ? h('div', { class: 'row' }, testBtn()) : null, out, setup)];
}
