// OM Reader——離線影音（P5）：課程講次（mp3／m4a／mp4）與練習影音，按需下載到這支手機，沒網路、沒登入 Google 也能看、能聽。
// - 加密：每個檔一把自己的 AES-GCM 金鑰（檔案金鑰），內容切成 1 MiB 一塊、各自加密存在 IndexedDB 的 media；
//   檔案金鑰再用開啟鎖的金鑰加密，連同索引（哪一講、多大、下載到哪）存在 kv 的 offline。
// - 播放：<audio src="offline-media/<隨機 ID>">，由 Service Worker 依 Range 讀出需要的幾塊、解密後交給播放器；
//   頁面在播放前把「這一個檔」的檔案金鑰交給 SW（不是開啟鎖的金鑰）。上鎖時 SW 只留正在播的那一把（聲音照播，同雲端串流）。
// - 下載：一次一個檔，每次向雲端硬碟要 8 MiB；中斷（離開 App、上鎖、登入過期、沒網路）就停在已下載的位置，之後接著下載。
// - 影片同一套（本人 2026-11-03：影片也要能離線）；影片動輒上 GB，下載前先顯示大小與手機剩餘空間再確認。
'use strict';

const OFF_CHUNK = 1 << 20;   // 每塊 1 MiB（明文）
const OFF_FETCH = 8 << 20;   // 下載時一次要 8 MiB
const OFF_MEDIA = /\.(mp3|m4a|aac|wav|ogg|opus|mp4|m4v|mov|webm)$/i;
const OFF_CONFIRM_BYTES = 300 << 20;   // 超過 300 MB 的檔，下載前先問
let OFF = null;              // 索引：key → { oid, title, kind, ref, drive, size, done, wrapped, state, err, at }
const OFF_ARMED = new Map(); // oid → 檔案金鑰（交給 SW 過的，SW 被叫醒時再給一次）
const OFF_LISTENERS = new Set();
const OFFQ = { running: false, stop: false, cur: null };
LOCK_HOOKS.push(() => {
  OFF = null;
  OFFQ.stop = true;
  const keep = PLAYER && PLAYER.file && PLAYER.file.offline;   // 上鎖：只留正在播的那一把
  for (const oid of [...OFF_ARMED.keys()]) if (oid !== keep) OFF_ARMED.delete(oid);
  offTellSW({ type: 'off-lock', keep: keep || null });
});
UNLOCK_HOOKS.push(() => { setTimeout(() => { offRun(); }, 2500); });   // 解鎖後接著下載沒完成的

// 檔案金鑰（加密後）存成 base64 文字：索引整份是 JSON，Uint8Array／ArrayBuffer 直接 JSON 化會變成 {"0":…}／{}，
// 重開 App 後就解不開（2026-11-04 本人回報「離線播放失敗：TypeError」，就是這個錯）
const offWrap = async (raw) => { const s = await seal(raw); return { iv: b64u(s.iv), ct: b64u(s.ct) }; };
const offUnwrap = (w) => open_({ iv: unb64u(w.iv), ct: unb64u(w.ct) });
const offWrapOk = (w) => !!w && typeof w.iv === 'string' && typeof w.ct === 'string';
async function offIndex() {
  if (OFF) return OFF;
  const rec = await kvGet('offline');
  OFF = {};
  if (rec) { try { OFF = JSON.parse(td.decode(await open_(rec))); } catch (e) { OFF = {}; } }
  // 舊版存壞的金鑰救不回來：清掉這些檔已下載的部分，改成「要重新下載」
  let broken = 0;
  for (const e of Object.values(OFF)) {
    if (e.wrapped && !offWrapOk(e.wrapped)) {
      broken++;
      const oid = e.oid;
      e.oid = gRandom(); e.wrapped = null; e.done = 0; e.state = 'paused';
      e.err = '舊版的錯：這個檔的金鑰沒存好，要重新下載';
      offDelChunks(oid).catch(() => {});
    }
  }
  if (broken) await offSave();
  return OFF;
}
async function offSave() { if (KEY && OFF) await kvSet('offline', await seal(te.encode(JSON.stringify(OFF)))); }
const offEmit = (key) => OFF_LISTENERS.forEach((f) => { try { f(key); } catch (e) { /* 略過 */ } });
const offCanMedia = (name) => OFF_MEDIA.test(String(name || ''));
async function offGet(key) { const ix = await offIndex(); return ix[key] || null; }
async function offDone(key) { const e = await offGet(key); return e && e.state === 'done' ? e : null; }
const offPct = (e) => (e && e.size ? Math.floor((e.done / e.size) * 100) : 0);
const chunkKey = (oid, n) => `${oid}:${String(n).padStart(6, '0')}`;

