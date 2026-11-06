// OM Reader——影片（本人 2026-11-06）：/ingest 影片線（AI Fetch＝Wait for Video）存到雲端硬碟
// 「OM App/影片/<Threads｜YouTube>/」的 mp4＋同名 json（format: om-video、version: 1，規格＝OM .agents/skills/ingest/reference/video.md）。
// 和課程分開：不進課程索引、不進學習紀錄的同步檔；看到哪裡只存在這支手機。
// 清單（只有描述檔的內容＋影片的雲端硬碟 ID）加密存在這支手機：沒網路、沒登入也列得出來，已下載離線的照樣能看
'use strict';

const VIDEO_DIR = ['OM App', '影片'];
let VIDEOS = null;   // { at, items: [{ id, name, size, mime, source, jsonId, md5, meta }] }
let VIDEO_POS = null;   // { <影片 id>: { t_s, duration_s, at } }
LOCK_HOOKS.push(() => { VIDEOS = null; VIDEO_POS = null; });

async function videosCached() {
  if (VIDEOS) return VIDEOS;
  const rec = await kvGet('videos');
  if (rec) { try { VIDEOS = JSON.parse(td.decode(await open_(rec))); } catch (e) { VIDEOS = null; } }
  return VIDEOS;
}
// 一個資料夾底下的全部檔（含大小）；分頁讀完
async function videoList(folder) {
  const out = [];
  let page = '';
  do {
    const qs = new URLSearchParams({ q: `'${dEsc(folder)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,size,mimeType,md5Checksum)', pageSize: '200' });
    if (page) qs.set('pageToken', page);
    const r = await (await gfetch(`${DRIVE}/files?${qs}`)).json();
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}
// 重讀雲端硬碟：每支影片配同名描述檔；描述檔沒變（md5 相同）就沿用上次讀到的內容，不重下載
async function videosRefresh() {
  const root = await driveFolderFind(VIDEO_DIR);
  const prev = new Map((((await videosCached()) || {}).items || []).map((x) => [x.jsonId, x]));
  const items = [];
  if (root) {
    for (const sub of (await videoList(root)).filter((f) => f.mimeType === D_FOLDER)) {
      const files = await videoList(sub.id);
      const media = new Map(files.filter((f) => /^video\/|^audio\//.test(f.mimeType || '')).map((f) => [f.name.replace(/\.[^.]+$/, ''), f]));
      for (const j of files.filter((f) => /\.json$/i.test(f.name))) {
        const v = media.get(j.name.replace(/\.json$/i, ''));
        if (!v) continue;
        let meta = null;
        const old = prev.get(j.id);
        if (old && old.md5 && old.md5 === j.md5Checksum) meta = old.meta;
        else { try { meta = await (await driveRead(j.id)).json(); } catch (e) { if (e.status) throw e; meta = null; } }
        if (!meta || meta.format !== 'om-video') continue;
        items.push({ id: v.id, name: v.name, size: Number(v.size || 0), mime: v.mimeType || 'video/mp4', source: sub.name, jsonId: j.id, md5: j.md5Checksum || '', meta });
      }
    }
  }
  items.sort((a, b) => String(b.meta.date || '').localeCompare(String(a.meta.date || '')) || String(b.meta.fetched_at || '').localeCompare(String(a.meta.fetched_at || '')) || (a.meta.part || 1) - (b.meta.part || 1));
  VIDEOS = { at: Date.now(), items, missing: !root };
  await kvSet('videos', await seal(te.encode(JSON.stringify(VIDEOS))));
  return VIDEOS;
}

/* ── 看到哪裡（只存這支手機） ── */
async function videoPos() {
  if (VIDEO_POS) return VIDEO_POS;
  const rec = await kvGet('video-pos');
  VIDEO_POS = {};
  if (rec) { try { VIDEO_POS = JSON.parse(td.decode(await open_(rec))) || {}; } catch (e) { VIDEO_POS = {}; } }
  return VIDEO_POS;
}
let videoPosTimer = null;
function videoProgressSave(meta, el) {   // courses.js progressSave 轉過來（meta.kind＝video）
  if (!VIDEO_POS || !KEY) { videoPos().then(() => { if (VIDEO_POS) videoProgressSave(meta, el); }).catch(() => {}); return; }
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  VIDEO_POS[meta.videoId] = { t_s: Math.round(el.currentTime * 10) / 10, duration_s: dur ? Math.round(dur) : 0, at: Date.now() };
  clearTimeout(videoPosTimer);
  videoPosTimer = setTimeout(async () => { if (KEY && VIDEO_POS) await kvSet('video-pos', await seal(te.encode(JSON.stringify(VIDEO_POS)))); }, 1500);
}

/* ── 畫面 ── */
const VIDEO_SOURCES = [['all', '全部'], ['Threads', 'Threads'], ['YouTube', 'YouTube']];
function videoTitle(x) {
  const m = x.meta || {};
  return (m.title || x.name.replace(/\.[^.]+$/, '')) + (m.parts > 1 ? `（${m.part}／${m.parts}）` : '');
}
function videoLine(x, pos) {
  const m = x.meta || {};
  const p = pos && pos[x.id];
  const seen = p && p.duration_s ? (p.t_s >= p.duration_s * 0.95 ? '看完了' : `看到 ${clockShort(p.t_s)}`) : '';
  return [x.source, m.author, m.date, m.duration_s ? clockShort(m.duration_s) : '', seen].filter(Boolean).join('・');
}
function videoRow(x, pos) {
  return h('li', null, h('a', { class: 'item', href: '#/video/' + encodeURIComponent(x.id) },
    h('span', { class: 't' }, videoTitle(x), h('span', { class: 'kind-tag' }, '影片')), h('span', { class: 'm' }, videoLine(x, pos))));
}
// 進清單：先畫手機上存的，登入中就到雲端硬碟重讀一次再重畫
async function viewVideos(qs) {
  const want = new URLSearchParams(qs || '').get('src') || 'all';
  const status = h('p', { class: 'status', role: 'status' });
  const list = h('ul', { class: 'list' });
  const chips = h('div', { class: 'filter-row' });
  const pos = await videoPos().catch(() => ({}));
  const paint = (data) => {
    const items = (data && data.items) || [];
    const shown = items.filter((x) => want === 'all' || x.source === want);
    chips.replaceChildren(...VIDEO_SOURCES.filter(([k]) => k === 'all' || items.some((x) => x.source === k)).map(([k, name]) =>
      h('a', { class: 'filter', href: '#/videos' + (k === 'all' ? '' : '?src=' + k), 'aria-pressed': String(k === want) }, `${name} ${k === 'all' ? items.length : items.filter((x) => x.source === k).length}`)));
    list.replaceChildren(...(shown.length ? shown.map((x) => videoRow(x, pos)) : [h('li', { class: 'empty' }, data ? '還沒有影片。' : '還沒讀過影片清單。')]));
  };
  const cached = await videosCached();
  const login = h('button', { type: 'button', class: 'btn' }, '登入 Google');
  login.addEventListener('click', () => gLogin({ returnHash: location.hash }).catch((e) => { status.textContent = e.message; }));
  setView(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/courses' }, '課程')), h('h1', null, '影片')),
    h('p', { class: 'page-sub' }, '在 Notion 標「Wait for Video」、由電腦上的 /ingest 存到雲端硬碟「OM App/影片」的影片；和課程分開。'),
    chips, status, list);
  paint(cached);
  const s = await gSettings();
  if (!s.enabled) { status.textContent = '到「同步」頁啟用雲端硬碟功能，才讀得到影片清單。'; return; }
  if (!gHasToken()) { status.replaceChildren(cached ? '這是上次讀到的清單；登入 Google 可以更新。 ' : '登入 Google 一次，讀到影片清單之後，下載離線的影片沒登入也能看。 ', login); return; }
  status.textContent = '讀取雲端硬碟…';
  try {
    const fresh = await videosRefresh();
    if (!list.isConnected) return;
    status.textContent = fresh.missing ? '雲端硬碟上還沒有「OM App/影片」資料夾。' : '';
    paint(fresh);
  } catch (e) { status.textContent = '讀取失敗：' + (e.message || e) + (cached ? '（先顯示上次讀到的清單）' : ''); }
}
async function viewVideo(id) {
  const data = await videosCached();
  const x = data && data.items.find((y) => y.id === id);
  if (!x) return setView(h('h1', null, '找不到這支影片'), h('p', { class: 'muted' }, h('a', { href: '#/videos' }, '回影片清單')));
  const m = x.meta || {};
  const pos = await videoPos().catch(() => ({}));
  const status = h('p', { class: 'status', role: 'status' });
  const slot = h('div', { class: 'lesson-slot p-slot' });
  const meta = { kind: 'video', videoId: x.id, title: videoTitle(x), course: ['影片', x.source, m.author].filter(Boolean).join('・'), href: '#/video/' + encodeURIComponent(x.id) };
  const mine = () => !!(PLAYER && PLAYER.meta && PLAYER.meta.videoId === x.id);
  const offSpec = { key: 'video:' + x.id, title: videoTitle(x), kind: 'video', ref: x.id, driveId: x.id };
  const startT = () => { const p = pos[x.id]; return p && p.duration_s && p.t_s < p.duration_s * 0.95 ? p.t_s : 0; };
  const start = async () => {
    const e = await offDone(offSpec.key);
    try {
      if (e) await playerOpen(offFile(e), { t: startT(), meta });
      else {
        if (!(await gSettings()).enabled) { status.textContent = '到「同步」頁啟用雲端硬碟功能，才播得了雲端硬碟上的影片。'; return; }
        if (!gHasToken() || gMinutesLeft() < RENEW_BEFORE_MIN) {
          const went = await gLoginAsk(gHasToken() ? `Google 登入只剩 ${gMinutesLeft()} 分鐘，播到一半會斷，要先續期。` : '要先登入 Google 才能播放這支影片。', { returnHash: location.hash, resume: null });
          if (!went) status.textContent = '沒有登入，沒開始播。';
          return;
        }
        status.textContent = '讀取雲端硬碟…';
        const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(x.id)}?fields=id,name,size,mimeType,trashed`)).json();
        if (f.trashed) { status.textContent = '這支影片在雲端硬碟的垃圾桶裡。'; return; }
        status.textContent = '';
        await playerOpen({ id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || 'video/mp4' }, { t: startT(), meta });
      }
      const el = playerEl();
      if (el) el.play().catch(() => {});
    } catch (err) { status.textContent = err.status === 404 ? '雲端硬碟上找不到這支影片（可能被移除）。' : '播放失敗：' + (err.message || err); }
  };
  const p0 = pos[x.id];
  const playBtn = h('button', { type: 'button', class: 'btn primary', onclick: start }, svgIcon('play'), p0 && startT() > 5 ? `從 ${clockShort(p0.t_s)}` : '播放');
  const links = [m.url ? h('a', { class: 'btn', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '原貼文') : null,
    m.notion_page ? h('a', { class: 'btn', href: notionUrl(String(m.notion_page).replace(/-/g, '')), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), 'Notion') : null];
  const sig = viewAbort.signal;
  setView(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/videos' }, '影片')), h('h1', { class: videoTitle(x).length > 28 ? 'long' : null }, videoTitle(x))),
    h('p', { class: 'page-sub' }, videoLine(x, pos)),
    h('section', { class: 'lesson-media' }, slot, h('div', { class: 'row' }, playBtn, offButton(offSpec, null, { icons: true })), status),
    h('div', { class: 'doc-actions' }, ...links.filter(Boolean)),
    m.database ? h('p', { class: 'muted' }, `來自 Notion「${m.database}」${m.fetched_at ? `・${String(m.fetched_at).slice(0, 10)} 存到雲端硬碟` : ''}`) : null);
  PLAYER_SLOT = { name: x.id, el: slot };
  sig.addEventListener('abort', () => { if (PLAYER_SLOT && PLAYER_SLOT.el === slot) PLAYER_SLOT = null; });
  if (mine()) playerAdopt(slot);
}
// 首頁一段「最近的影片」（手機上存的清單，前 3 支）
async function videosHomeSection() {
  const data = await videosCached();
  if (!data || !data.items.length) return [];
  const pos = await videoPos().catch(() => ({}));
  return [secTitle('最近的影片', '#/videos', `全部影片（${data.items.length}）`), listOf(data.items.slice(0, 3).map((x) => videoRow(x, pos)))];
}
