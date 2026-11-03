// OM 影音測試頁——驗證正式 App「在 App 內播放雲端硬碟影音、顯示講義 PDF、把紀錄寫回雲端硬碟」的前提。
// 不載入任何外部程式；網路只連 www.googleapis.com（CSP 鎖定），登入用整頁跳轉到 accounts.google.com。
// Google token 只放記憶體（頁面與 Service Worker 各一份），不寫進儲存空間；結果摘要不含 token、ID、檔名。
'use strict';

const $ = (id) => document.getElementById(id);
const R = { login: {}, find: {}, play: { ranges: 0, r206: 0, r200: 0, synth: 0, unauth: 0, swRestarts: 0, events: [] },
  direct: {}, bg: [], links: {}, pdf: {}, write: {} };
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function kv(dl, k, v) { dl.append(el('dt', null, k), el('dd', null, v)); }
function step(list, ok, text) {
  const li = el('li');
  li.append(el('span', ok === true ? 'ok' : ok === false ? 'bad' : '', ok === true ? '通過　' : ok === false ? '失敗　' : '…　'), document.createTextNode(text));
  list.append(li);
  return li;
}
function store(kind) { try { return window[kind]; } catch (e) { return null; } }
function sGet(kind, k) { try { return store(kind).getItem(k); } catch (e) { return null; } }
function sSet(kind, k, v) { try { store(kind).setItem(k, v); } catch (e) { /* 封鎖時略過 */ } }
function sDel(kind, k) { try { store(kind).removeItem(k); } catch (e) { /* 封鎖時略過 */ } }
const fmtT = (s) => {
  if (!isFinite(s)) return '—';
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtMB = (b) => (Number(b) / 1048576).toFixed(1) + ' MB';
const clock = () => new Date().toTimeString().slice(0, 8);

/* ── 0 環境 ─────────────────────────────────────────── */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function device() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  return /Android/.test(ua) ? 'Android' : '電腦';
}
function iosVersion() {
  const m = navigator.userAgent.match(/OS (\d+)[._](\d+)(?:[._](\d+))? like Mac OS X/)
    || navigator.userAgent.match(/Version\/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? m.slice(1).filter(Boolean).join('.') : '（無法辨識）';
}
function renderEnv() {
  const dl = $('env');
  dl.textContent = '';
  kv(dl, '開啟方式', isStandalone() ? '主畫面 App' : 'Safari 分頁（請改從主畫面開）');
  kv(dl, '裝置', device());
  kv(dl, '系統版本', iosVersion());
  kv(dl, 'Service Worker', SW.state);
  kv(dl, 'Media Session', 'mediaSession' in navigator ? '有' : '無');
  kv(dl, 'Wake Lock', 'wakeLock' in navigator ? '有' : '無');
  R.env = { standalone: isStandalone(), device: device(), os: iosVersion(), sw: SW.state };
  renderSummary();
}

/* ── Service Worker ─────────────────────────────────── */
const SW = { state: '未註冊', instance: null };
async function setupSW() {
  if (!('serviceWorker' in navigator)) { SW.state = '不支援'; return; }
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }
    SW.state = navigator.serviceWorker.controller ? '已接管這一頁' : '已安裝，但這一頁還沒被接管（請重新整理一次）';
  } catch (e) { SW.state = '註冊失敗：' + e.message; }
  navigator.serviceWorker.addEventListener('message', onSWMessage);
  swPost({ type: 'hello' });
  if (TOKEN) swPost({ type: 'token', token: TOKEN });
}
function swPost(msg) { const c = navigator.serviceWorker && navigator.serviceWorker.controller; if (c) c.postMessage(msg); }
function onSWMessage(ev) {
  const m = ev.data || {};
  if (m.instance && SW.instance && m.instance !== SW.instance) {
    R.play.swRestarts++;
    plog(null, `Service Worker 被系統重新啟動過（${SW.instance} → ${m.instance}）`);
  }
  if (m.instance) SW.instance = m.instance;
  if (m.type === 'need-token') {
    swPost({ type: 'token', token: TOKEN });
    plog(TOKEN ? true : false, TOKEN ? 'Service Worker 沒有 token，已從頁面補給它' : 'Service Worker 要 token，但頁面也沒有（請重新登入）');
  } else if (m.type === 'log') {
    R.play.ranges++;
    if (m.status === 206) R.play.r206++;
    if (m.status === 200) R.play.r200++;
    if (m.synthesized) R.play.synth++;
    const ok = m.status === 206 || m.status === 200;
    plog(ok, `請求 ${m.range || '（無 Range）'} → ${m.status}${m.contentRange ? '　' + m.contentRange : ''}${m.synthesized ? '（Content-Range 自己補的）' : ''}${m.tokenFromPage ? '（token 向頁面要回）' : ''}　${m.ms} ms`);
    renderSummary();
  } else if (m.type === 'unauthorized') {
    R.play.unauth++;
    plog(false, `雲端硬碟回 ${m.status}：token 失效。按「重新登入並回到目前時間」`);
    renderSummary();
  }
}

