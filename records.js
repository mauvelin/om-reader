// OM Reader——學習紀錄同步（P4）：和電腦上的 learn、其他裝置經由雲端硬碟「OM App/紀錄/」交換學習進度、
// 最近開過、書籤、練習進度、最愛、練習紀錄。規格＝learn repo docs/om-app-contract.md §2，
// 檔案格式＝learn repo schema/om-app-record.schema.json；合併規則逐條照 learn 的 src/om_learn/omapp/records.py：
// - 每一區塊是「鍵 → 紀錄或刪除標記」；同一個鍵 at 最新的勝出，時間相同時刪除勝出，再相同依裝置名排序
// - 課程進度的「看完」：任何一份紀錄說看完就是看完
// - 刪除標記永久保留；每台裝置只寫自己的檔，內容是這台所知道的完整合併結果
// - 格式不對、檔名不合格（雲端硬碟的衝突複本「iphone (1).json」）的整個檔略過，和 learn 的判斷一致
// 寫入時機（契約 §2.4）：有變動時寫（進度最多每分鐘一次）、離開 App 時一次；開 App 與回到前景時讀全部的檔並合併。
'use strict';

const REC_SECTIONS = ['progress', 'recent', 'bookmarks', 'practice_progress', 'practice_durations', 'favorites', 'practice_log'];
const REC_DELETABLE = new Set(['bookmarks', 'favorites', 'practice_log']);
const REC_NAME_RE = /^[a-z0-9-]{1,32}\.json$/;
const REC_DEVICE_RE = /^[a-z0-9-]{1,32}$/;
const REC_DIR = ['OM App', '紀錄'];
const REC_PROGRESS_EVERY_MS = 60 * 1000;   // 播放中的進度：最多每分鐘寫一次
const REC_SOON_MS = 3000;                  // 其他變動（書籤、最愛、練習紀錄）：停手 3 秒後寫
const REC_FOREGROUND_GAP_MS = 20 * 1000;   // 回到前景時讀取：20 秒內重複切換不重讀
const RSYNC = { running: null, again: false, timer: null, timerAt: 0, dirty: false, lastPush: 0, lastRead: 0, last: null };
LOCK_HOOKS.push(() => { clearTimeout(RSYNC.timer); RSYNC.timer = null; RSYNC.last = null; });

/* ── 時間：換算成 UTC 微秒再比（learn 用 Python datetime，精確到微秒；JS 的 Date 只到毫秒） ── */
const REC_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
function recTime(s) {
  const m = typeof s === 'string' ? REC_TIME_RE.exec(s) : null;
  if (!m) return NaN;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || day.getUTCDate() !== d || hh > 23 || mi > 59 || ss > 59) return NaN;
  let off = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[8].slice(1, 3)), om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return NaN;
    off = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const us = Number(((m[7] || '') + '000000').slice(0, 6));
  return (Date.UTC(y, mo - 1, d, hh, mi, ss) - off * 60000) * 1000 + us;
}