/* ── 交給 Service Worker ── */
function offTellSW(msg) {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (c) c.postMessage(msg);
  return !!c;
}
async function offArm(e) {
  let k = OFF_ARMED.get(e.oid);
  if (!k) {
    const raw = await offUnwrap(e.wrapped);
    k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    OFF_ARMED.set(e.oid, k);
  }
  if (!offTellSW({ type: 'off-file', oid: e.oid, size: e.size, mime: e.drive.mime || 'audio/mpeg', chunk: OFF_CHUNK, key: k })) {
    throw new Error('離線播放需要 App 的背景程式，請把 App 完全關掉再打開一次');
  }
}
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type !== 'off-need-key') return;
    const k = OFF_ARMED.get(m.oid);
    const e = OFF && Object.values(OFF).find((x) => x.oid === m.oid);
    if (k && e) offTellSW({ type: 'off-file', oid: e.oid, size: e.size, mime: e.drive.mime || 'audio/mpeg', chunk: OFF_CHUNK, key: k });
    else if (k && PLAYER && PLAYER.file && PLAYER.file.offline === m.oid) {   // 上鎖中：索引已清掉，用播放器記的大小
      offTellSW({ type: 'off-file', oid: m.oid, size: PLAYER.file.size, mime: PLAYER.file.mime || 'audio/mpeg', chunk: OFF_CHUNK, key: k });
    }
  });
}
// 給播放器的檔案描述：drive 的 ID 與名稱照舊（講次頁靠名稱認得自己的播放器），來源改成離線
function offFile(e) { return { id: e.drive.id, name: e.drive.name, size: e.size, mime: e.drive.mime || 'audio/mpeg', offline: e.oid }; }
const offIsVideo = (e) => /^video\//.test((e && e.drive && e.drive.mime) || '');

/* ── 同一講另有聲音檔（本人 2026-11-04：有些課在雲端硬碟上 mp4 與 mp3 都有，例：邱顯峯－瑜伽四大部經典、
   阿育吠陀先修班「轉錄用音檔」資料夾）──
   聲音檔名依序找：① 課程索引的 media.source_file（轉逐字稿用的音檔，檔名可能跟影片完全不同）；
   ② 同名、副檔名換成 .mp3／.m4a。查到的結果（含「沒有」）記在加密的檔名快取，有的記 30 天、沒有的記 7 天。
   選影片還是聲音是每門課一個偏好（只存在這支手機）。 */