/* ── 1 Google 登入 ──────────────────────────────────── */
let TOKEN = null;
let TOKEN_EXP = 0;
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function startLogin(silent) {
  const client = $('g-client').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(client)) { step($('g-out'), false, '請先填 OAuth 用戶端 ID'); return; }
  sSet('localStorage', 'om-media-client', client);
  const state = Math.random().toString(36).slice(2);
  sSet('sessionStorage', 'om-media-state', state);
  sSet('localStorage', 'om-media-state', state);
  sSet('localStorage', 'om-media-left', JSON.stringify({ at: Date.now(), standalone: isStandalone(), silent: !!silent }));
  const p = new URLSearchParams({
    client_id: client, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPES,
    include_granted_scopes: 'true', state,
  });
  if (silent) p.set('prompt', 'none');
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}
function handleReturn() {
  const left = JSON.parse(sGet('localStorage', 'om-media-left') || 'null');
  if (!location.hash || !/(access_token|error)=/.test(location.hash)) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  sDel('localStorage', 'om-media-left');
  const out = $('g-out');
  const sState = sGet('sessionStorage', 'om-media-state');
  const lState = sGet('localStorage', 'om-media-state');
  const got = p.get('state');
  const L = R.login;
  L.silent = left ? left.silent : null;
  L.leftStandalone = left ? left.standalone : null;
  L.backStandalone = isStandalone();
  L.sessionKept = !!got && got === sState;
  L.stateOk = !!got && (got === sState || got === lState);
  L.secondsAway = left ? Math.round((Date.now() - left.at) / 1000) : null;
  step(out, L.backStandalone, L.backStandalone ? '跳回來時是在主畫面 App 裡' : '跳回來時不在主畫面 App（在 Safari 或 App 內瀏覽器）');
  step(out, L.stateOk, L.stateOk ? (L.sessionKept ? '登入前後是同一個頁面環境（sessionStorage 還在）' : '回來了，但 sessionStorage 不見（換了頁面環境，localStorage 還在）') : 'state 對不上：不是這次登入的回應');
  if (p.get('error')) {
    L.error = p.get('error');
    step(out, false, `Google 回應錯誤：${L.error}${L.silent ? '（靜默續期失敗：需要使用者互動）' : ''}`);
  } else if (L.stateOk && p.get('access_token')) {
    TOKEN = p.get('access_token');
    TOKEN_EXP = Date.now() + Number(p.get('expires_in') || 0) * 1000;
    L.ok = true;
    L.expiresMin = Math.round(Number(p.get('expires_in') || 0) / 60);
    L.scopes = (p.get('scope') || '').split(' ').map((s) => s.replace('https://www.googleapis.com/auth/', '')).filter(Boolean);
    step(out, true, `拿到 token，${L.expiresMin} 分鐘後失效；權限：${L.scopes.join('、')}`);
    swPost({ type: 'token', token: TOKEN });
  }
  sDel('sessionStorage', 'om-media-state');
  sDel('localStorage', 'om-media-state');
  renderSummary();
}
function renderTokenInfo() {
  const dl = $('g-info');
  dl.textContent = '';
  kv(dl, 'token', TOKEN ? `有，剩 ${Math.round((TOKEN_EXP - Date.now()) / 60000)} 分鐘` : '沒有');
}
async function gapi(path, opts = {}) {
  if (!TOKEN) throw new Error('還沒登入 Google');
  const res = await fetch(path.startsWith('http') ? path : API + path, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + TOKEN }, opts.headers || {}),
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  }));
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/* ── 2 找檔案 ───────────────────────────────────────── */
let CUR = null;   // { id, name, mimeType, size, … }
const FIELDS = 'id,name,mimeType,size,fileExtension,videoMediaMetadata,modifiedTime';
function qEsc(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
async function findFile() {
  const q = $('f-q').value.trim();
  const out = $('f-out');
  out.textContent = '';
  if (!q) return;
  sSet('localStorage', 'om-media-q', q);
  try {
    const idm = q.match(/\/d\/([A-Za-z0-9_-]{10,})/) || q.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || q.match(/^([A-Za-z0-9_-]{25,})$/);
    let files;
    if (idm) {
      files = [await (await gapi(`/files/${idm[1]}?fields=${FIELDS}`)).json()];
      R.find.by = 'ID';
    } else {
      const t0 = Date.now();
      const qs = new URLSearchParams({ q: `name = '${qEsc(q)}' and trashed = false`, fields: `files(${FIELDS})`, pageSize: '10' });
      files = (await (await gapi('/files?' + qs)).json()).files || [];
      R.find.by = '檔名';
      R.find.ms = Date.now() - t0;
      R.find.matches = files.length;
      step(out, files.length > 0, `用檔名找到 ${files.length} 個${files.length > 1 ? '（同名不只一個，正式版要處理）' : ''}　${R.find.ms} ms`);
    }
    if (!files.length) { CUR = null; R.find.ok = false; renderSummary(); return; }
    CUR = files[0];
    R.find.ok = true;
    const dl = $('f-info');
    dl.textContent = '';
    kv(dl, '檔名', CUR.name);
    kv(dl, '類型', CUR.mimeType);
    kv(dl, '大小', CUR.size ? fmtMB(CUR.size) : '—');
    const vm = CUR.videoMediaMetadata;
    if (vm) kv(dl, '影片', `${vm.width}×${vm.height}，${fmtT((vm.durationMillis || 0) / 1000)}`);
    R.find.kind = CUR.mimeType;
    R.find.sizeMB = CUR.size ? Math.round(CUR.size / 1048576) : null;
    R.find.hasDuration = !!(vm && vm.durationMillis);
    if (CUR.size) swPost({ type: 'size', id: CUR.id, size: Number(CUR.size) });
    renderLinks();
  } catch (e) {
    step(out, false, `查詢失敗：${e.message}${e.status === 401 ? '（token 失效，請重新登入）' : ''}`);
    R.find.ok = false;
  }
  renderSummary();
}
async function driveStats() {
  const out = $('f-out');
  const li = step(out, null, '統計中…');
  try {
    const count = {};
    let total = 0, pageToken = '', pages = 0;
    do {
      const qs = new URLSearchParams({ q: "(mimeType contains 'video/' or mimeType contains 'audio/') and trashed = false",
        fields: 'nextPageToken,files(fileExtension)', pageSize: '1000' });
      if (pageToken) qs.set('pageToken', pageToken);
      const j = await (await gapi('/files?' + qs)).json();
      for (const f of j.files || []) { const x = (f.fileExtension || '（無）').toLowerCase(); count[x] = (count[x] || 0) + 1; total++; }
      pageToken = j.nextPageToken || '';
      pages++;
    } while (pageToken && pages < 30);
    R.find.stats = count;
    li.remove();
    const list = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、');
    const bad = ['mkv', 'avi', 'webm', 'wmv', 'flv'].filter((x) => count[x]);
    step(out, bad.length === 0, `雲端硬碟影音共 ${total} 個：${list}${bad.length ? `。iPhone／iPad 可能播不了：${bad.join('、')}` : ''}`);
  } catch (e) { li.remove(); step(out, false, '統計失敗：' + e.message); }
  renderSummary();
}

/* ── 3 在 App 裡播放 ────────────────────────────────── */
const v = $('v');
function plog(ok, text) {
  const list = $('p-log');
  const li = step(list, ok, `${clock()}　${text}`);
  list.scrollTop = list.scrollHeight;
  return li;
}
let seekTarget = null;
let pastExpiry = { playedAfter: 0, lastCt: null };
function loadPlayer(resumeAt) {
  if (!CUR) { plog(false, '請先在第 2 節找到檔案'); return; }
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { plog(false, '這一頁還沒被 Service Worker 接管，請重新整理一次'); return; }
  R.play.loadedAt = Date.now();
  R.play.kind = CUR.mimeType;
  v.src = './drive-media/' + CUR.id;
  if (resumeAt) {
    v.addEventListener('loadedmetadata', () => { v.currentTime = resumeAt; seekTarget = { t: resumeAt, at: Date.now(), label: '回到登入前的位置' }; }, { once: true });
  }
  v.load();
  plog(null, `載入 ${CUR.mimeType}`);
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'OM 影音測試', artist: 'OM' }); } catch (e) { /* 略過 */ }
  }
}
function seekTo(frac, label) {
  if (!isFinite(v.duration)) { plog(false, '還沒拿到長度，先按播放'); return; }
  const t = frac >= 0 ? v.duration * frac : Math.max(0, v.duration + frac);
  seekTarget = { t, at: Date.now(), label };
  v.currentTime = t;
}
const EV = ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'seeked', 'ended', 'error'];
for (const name of EV) {
  v.addEventListener(name, () => {
    const left = TOKEN ? Math.round((TOKEN_EXP - Date.now()) / 60000) : null;
    let text = `${name}　位置 ${fmtT(v.currentTime)}`;
    let ok = null;
    if (name === 'loadedmetadata') { ok = true; text += `　長度 ${fmtT(v.duration)}`; R.play.metaMs = Date.now() - R.play.loadedAt; R.play.duration = Math.round(v.duration / 60); }
    if (name === 'playing' && !R.play.firstPlayMs) { R.play.firstPlayMs = Date.now() - R.play.loadedAt; ok = true; }
    if (name === 'seeked' && seekTarget) {
      const ms = Date.now() - seekTarget.at;
      ok = Math.abs(v.currentTime - seekTarget.t) < 3;
      text += `　（${seekTarget.label}，${ms} ms）`;
      R.play[seekTarget.label] = ok ? `${ms} ms` : '位置不對';
      seekTarget = null;
    }
    if (name === 'error') { ok = false; text += `　錯誤碼 ${v.error && v.error.code}${v.error && v.error.message ? '：' + v.error.message : ''}`; R.play.error = v.error && v.error.code; }
    if (name === 'stalled' || name === 'waiting') ok = null;
    if (name === 'ended') ok = true;
    if (left != null) text += `　token 剩 ${left} 分`;
    R.play.events.push(name);
    plog(ok, text);
    renderSummary();
  });
}
setInterval(() => {
  renderTokenInfo();
  const dl = $('p-info');
  dl.textContent = '';
  kv(dl, '位置', `${fmtT(v.currentTime)} ／ ${fmtT(v.duration)}`);
  let buf = '';
  for (let i = 0; i < v.buffered.length; i++) buf += `${fmtT(v.buffered.start(i))}–${fmtT(v.buffered.end(i))} `;
  kv(dl, '已緩衝', buf || '—');
  kv(dl, '狀態', v.paused ? '暫停' : '播放中');
  // token 到期之後還在播嗎？
  if (TOKEN && Date.now() > TOKEN_EXP && !v.paused) {
    if (pastExpiry.lastCt != null && v.currentTime > pastExpiry.lastCt) pastExpiry.playedAfter += v.currentTime - pastExpiry.lastCt;
    pastExpiry.lastCt = v.currentTime;
    R.play.playedAfterExpiryS = Math.round(pastExpiry.playedAfter);
  }
  R.play.maxPos = Math.max(R.play.maxPos || 0, Math.round(v.currentTime / 60));
}, 1000);
function relogin() {
  if (!CUR) { plog(false, '請先找到檔案'); return; }
  sSet('sessionStorage', 'om-media-resume', JSON.stringify({ id: CUR.id, t: v.currentTime || 0 }));
  sSet('localStorage', 'om-media-resume', JSON.stringify({ id: CUR.id, t: v.currentTime || 0 }));
  startLogin(false);
}
async function resumeAfterLogin() {
  const raw = sGet('sessionStorage', 'om-media-resume') || sGet('localStorage', 'om-media-resume');
  sDel('sessionStorage', 'om-media-resume');
  sDel('localStorage', 'om-media-resume');
  if (!raw || !TOKEN) return;
  const r = JSON.parse(raw);
  try {
    CUR = await (await gapi(`/files/${r.id}?fields=${FIELDS}`)).json();
    if (CUR.size) swPost({ type: 'size', id: CUR.id, size: Number(CUR.size) });
    renderLinks();
    R.play.resume = '已載入';
    plog(null, `登入回來，接著播放（${fmtT(r.t)}）`);
    loadPlayer(r.t);
  } catch (e) { R.play.resume = '失敗：' + e.message; plog(false, '接著播放失敗：' + e.message); }
}