/* ── 格式檢查：和 schema 一樣嚴格（多一個欄位也不行），learn 不收的檔 App 也不收 ── */
const recObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const recT = (v) => !Number.isNaN(recTime(v));
const recS = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const recStr = (v) => typeof v === 'string' && v.length > 0;
function recKeys(o, req, opt = []) {
  if (!recObj(o)) return false;
  for (const k of req) if (!(k in o)) return false;
  for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) return false;
  return true;
}
const recDeleted = (e) => recKeys(e, ['deleted', 'at']) && e.deleted === true && recT(e.at);
const REC_ENTRY = {
  progress: (e) => recKeys(e, ['t_s', 'duration_s', 'at'], ['completed']) && recS(e.t_s) && recS(e.duration_s) && recT(e.at)
    && (!('completed' in e) || typeof e.completed === 'boolean'),
  recent: (e) => recKeys(e, ['course_id', 'at']) && recStr(e.course_id) && recT(e.at),
  bookmarks: (e) => recDeleted(e) || (recKeys(e, ['lesson_id', 'course_id', 't_s', 'text', 'at'], ['created_at'])
    && recStr(e.lesson_id) && recStr(e.course_id) && recS(e.t_s) && typeof e.text === 'string' && [...e.text].length <= 500
    && recT(e.at) && (!('created_at' in e) || recT(e.created_at))),
  practice_progress: (e) => recKeys(e, ['t_s', 'duration_s', 'at']) && recS(e.t_s) && recS(e.duration_s) && recT(e.at),
  practice_durations: (e) => recKeys(e, ['duration_s', 'at']) && recS(e.duration_s) && e.duration_s > 0 && recT(e.at),
  favorites: (e) => recDeleted(e) || (recKeys(e, ['at']) && recT(e.at)),
  practice_log: (e) => recDeleted(e) || (recKeys(e, ['practiced_at', 'source', 'at'], ['minutes']) && recT(e.practiced_at)
    && recStr(e.source) && recT(e.at) && (!('minutes' in e) || e.minutes === null || recS(e.minutes))),
};
const REC_LOG_KEY = /^[^|]+\|\d{4}-\d{2}-\d{2}$/;
// 回傳 null＝合格；否則回傳不合格的原因（顯示在同步頁）
function recCheck(data, stem) {
  if (!recObj(data)) return '不是 JSON 物件';
  for (const k of ['format', 'version', 'device', 'written_at']) if (!(k in data)) return `少了 ${k}`;
  if (data.format !== 'om-app-record') return 'format 不是 om-app-record';
  if (data.version !== 1) return `版本 ${JSON.stringify(data.version)} 不認得`;
  if (typeof data.device !== 'string' || !REC_DEVICE_RE.test(data.device)) return '裝置名不合格';
  if (!recT(data.written_at)) return 'written_at 的時間格式不對';
  for (const s of REC_SECTIONS) {
    if (!(s in data)) continue;
    if (!recObj(data[s])) return `${s} 不是物件`;
    for (const [k, e] of Object.entries(data[s])) {
      if (s === 'practice_log' && !REC_LOG_KEY.test(k)) return `${s}／${k}：鍵的格式不對`;
      if (!REC_ENTRY[s](e)) return `${s}／${k}：欄位不符`;
    }
  }
  if (stem != null && data.device !== stem) return `裝置名 ${data.device} 和檔名不符`;
  return null;
}

/* ── 合併（learn records.merge 的逐行對應） ── */
const recRankGt = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);
function recMerge(records) {
  const out = {};
  for (const s of REC_SECTIONS) out[s] = {};
  const best = new Map();
  const completed = new Set();
  for (const r of records) {
    for (const s of REC_SECTIONS) {
      for (const [k, e] of Object.entries(r[s] || {})) {
        if (s === 'progress' && e.completed) completed.add(k);
        const rank = [recTime(e.at), e.deleted ? 1 : 0, r.device];
        const id = s + '\u0000' + k;
        const b = best.get(id);
        if (!b || recRankGt(rank, b)) { best.set(id, rank); out[s][k] = e; }
      }
    }
  }
  for (const k of completed) out.progress[k] = { ...out.progress[k], completed: true };
  return out;
}