const altNames = (key, src) => {
  const b = String(key || '').replace(/\.[^.]+$/, '');
  const out = [];
  if (src && src !== key && /\.(mp3|m4a)$/i.test(src)) out.push(src);
  for (const n of [b + '.mp3', b + '.m4a']) if (!out.includes(n)) out.push(n);
  return out;
};
const isVideoKey = (key) => /\.(mp4|m4v|mov|webm)$/i.test(String(key || ''));
async function driveAlt(key, src) {
  const c = await driveCacheLoad();
  const names = altNames(key, src);
  const ck = 'alt:' + key + '|' + names[0];
  const hit = c[ck];
  if (hit && Date.now() - hit.at < (hit.f ? 30 : 7) * 86400000) return hit.f;
  const qs = new URLSearchParams({ q: `(${names.map((n) => `name = '${dEsc(n)}'`).join(' or ')}) and trashed = false`, fields: `files(${D_FIELDS})`, pageSize: '10' });
  const files = (await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [];
  files.sort((x, y) => names.indexOf(x.name) - names.indexOf(y.name) || String(y.modifiedTime).localeCompare(String(x.modifiedTime)));
  const f = files[0] ? { id: files[0].id, name: files[0].name, size: Number(files[0].size || 0), mime: files[0].mimeType || '' } : null;
  c[ck] = { f, at: Date.now() };
  await driveCacheSave();
  return f;
}
// 離線索引裡已有的聲音檔（沒登入也查得到）
async function offAltDone(key, src) { for (const n of altNames(key, src)) { const e = await offDone(n); if (e) return e; } return null; }
const srcPref = (courseId) => { try { return (JSON.parse(localStorage.getItem('om-src') || '{}'))[courseId] || 'video'; } catch (e) { return 'video'; } };
function srcSet(courseId, v) { try { const m = JSON.parse(localStorage.getItem('om-src') || '{}'); m[courseId] = v; localStorage.setItem('om-src', JSON.stringify(m)); } catch (e) { /* 略過 */ } }

// 下載前先查大小（雲端硬碟），連同手機剩餘空間一起顯示
async function offLookup(spec) {
  if (spec.driveId) {
    const m = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(spec.driveId)}?fields=id,size,trashed`)).json();
    return m.trashed ? 0 : Number(m.size || 0);
  }
  let f = await driveFind(spec.driveName, { validate: true });
  if (f && f.choices) f = f.choices.sort((a, b) => String(b.modified).localeCompare(String(a.modified)))[0];
  return f ? Number(f.size || 0) : 0;
}
async function offFree() {
  try { const e = await navigator.storage.estimate(); return Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch (e) { return null; }
}
const fmtSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : fmtMB(b));
async function offConfirm(what, bytes, always) {
  const free = await offFree();
  if (free != null && bytes > free * 0.9) { alert(`${what}共 ${fmtSize(bytes)}，這支手機給 App 的空間只剩約 ${fmtSize(free)}，放不下。可以先刪掉一些離線影音（「同步」頁）。`); return false; }
  if (!always && bytes < OFF_CONFIRM_BYTES) return true;
  return confirm(`${what}共 ${fmtSize(bytes)}${free != null ? `，手機給 App 的空間還有約 ${fmtSize(free)}` : ''}。下載時請讓 App 留在前景（退到背景會暫停，回來再按「繼續下載」）。要下載嗎？`);
}

/* ── 下載 ── */
// spec：{ key, title, kind（lesson／practice）, ref（講次 ID 或練習 ID）, driveName 或 driveId }
async function offEnqueue(spec) {
  const ix = await offIndex();
  const cur = ix[spec.key];
  if (cur && cur.state === 'done') return cur;
  if (!cur) {
    ix[spec.key] = { oid: gRandom(), title: spec.title, kind: spec.kind, ref: spec.ref, driveName: spec.driveName || null, driveId: spec.driveId || null,
      drive: null, size: 0, done: 0, wrapped: null, state: 'queued', err: '', at: Date.now() };
  } else { cur.state = 'queued'; cur.err = ''; }
  await offSave();
  offEmit(spec.key);
  offRun();
  return ix[spec.key];
}
function offPause() { OFFQ.stop = true; }
async function offRun() {
  if (OFFQ.running || !KEY) return;
  OFFQ.running = true; OFFQ.stop = false;
  try {
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* 略過 */ } }
    for (;;) {
      if (OFFQ.stop || !KEY) break;
      const ix = await offIndex();
      const next = Object.entries(ix).filter(([, e]) => e.state === 'queued' || e.state === 'downloading').sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, e] = next;
      if (!gHasToken()) { for (const x of Object.values(ix)) if (x.state === 'queued' || x.state === 'downloading') { x.state = 'paused'; x.err = '要登入 Google 才能下載'; } await offSave(); offEmit(null); break; }
      OFFQ.cur = key;
      try { await offFetch(key, e); }
      catch (err) {
        e.state = 'paused';
        e.err = err.status === 401 ? 'Google 登入過期，重新登入後按「繼續下載」'
          : err.name === 'QuotaExceededError' ? '手機的儲存空間不夠'
            : err.status === 404 ? '雲端硬碟上找不到這個檔'
              : '下載中斷：' + (err.message || err);
        if (KEY) await offSave();
        offEmit(key);
        if (err.status === 401 || err.name === 'QuotaExceededError') break;
      }
    }
  } finally { OFFQ.running = false; OFFQ.cur = null; }
}
async function offFetch(key, e) {
  e.state = 'downloading'; e.err = '';
  if (!e.drive) {
    let f = null;
    if (e.driveId) {
      const m = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(e.driveId)}?fields=id,name,size,mimeType,trashed`)).json();
      if (!m.trashed) f = { id: m.id, name: m.name, size: Number(m.size || 0), mime: m.mimeType || '' };
    } else {
      f = await driveFind(e.driveName, { validate: true });
      if (f && f.choices) f = f.choices.sort((a, b) => String(b.modified).localeCompare(String(a.modified)))[0];   // 同名多個：下載最新的那個
    }
    if (!f) { const x = new Error('找不到'); x.status = 404; throw x; }
    e.drive = { id: f.id, name: f.name, mime: f.mime || '' };
    e.size = f.size;
  }
  let fek;
  if (!e.wrapped) {
    fek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    e.wrapped = await offWrap(await crypto.subtle.exportKey('raw', fek));
    await offSave();
  } else {
    fek = await crypto.subtle.importKey('raw', await offUnwrap(e.wrapped), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  offEmit(key);
  while (e.done < e.size) {
    if (OFFQ.stop || !KEY) { e.state = 'paused'; e.err = ''; if (KEY) await offSave(); offEmit(key); return; }
    const end = Math.min(e.size, e.done + OFF_FETCH) - 1;
    const res = await gfetch(`${DRIVE}/files/${encodeURIComponent(e.drive.id)}?alt=media`, { headers: { Range: `bytes=${e.done}-${end}` }, timeout: 180000 });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (res.status !== 206 && e.done > 0) throw new Error('雲端硬碟沒有照指定的範圍回應');
    const want = end - e.done + 1;
    const got = res.status === 206 ? buf : buf.subarray(e.done, e.done + want);
    if (got.byteLength !== want) throw new Error(`這一段應該 ${want} bytes，收到 ${got.byteLength}`);
    const rows = [];
    for (let off = 0; off < got.byteLength; off += OFF_CHUNK) {
      const s = await seal(got.subarray(off, Math.min(got.byteLength, off + OFF_CHUNK)), fek);
      rows.push([chunkKey(e.oid, (e.done + off) / OFF_CHUNK), { iv: s.iv, ct: s.ct }]);
    }
    await offPutChunks(rows);
    e.done += got.byteLength;
    await offSave();
    offEmit(key);
  }
  e.state = 'done'; e.at = Date.now();
  await offSave();
  offEmit(key);
}
async function offPutChunks(rows) {
  const d = await db();
  const tx = d.transaction('media', 'readwrite');
  const st = tx.objectStore('media');
  for (const [k, v] of rows) st.put(v, k);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function offDelChunks(oid) {
  const d = await db();
  const tx = d.transaction('media', 'readwrite');
  tx.objectStore('media').delete(IDBKeyRange.bound(oid + ':', oid + ':￿'));
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function offRemove(key) {
  const ix = await offIndex();
  const e = ix[key];
  if (!e) return;
  if (OFFQ.cur === key) { OFFQ.stop = true; while (OFFQ.running) await new Promise((r) => setTimeout(r, 100)); }
  if (PLAYER && PLAYER.file && PLAYER.file.offline === e.oid) playerClose();
  delete ix[key];
  await offSave();
  await offDelChunks(e.oid);
  OFF_ARMED.delete(e.oid);
  offEmit(key);
  if (Object.values(ix).some((x) => x.state === 'queued')) offRun();
}
// 索引裡沒有的塊（索引壞掉、刪到一半）：清掉
async function offSweep() {
  const ix = await offIndex();
  const live = new Set(Object.values(ix).map((e) => e.oid));
  const d = await db();
  const keys = await reqP(d.transaction('media').objectStore('media').getAllKeys());
  const dead = new Set(keys.map((k) => String(k).split(':')[0]).filter((oid) => !live.has(oid)));
  for (const oid of dead) await offDelChunks(oid);
  return dead.size;
}

/* ── 介面：一顆按鈕（講次頁、練習頁），整門課下載（課程頁），設定頁一節 ── */
// 狀態（字要短，講次頁控制列只有一行；本人 2026-11-04）：沒下載 →「下載」；下載中 →「下載 45%」（點了暫停）；
// 暫停 →「繼續 45%」；排隊 →「排隊中」；完成 →「✓ 已下載」（點了問要不要刪）
// opts.icons：講次頁控制列用圖示（本人 2026-11-04）——沒下載＝下載圖示；已下載＝打勾圖示；下載中＝45%；暫停＝下載圖示＋45%；排隊＝時鐘
function offButton(spec, onChange, opts = {}) {
  const btn = h('button', { type: 'button', class: 'btn quiet off-btn' + (opts.icons ? ' off-icon' : ''), title: '下載到這支手機，沒網路也能看、能聽' });
  const paint = async () => {
    if (!btn.isConnected && btn.dataset.painted) { OFF_LISTENERS.delete(listener); return; }
    btn.dataset.painted = '1';
    const e = await offGet(spec.key);
    btn.classList.toggle('on', !!(e && e.state === 'done'));
    // 講次頁播放中（外層 .compact）只顯示短字：✓／45%／繼續／排隊；完整的字在 title 與同步頁
    const short = !!btn.closest('.compact');
    const label = !e ? '下載到手機' : e.state === 'done' ? '已下載' : e.state === 'paused' ? (e.done ? `繼續下載（${offPct(e)}%）` : '下載到手機') : e.state === 'queued' ? '排隊等下載' : `下載中 ${offPct(e)}%`;
    if (opts.icons) {
      const st = !e ? 'none' : e.state === 'paused' && !e.done ? 'none' : e.state;
      btn.replaceChildren(...(st === 'none' ? [svgIcon('download')] : st === 'done' ? [svgIcon('downloaded')] : st === 'queued' ? [svgIcon('clock')]
        : st === 'paused' ? [svgIcon('download'), h('span', { class: 'off-pct' }, `${offPct(e)}%`)] : [h('span', { class: 'off-pct' }, `${offPct(e)}%`)]));
    } else {
      btn.textContent = !e ? '下載' : e.state === 'done' ? (short ? '✓' : '✓ 已下載') : e.state === 'paused' ? (e.done ? (short ? '繼續' : `繼續 ${offPct(e)}%`) : '下載') : e.state === 'queued' ? (short ? '排隊' : '排隊中') : (short ? `${offPct(e)}%` : `下載 ${offPct(e)}%`);
    }
    btn.setAttribute('aria-label', label);
    btn.title = e && e.err ? e.err : e && e.state === 'done' ? `已存在這支手機（${fmtSize(e.size)}）；點一下可刪除` : label;
    if (onChange) onChange(e);
  };
  const listener = (k) => { if (k == null || k === spec.key) paint(); };
  OFF_LISTENERS.add(listener);
  btn.addEventListener('click', async () => {
    const e = await offGet(spec.key);
    if (e && e.state === 'done') { if (confirm(`刪除「${spec.title}」的離線檔（${fmtSize(e.size)}）？`)) await offRemove(spec.key); return; }
    if (e && (e.state === 'downloading' || e.state === 'queued')) { e.state = 'paused'; e.err = ''; if (OFFQ.cur === spec.key) offPause(); await offSave(); offEmit(spec.key); return; }
    if (!gHasToken()) { btn.title = '要登入 Google 才能下載'; alert('要先登入 Google 才能下載（到「同步」頁的「雲端硬碟影音」）。'); return; }
    if (!e) {   // 第一次下載：先看大小，大的檔先問
      btn.disabled = true; btn.textContent = '查大小…';
      let bytes = 0;
      try { bytes = await offLookup(spec); } catch (err) { bytes = 0; }
      btn.disabled = false;
      if (!bytes) { paint(); alert('雲端硬碟上找不到這個檔。'); return; }
      if (!(await offConfirm(`「${spec.title}」`, bytes, false))) { paint(); return; }
    }
    await offEnqueue(spec);
  });
  paint();
  return btn;
}
// 課程頁：整門課的影音一起下載（先查每一講的大小、加總後確認）。
// opts.courseId：這門課的影片另有聲音檔時，出現「影片｜聲音」切換，下載整門課就照選的那一種
function offCourseRow(specs, label = '影音', opts = {}) {
  const out = h('span', { class: 'muted off-count' });
  const all = h('button', { type: 'button', class: 'btn' });
  const isDone = (ix, s) => [s.key, ...(isVideoKey(s.key) ? altNames(s.key, s.src) : [])].some((k) => ix[k] && ix[k].state === 'done');
  const mode = () => (opts.courseId ? srcPref(opts.courseId) : 'video');
  const paint = async () => {
    const ix = await offIndex();
    const done = specs.filter((s) => isDone(ix, s)).length;
    const busy = specs.filter((s) => ix[s.key] && ix[s.key].state !== 'done' && ix[s.key].state !== 'paused').length;
    const bytes = specs.reduce((n, s) => n + [s.key, ...(isVideoKey(s.key) ? altNames(s.key, s.src) : [])].reduce((m, k) => m + (ix[k] && ix[k].state === 'done' ? ix[k].size : 0), 0), 0);
    out.textContent = `離線：${done}／${specs.length} 講${bytes ? `（${fmtSize(bytes)}）` : ''}${busy ? `，下載中 ${busy} 講` : ''}`;
    all.textContent = done === specs.length ? '整門課都已離線' : `下載整門課的${opts.courseId ? (mode() === 'audio' ? '聲音' : '影片') : label}`;
    all.disabled = done === specs.length;
  };
  const listener = () => { if (!out.isConnected && out.dataset.painted) { OFF_LISTENERS.delete(listener); return; } out.dataset.painted = '1'; paint(); };
  OFF_LISTENERS.add(listener);
  all.addEventListener('click', async () => {
    if (!gHasToken()) { alert('要先登入 Google 才能下載（到「同步」頁的「雲端硬碟影音」）。'); return; }
    const ix = await offIndex();
    const want = specs.filter((s) => !isDone(ix, s));
    all.disabled = true; out.textContent = `查 ${want.length} 講的大小…`;
    let bytes = 0, missing = 0, noAudio = 0;
    const todo = [];
    for (const s of want) {
      let s2 = s;
      if (mode() === 'audio' && isVideoKey(s.key)) {   // 選了聲音：用同名的 mp3／m4a；這一講沒有聲音檔就跳過
        const a = await driveAlt(s.key, s.src).catch(() => null);
        if (!a) { noAudio++; continue; }
        s2 = { ...s, key: a.name, title: s.title + '（聲音）', driveName: a.name };
      }
      try { const n = await offLookup(s2); if (n) { bytes += n; todo.push(s2); } else missing++; } catch (e) { missing++; }
    }
    all.disabled = false; paint();
    if (!bytes) { alert(noAudio ? '這門課在雲端硬碟上沒有聲音檔。' : '雲端硬碟上找不到這門課的影音。'); return; }
    const notes = [missing ? `${missing} 講在雲端硬碟上找不到` : '', noAudio ? `${noAudio} 講沒有聲音檔、不下載` : ''].filter(Boolean).join('，');
    if (!(await offConfirm(`${todo.length} 講${mode() === 'audio' ? '聲音' : ''}${notes ? `（另有 ${notes}）` : ''}`, bytes, true))) return;
    for (const s of todo) await offEnqueue(s);
  });
  paint();
  if (!opts.courseId) return h('div', { class: 'row off-course' }, all, out);
  const seg = h('div', { class: 'seg-tabs src-row', role: 'group', 'aria-label': '下載影片或聲音' });
  for (const [v, name] of [['video', '影片'], ['audio', '聲音']]) {
    seg.append(h('button', { type: 'button', class: 'filter', 'aria-pressed': String(mode() === v), onclick: (ev) => {
      srcSet(opts.courseId, v); seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === ev.currentTarget))); paint();
    } }, name));
  }
  return h('div', { class: 'row off-course' }, all, seg, out);
}
async function offSection() {
  const ix = await offIndex();
  const rows = Object.entries(ix).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const total = rows.reduce((n, [, e]) => n + (e.state === 'done' ? e.size : e.done), 0);
  const free = await offFree();
  const out = h('p', { class: 'status', role: 'status' });
  const list = h('ul', { class: 'list off-list' }, rows.length ? rows.map(([key, e]) => {
    const state = e.state === 'done' ? fmtSize(e.size) : `${e.state === 'paused' ? '暫停' : '下載中'} ${offPct(e)}%（${fmtSize(e.size)}）${e.err ? `・${e.err}` : ''}`;
    const del = h('button', { type: 'button', class: 'btn quiet', onclick: async () => { await offRemove(key); route(); } }, '刪除');
    const resume = e.state === 'paused' ? h('button', { type: 'button', class: 'btn', onclick: async () => { if (!gHasToken()) { out.textContent = '要先登入 Google 才能下載。'; return; } await offEnqueue({ key }); route(); } }, '繼續下載') : null;
    const href = e.kind === 'practice' ? '#/practice/item/' + encodeURIComponent(e.ref) : '#/lesson/' + encodeURIComponent(e.ref);
    return h('li', { class: 'choice' }, h('a', { href }, h('span', { class: 't' }, e.title), h('span', { class: 'm' }, `${e.kind === 'practice' ? '練習' : '講次'}・${offIsVideo(e) ? '影片' : '聲音'}・${state}`)), h('div', { class: 'row' }, resume, del));
  }) : [h('li', { class: 'empty' }, '還沒有下載任何影音。在講次頁、練習頁按「下載」，或在課程頁下載整門課。')]);
  const clear = rows.length ? h('button', { type: 'button', class: 'btn quiet danger', onclick: async () => {
    if (!confirm(`刪除這支手機上全部 ${rows.length} 個離線影音（${fmtSize(total)}）？`)) return;
    for (const [key] of rows) await offRemove(key);
    route();
  } }, '刪除全部離線影音') : null;
  offSweep().catch(() => {});
  return [secTitle('離線影音'), h('div', { class: 'card' },
    h('p', { class: 'muted' }, `共 ${rows.length} 個、${fmtSize(total)}${free != null ? `；手機給 App 的空間還有約 ${fmtSize(free)}` : ''}。課程講次與練習的影片、聲音都可以下載，沒網路、沒登入 Google 也能看、能聽；內容加密存在這支手機。影片很大，下載時請讓 App 留在前景。`),
    list, out, clear ? h('div', { class: 'row' }, clear) : null)];
}