/* ── 4 直接網址 ─────────────────────────────────────── */
function loadDirect() {
  const out = $('d-out');
  out.textContent = '';
  if (!CUR || !TOKEN) { step(out, false, '請先登入並找到檔案'); return; }
  const v2 = $('v2');
  const t0 = Date.now();
  v2.onloadedmetadata = () => { R.direct.ok = true; R.direct.ms = Date.now() - t0; step(out, true, `拿到長度 ${fmtT(v2.duration)}（${R.direct.ms} ms），按播放與拖動試試`); renderSummary(); };
  v2.onerror = () => { R.direct.ok = false; R.direct.code = v2.error && v2.error.code; step(out, false, `播放器錯誤碼 ${R.direct.code}：雲端硬碟不接受網址上的 token，或格式不支援`); renderSummary(); };
  v2.onseeked = () => { R.direct.seek = true; step(out, true, `拖動成功：${fmtT(v2.currentTime)}`); renderSummary(); };
  v2.src = `${API}/files/${CUR.id}?alt=media&access_token=${encodeURIComponent(TOKEN)}`;
  v2.load();
}

/* ── 5 背景、鎖定螢幕、墊旁 ─────────────────────────── */
let hidden = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hidden = { at: Date.now(), ct: v.currentTime, playing: !v.paused };
    return;
  }
  if (!hidden) return;
  const away = Math.round((Date.now() - hidden.at) / 1000);
  const adv = Math.round(v.currentTime - hidden.ct);
  if (hidden.playing && away >= 20) {
    const kept = adv >= away * 0.8;
    R.bg.push({ away, adv, kept, nowPlaying: !v.paused });
    step($('b-out'), kept, `離開 ${away} 秒，期間播了 ${adv} 秒${kept ? '：背景繼續播放' : '：背景時停住了'}；回來時${v.paused ? '是暫停' : '仍在播放'}`);
    renderSummary();
  }
  if (WAKE.want && !WAKE.lock) requestWake();
  hidden = null;
});
const WAKE = { want: false, lock: null };
async function requestWake() {
  WAKE.want = true;
  if (!('wakeLock' in navigator)) { R.wake = '不支援'; step($('b-out'), false, '這個系統不支援保持螢幕亮著'); renderSummary(); return; }
  try {
    WAKE.lock = await navigator.wakeLock.request('screen');
    R.wake = '成功';
    step($('b-out'), true, '已保持螢幕亮著：放著不動 2 分鐘，看螢幕會不會自己變暗');
    WAKE.lock.addEventListener('release', () => { WAKE.lock = null; });
  } catch (e) { R.wake = '失敗：' + e.name; step($('b-out'), false, '保持螢幕亮著失敗：' + e.message); }
  renderSummary();
}