// 這支手機的紀錄整理成合格的格式：只留 schema 有的欄位；長度未知寫 0（App 一律把 0 當「還不知道」）
function recFix(s, e) {
  if (!recObj(e)) return null;
  const n0 = (v) => (recS(v) ? v : 0);
  let o = null;
  if (e.deleted) o = REC_DELETABLE.has(s) ? { deleted: true, at: e.at } : null;
  else if (s === 'progress') o = { t_s: n0(e.t_s), duration_s: n0(e.duration_s), completed: !!e.completed, at: e.at };
  else if (s === 'recent') o = { course_id: e.course_id, at: e.at };
  else if (s === 'bookmarks') {
    o = { lesson_id: e.lesson_id, course_id: e.course_id, t_s: n0(e.t_s), text: [...String(e.text || '')].slice(0, 500).join(''), at: e.at };
    if (recT(e.created_at)) o.created_at = e.created_at;
  } else if (s === 'practice_progress') o = { t_s: n0(e.t_s), duration_s: n0(e.duration_s), at: e.at };
  else if (s === 'practice_durations') o = { duration_s: e.duration_s, at: e.at };
  else if (s === 'favorites') o = { at: e.at };
  else if (s === 'practice_log') o = { practiced_at: e.practiced_at, minutes: e.minutes == null ? null : n0(e.minutes), source: e.source, at: e.at };
  return o && REC_ENTRY[s](o) ? o : null;
}
function recLocal(device) {
  const r = { format: 'om-app-record', version: 1, device, written_at: new Date().toISOString() };
  for (const s of REC_SECTIONS) {
    r[s] = {};
    for (const [k, e] of Object.entries(LREC[s] || {})) {
      if (s === 'practice_log' && !REC_LOG_KEY.test(k)) continue;
      const f = recFix(s, e);
      if (f) r[s][k] = f;
    }
  }
  return r;
}
// 鍵排序後的 JSON：比較兩份內容是否相同（欄位順序不同不算變動）
function recStable(v) {
  if (Array.isArray(v)) return '[' + v.map(recStable).join(',') + ']';
  if (recObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + recStable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/* ── 設定與狀態（加密存在這支手機） ── */
function recDefaultDevice() {
  const ua = navigator.userAgent || '';
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ipad' : 'iphone';
}
async function recState() {
  const rec = await kvGet('rec-sync');
  let st = {};
  if (rec) { try { st = JSON.parse(td.decode(await open_(rec))); } catch (e) { st = {}; } }
  if (!st.device || !REC_DEVICE_RE.test(st.device) || st.device === 'pc') st.device = recDefaultDevice();
  st.seen = st.seen || {};
  return st;
}
async function recSaveState(st) { await kvSet('rec-sync', await seal(te.encode(JSON.stringify(st)))); }
function recDeviceError(v) {
  if (!REC_DEVICE_RE.test(v)) return '裝置名只能用小寫英文、數字與 -，最多 32 個字。';
  if (v === 'pc') return 'pc 保留給電腦上的 learn，請換一個名字。';
  return null;
}

/* ── 讀寫雲端硬碟 ── */
async function recFolder(st) {
  if (st.folder) {
    try {
      const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(st.folder)}?fields=id,trashed`)).json();
      if (!f.trashed) return st.folder;
    } catch (e) { if (e.status !== 404) throw e; }
    st.seen = {};
  }
  st.folder = await driveFolder(REC_DIR);   // 沒有就建（OM App 由 learn 建立；紀錄 也可能由這裡先建）
  return st.folder;
}
async function recList(folder) {
  const out = [];
  let page = '';
  do {
    const qs = new URLSearchParams({ q: `'${dEsc(folder)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,md5Checksum,mimeType)', pageSize: '100' });
    if (page) qs.set('pageToken', page);
    const r = await (await gfetch(`${DRIVE}/files?${qs}`)).json();
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

// 同步一次：讀資料夾裡全部的檔（沒變的不重下載）→ 和這支手機的紀錄合併 → 內容有變才寫自己的檔
async function recSyncOnce() {
  if (!KEY) return { skip: '已上鎖' };
  if (!(await gSettings()).enabled) return { skip: '雲端硬碟功能沒啟用' };
  const st = await recState();
  if (st.off) return { skip: '紀錄同步已關閉' };
  if (!gHasToken()) return (RSYNC.last = { ok: false, at: Date.now(), msg: '還沒登入 Google，這段時間的紀錄先存在這支手機，登入後會補寫。' });
  await lrec();
  RSYNC.dirty = false;
  const device = st.device;
  const ownName = device + '.json';
  try {
    const folder = await recFolder(st);
    const files = await recList(folder);
    const records = [], skipped = [], seen = {};
    for (const f of files) {
      if (!/\.json$/i.test(f.name) || f.mimeType === D_FOLDER) continue;
      if (!REC_NAME_RE.test(f.name)) { skipped.push([f.name, '檔名不合格（可能是雲端硬碟的衝突複本）']); continue; }
      const prev = st.seen[f.name];
      if (prev && prev.id === f.id && prev.md5 && prev.md5 === f.md5Checksum) {   // 上次讀過、合併過，內容沒變
        seen[f.name] = prev;
        if (prev.bad) skipped.push([f.name, prev.bad]);
        continue;
      }
      const text = await (await driveRead(f.id)).text();   // 網路錯誤直接中止這一輪，下次重試（不記成壞檔）
      let data = null, bad = null;
      try { data = JSON.parse(text); } catch (e) { bad = '不是完整的 JSON'; }
      if (!bad) bad = recCheck(data, f.name.slice(0, -5));
      seen[f.name] = { id: f.id, md5: f.md5Checksum || '', device: bad ? null : data.device, bad: bad || null };
      if (bad) skipped.push([f.name, bad]); else records.push(data);
    }
    // 合併到寫回記憶體之間沒有 await：播放中每 5 秒的進度不會被蓋掉
    const before = recLocal(device);
    const merged = recMerge([before, ...records]);
    let changed = 0;
    for (const s of REC_SECTIONS) {
      for (const k of new Set([...Object.keys(before[s]), ...Object.keys(merged[s])])) {
        if (recStable(before[s][k]) !== recStable(merged[s][k])) changed++;
      }
      LREC[s] = merged[s];
    }
    await kvSet('learn-rec', await seal(te.encode(JSON.stringify(LREC))));
    const body = { format: 'om-app-record', version: 1, device, written_at: new Date().toISOString(), ...merged };
    const err = recCheck(body, device);
    if (err) throw new Error('要寫出的紀錄不合格式（' + err + '），這次不寫');
    const sig = await hex16(te.encode(recStable(merged)));
    const own = seen[ownName];
    let wrote = false;
    if (st.sig !== sig || !own || own.bad) {
      const text = JSON.stringify(body);
      let res = null;
      if (own && own.id) { try { res = await driveUpdate(own.id, text); } catch (e) { if (e.status !== 404) throw e; } }
      if (!res) res = await driveCreate(folder, ownName, text);
      seen[ownName] = { id: res.id, md5: res.md5Checksum || '', device, bad: null };
      st.sig = sig;
      wrote = true;
      RSYNC.lastPush = Date.now();
    }
    st.seen = seen;
    st.at = Date.now();
    await recSaveState(st);
    RSYNC.lastRead = Date.now();
    const devices = Object.values(seen).filter((x) => x.device && x.device !== device).map((x) => x.device).sort();
    RSYNC.last = { ok: true, at: st.at, devices, skipped, changed, wrote, device };
    if (changed && (location.hash === '' || location.hash === '#/') && KEY && typeof viewHome === 'function') viewHome().catch(() => {});
    return RSYNC.last;
  } catch (e) {
    RSYNC.dirty = true;
    const msg = e.status === 401 ? 'Google 登入已過期，重新登入後會補寫。'
      : e.status === 403 || e.status === 404 ? `雲端硬碟不讓 App 寫進「OM App/紀錄」（HTTP ${e.status}）。可能是「紀錄」資料夾不是由這個 App 建立的，詳見下方說明。`
        : '紀錄同步失敗：' + (e.message || e);
    await recSaveState(st).catch(() => {});
    return (RSYNC.last = { ok: false, at: Date.now(), msg, status: e.status || 0 });
  }
}
// 同一時間只跑一輪；跑的途中又有要求，跑完再補一輪
async function recSync() {
  if (RSYNC.running) { RSYNC.again = true; return RSYNC.running; }
  RSYNC.running = recSyncOnce().finally(() => { RSYNC.running = null; });
  const r = await RSYNC.running;
  if (RSYNC.again) { RSYNC.again = false; return recSync(); }
  return r;
}
// lrecSave 每次存檔都會叫：進度（kind＝progress）最多每分鐘寫一次，其他變動停手 3 秒後寫
function recTouch(kind) {
  RSYNC.dirty = true;
  const wait = kind === 'progress' ? Math.max(REC_SOON_MS, RSYNC.lastPush + REC_PROGRESS_EVERY_MS - Date.now()) : REC_SOON_MS;
  if (RSYNC.timer && RSYNC.timerAt <= Date.now() + wait) return;   // 已排了更早的一次
  clearTimeout(RSYNC.timer);
  RSYNC.timerAt = Date.now() + wait;
  RSYNC.timer = setTimeout(() => { RSYNC.timer = null; recSync(); }, wait);
}
UNLOCK_HOOKS.push(() => { setTimeout(() => { recSync(); }, 1200); });   // 開 App（解鎖）時讀一次；不擋解鎖
document.addEventListener('visibilitychange', () => {
  if (!KEY) return;
  if (document.visibilityState === 'hidden') {
    if (RSYNC.dirty) { clearTimeout(RSYNC.timer); RSYNC.timer = null; recSync(); }   // 離開 App：有沒寫出的就寫
  } else if (Date.now() - RSYNC.lastRead > REC_FOREGROUND_GAP_MS) recSync();        // 回到前景：讀別台的
});

/* ── 設定頁的一節 ── */
async function recSection() {
  const st = await recState();
  const out = h('p', { class: 'status', role: 'status' });
  const show = (r) => {
    if (!r) { out.textContent = st.at ? `上次同步紀錄：${new Date(st.at).toLocaleString('zh-TW')}。` : '還沒同步過。'; return; }
    if (r.skip) { out.textContent = r.skip + '。'; return; }
    if (!r.ok) { out.textContent = r.msg; return; }
    const t = new Date(r.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    const parts = [`${t} 同步完成`, r.devices.length ? `讀到 ${r.devices.join('、')} 的紀錄` : '資料夾裡還沒有其他裝置的紀錄',
      r.changed ? `更新了這支手機 ${r.changed} 筆` : '這支手機沒有要更新的', r.wrote ? `已寫入 ${r.device}.json` : `${r.device}.json 已是最新`];
    out.textContent = parts.join('，') + '。';
    if (r.skipped.length) out.append(h('br'), '略過：' + r.skipped.map(([n, why]) => `${n}（${why}）`).join('；'));
  };
  show(RSYNC.last);
  const on = h('input', { type: 'checkbox', id: 'rec-on' });
  on.checked = !st.off;
  on.addEventListener('change', async () => { const s = await recState(); s.off = !on.checked; await recSaveState(s); route(); });
  const head = [secTitle('學習紀錄同步'),
    h('label', { class: 'check', for: 'rec-on' }, on, '和電腦（learn）與其他裝置同步學習進度、書籤、最愛、練習紀錄')];
  if (st.off) return [...head, h('p', { class: 'muted' }, '已關閉：紀錄只存在這支手機。')];
  const dev = h('input', { id: 'rec-device', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: st.device, maxlength: '32' });
  const saveDev = h('button', { type: 'button', class: 'btn' }, '儲存裝置名');
  saveDev.addEventListener('click', async () => {
    const v = dev.value.trim();
    const err = recDeviceError(v);
    if (err) { out.textContent = err; return; }
    const s = await recState();
    if (s.device === v) { out.textContent = '裝置名沒有變。'; return; }
    s.device = v; s.sig = null;
    await recSaveState(s);
    out.textContent = `已改成 ${v}。之後寫 ${v}.json；舊名字的檔留在雲端硬碟，內容已併進新檔，可以自己刪掉。`;
  });
  const now = h('button', { type: 'button', class: 'btn primary' }, svgIcon('sync'), '立刻同步紀錄');
  now.addEventListener('click', async () => {
    now.disabled = true; out.textContent = '同步紀錄中…';
    try { show(await recSync()); } finally { now.disabled = false; }
  });
  return [...head, h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', { for: 'rec-device' }, '這台裝置的名字（紀錄檔名）'), dev), h('div', { class: 'row' }, saveDev),
    h('div', { class: 'row' }, now), out,
    h('p', { class: 'muted' }, '紀錄檔放在雲端硬碟「OM App/紀錄/<裝置名>.json」，每台裝置只寫自己的那一個，內容是合併後的完整紀錄；電腦上的 learn 寫 pc.json。'
      + '開 App、回到前景時讀別台的紀錄；有變動時寫（播放中的進度最多每分鐘一次）、離開 App 時再寫一次。'
      + '若出現「不讓 App 寫進」：這個 App 只被允許改它自己建立的檔，請在電腦上把「OM App/紀錄」裡的 pc.json 先移到別處、刪掉空的「紀錄」資料夾，回 App 按「立刻同步紀錄」讓 App 建立資料夾，再把 pc.json 放回去。'))];
}