/* ── 6 到雲端硬碟播放（手動回報） ───────────────────── */
function chipSet(box, key, label, options, target) {
  const wrap = el('div', 'field');
  wrap.append(el('label', null, label));
  const row = el('div', 'chips');
  for (const opt of options) {
    const b = el('button', null, opt);
    b.type = 'button';
    b.setAttribute('aria-pressed', target[key] === opt ? 'true' : 'false');
    b.addEventListener('click', () => {
      target[key] = opt;
      for (const x of row.children) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      renderSummary();
    });
    row.append(b);
  }
  wrap.append(row);
  box.append(wrap);
}
const LINK_OPTS = ['開了雲端硬碟 App 並能播放', 'App 內的瀏覽器、已登入能播放', 'App 內的瀏覽器、要我登入', '沒反應或錯誤'];
function renderLinks() {
  const ul = $('l-links');
  ul.textContent = '';
  const box = $('l-chips');
  box.textContent = '';
  if (!CUR) return;
  const urls = [
    ['view', `https://drive.google.com/file/d/${CUR.id}/view`, '雲端硬碟檔案網址（/file/d/…/view）'],
    ['open', `https://drive.google.com/open?id=${CUR.id}`, '雲端硬碟開啟網址（open?id=…）'],
  ];
  for (const [key, href, hint] of urls) {
    const li = el('li');
    const a = el('a', null, hint);
    a.href = href;
    a.rel = 'noopener noreferrer';
    li.append(a);
    ul.append(li);
    chipSet(box, key, `「${hint}」的結果`, LINK_OPTS, R.links);
  }
}

/* ── 7 講義 PDF ─────────────────────────────────────── */
let pdfUrl = null;
async function getPdf() {
  const out = $('pdf-out');
  out.textContent = '';
  if (!CUR) { step(out, false, '請先在第 2 節找到 PDF'); return; }
  if (CUR.mimeType !== 'application/pdf') { step(out, false, `這個檔不是 PDF（${CUR.mimeType}）`); return; }
  try {
    const t0 = Date.now();
    const buf = await (await gapi(`/files/${CUR.id}?alt=media`)).arrayBuffer();
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    R.pdf.download = `${fmtMB(buf.byteLength)}，${Date.now() - t0} ms`;
    step(out, true, `下載完成：${R.pdf.download}`);
  } catch (e) { R.pdf.download = '失敗：' + e.message; step(out, false, '下載失敗：' + e.message); }
  renderSummary();
}
function pdfFrame() {
  if (!pdfUrl) { step($('pdf-out'), false, '請先下載'); return; }
  const box = $('pdf-box');
  box.textContent = '';
  const f = el('iframe');
  f.title = '講義';
  f.src = pdfUrl;
  box.append(f);
  box.hidden = false;
}
function pdfTab() {
  if (!pdfUrl) { step($('pdf-out'), false, '請先下載'); return; }
  const w = window.open(pdfUrl, '_blank');
  R.pdf.tabOpened = !!w;
  if (!w) step($('pdf-out'), false, '新視窗被擋（window.open 回傳空值）');
  renderSummary();
}

/* ── 8 寫回雲端硬碟 ─────────────────────────────────── */
async function writeTest() {
  const out = $('w-out');
  out.textContent = '';
  const W = R.write;
  try {
    const t0 = Date.now();
    const fq = new URLSearchParams({ q: "name = 'OM App 測試' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false", fields: 'files(id)' });
    let folder = ((await (await gapi('/files?' + fq)).json()).files || [])[0];
    if (!folder) {
      folder = await (await gapi('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'OM App 測試', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }) })).json();
      step(out, true, '建立資料夾「OM App 測試」');
    } else step(out, true, '找到資料夾「OM App 測試」');
    const name = `probe-${device()}.json`;
    const nq = new URLSearchParams({ q: `name = '${name}' and '${folder.id}' in parents and trashed = false`, fields: 'files(id)' });
    let file = ((await (await gapi('/files?' + nq)).json()).files || [])[0];
    const body1 = { device: device(), writtenAt: new Date().toISOString(), n: 1 };
    if (!file) {
      const boundary = 'om' + Math.random().toString(36).slice(2);
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
        + JSON.stringify({ name, parents: [folder.id], mimeType: 'application/json' })
        + `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body1)}\r\n--${boundary}--`;
      file = await (await gapi(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart })).json();
      step(out, true, `建立紀錄檔 ${name}`);
    } else {
      await gapi(`${UPLOAD}/files/${file.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body1) });
      step(out, true, `紀錄檔 ${name} 已存在，覆寫第 1 版`);
    }
    const body2 = Object.assign({}, body1, { n: 2, updatedAt: new Date().toISOString() });
    await gapi(`${UPLOAD}/files/${file.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body2) });
    step(out, true, '改寫成第 2 版');
    const back = await (await gapi(`/files/${file.id}?alt=media`)).json();
    W.ok = back.n === 2;
    W.ms = Date.now() - t0;
    step(out, W.ok, W.ok ? `讀回來是第 2 版，正確（全程 ${W.ms} ms）。請到電腦看 G:\\我的雲端硬碟\\OM App 測試\\${name}` : '讀回來的內容不對');
  } catch (e) {
    W.ok = false;
    W.error = e.message;
    step(out, false, `失敗：${e.message}${e.status === 403 ? '（權限不足：登入時要勾選雲端硬碟權限）' : ''}`);
  }
  renderSummary();
}

/* ── 9 結果 ─────────────────────────────────────────── */
function yn(x) { return x === true ? '是' : x === false ? '否' : '—'; }
function renderSummary() {
  const L = [];
  const E = R.env || {};
  L.push(`OM 影音測試結果　${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  L.push(`環境：${E.device || '—'}／${E.os || '—'}／${E.standalone ? '主畫面 App' : 'Safari 分頁'}／SW ${E.sw || '—'}`);
  const G = R.login;
  L.push(`1 登入：${G.ok ? `成功，${G.expiresMin} 分鐘，權限 ${(G.scopes || []).join('、')}` : G.error ? '錯誤 ' + G.error : '未測'}`
    + `；${G.silent ? '靜默續期' : '一般登入'}；離開時 ${G.leftStandalone ? '主畫面' : G.leftStandalone === false ? 'Safari' : '—'}、回來時 ${G.backStandalone ? '主畫面' : G.backStandalone === false ? '非主畫面' : '—'}`
    + `；sessionStorage 保留 ${yn(G.sessionKept)}；離開 ${G.secondsAway ?? '—'} 秒`);
  const F = R.find;
  L.push(`2 找檔：${F.ok ? `成功（用${F.by}${F.matches != null ? `，${F.matches} 個符合` : ''}${F.ms ? `，${F.ms} ms` : ''}）；${F.kind || ''}${F.sizeMB != null ? ` ${F.sizeMB} MB` : ''}；有長度資訊 ${yn(F.hasDuration)}` : F.ok === false ? '失敗' : '未測'}`);
  if (F.stats) L.push(`  影音格式：${Object.entries(F.stats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、')}`);
  const P = R.play;
  L.push(`3 App 內播放：${P.kind || '未測'}；長度 ${P.duration ?? '—'} 分；拿到長度 ${P.metaMs ?? '—'} ms；開始播放 ${P.firstPlayMs ?? '—'} ms`);
  L.push(`  跳到 50%：${P['跳到 50%'] || '—'}；跳到結尾前：${P['跳到結尾前 1 分鐘'] || '—'}；最遠播到 ${P.maxPos ?? 0} 分；錯誤碼 ${P.error ?? '無'}`);
  L.push(`  請求 ${P.ranges} 次（206：${P.r206}、200：${P.r200}、Content-Range 自己補：${P.synth}）；401/403：${P.unauth}；SW 重啟：${P.swRestarts}`);
  L.push(`  token 到期後仍播放：${P.playedAfterExpiryS != null ? P.playedAfterExpiryS + ' 秒' : '未測'}；重新登入後接著播：${P.resume || '未測'}`);
  L.push(`  事件順序：${P.events.slice(-25).join(' → ') || '—'}`);
  const D = R.direct;
  L.push(`4 直接網址：${D.ok === true ? `可以（${D.ms} ms）；拖動 ${yn(D.seek)}` : D.ok === false ? `不行（錯誤碼 ${D.code}）` : '未測'}`);
  L.push(`5 背景：${R.bg.length ? R.bg.map((b) => `離開 ${b.away} 秒播了 ${b.adv} 秒${b.nowPlaying ? '（回來仍播放）' : '（回來是暫停）'}`).join('；') : '未測'}；保持螢幕亮著 ${R.wake || '未測'}`);
  L.push(`6 雲端硬碟 App：view＝${R.links.view || '未回報'}；open＝${R.links.open || '未回報'}`);
  L.push(`7 PDF：下載 ${R.pdf.download || '未測'}；頁面內顯示＝${R.pdf.frame || '未回報'}；新視窗＝${R.pdf.tab || '未回報'}`);
  L.push(`8 寫回：${R.write.ok === true ? `成功（${R.write.ms} ms）` : R.write.ok === false ? '失敗 ' + (R.write.error || '') : '未測'}；電腦上＝${R.write.pc || '未回報'}`);
  $('summary').value = L.join('\n');
}
async function onCopy() {
  renderSummary();
  const txt = $('summary').value;
  try { await navigator.clipboard.writeText(txt); $('copy-out').textContent = '已複製'; }
  catch (e) {
    const ta = $('summary');
    ta.focus(); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    $('copy-out').textContent = ok ? '已複製' : '自動複製失敗，請長按上面的文字框手動複製';
  }
}

/* ── 啟動 ───────────────────────────────────────────── */
(async function init() {
  $('g-client').value = sGet('localStorage', 'om-media-client') || '';
  $('f-q').value = sGet('localStorage', 'om-media-q') || '';
  handleReturn();
  await setupSW();
  renderEnv();
  renderTokenInfo();
  $('g-login').addEventListener('click', () => startLogin(false));
  $('g-silent').addEventListener('click', () => startLogin(true));
  $('f-find').addEventListener('click', findFile);
  $('f-stats').addEventListener('click', driveStats);
  $('p-load').addEventListener('click', () => loadPlayer(0));
  $('p-mid').addEventListener('click', () => seekTo(0.5, '跳到 50%'));
  $('p-end').addEventListener('click', () => seekTo(-60, '跳到結尾前 1 分鐘'));
  $('p-kill').addEventListener('click', () => { swPost({ type: 'token', token: 'invalid-token-for-test' }); plog(null, '已讓 Service Worker 改用無效 token：拖動到還沒緩衝的位置試試'); });
  $('p-relogin').addEventListener('click', relogin);
  $('d-load').addEventListener('click', loadDirect);
  $('b-wake').addEventListener('click', requestWake);
  $('pdf-get').addEventListener('click', getPdf);
  $('pdf-frame').addEventListener('click', pdfFrame);
  $('pdf-tab').addEventListener('click', pdfTab);
  chipSet($('pdf-chips'), 'frame', '「在頁面內顯示」的結果', ['多頁都能捲動、縮放', '只顯示第一頁', '空白或錯誤'], R.pdf);
  chipSet($('pdf-chips'), 'tab', '「開新視窗」的結果', ['打開了、能看', '沒反應或錯誤'], R.pdf);
  $('w-run').addEventListener('click', writeTest);
  chipSet($('w-chips'), 'pc', '電腦上的結果', ['看得到、內容是第 2 版', '看得到、但內容是舊的', '看不到'], R.write);
  $('copy').addEventListener('click', onCopy);
  if (TOKEN) await resumeAfterLogin();
  renderSummary();
})();
