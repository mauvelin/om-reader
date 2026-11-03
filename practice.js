// OM Reader——練習層（P3）：瑜伽練習目錄、清單、播放、練習紀錄、最愛、墊旁模式。
// 對照 learn 的行動版練習目錄（claude.ai 私人頁面，驗收後下架）與 learn 練習頁移植（learn repo docs/OM-App-整合計畫.md §4）。
// 資料：learn 匯出到雲端硬碟的 learn-export.json 的 practice（目錄只列有雲端硬碟 ID 的影片、清單）；
// 個人狀態（最愛、紀錄、進度）不在匯出檔裡，照 OM App ↔ learn 資料契約記在手機上（加密），P4 再同步到雲端硬碟。
'use strict';

const P_MINUTES = [['15', '15 分內', (m) => m != null && m <= 15], ['30', '30 分內', (m) => m != null && m <= 30],
  ['45', '45 分內', (m) => m != null && m <= 45], ['60', '60 分內', (m) => m != null && m <= 60], ['61', '60 分以上', (m) => m != null && m > 60]];
const P_KIND = { user: '我排的', series: '系列', dated: '課堂錄影' };
const P_UNIT = { user: '支', series: '集', dated: '堂' };
const AUTO_LOG_RATIO = 0.8;   // learn 本人裁決 5：這次真正播放了 80% 就自動記一筆
const pstore = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; };

async function practiceData() {
  const ex = await learnExport();
  const pr = ex && ex.practice;
  if (!pr || !(pr.items || []).length) return null;
  const byId = new Map(pr.items.map((x) => [x.id, x]));
  const lists = (pr.lists || []).map((l, n) => ({ ...l, n, key: `${l.kind}:${l.name}`, rows: l.items.map((id) => byId.get(id)).filter(Boolean) })).filter((l) => l.rows.length);
  return { ...pr, byId, lists };
}
const isFav = (id) => !!(LREC && LREC.favorites[id] && !LREC.favorites[id].deleted);
const opened = (id) => !!(LREC && LREC.practice_progress[id]);
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function toggleFav(id) {
  LREC.favorites[id] = isFav(id) ? { deleted: true, at: new Date().toISOString() } : { at: new Date().toISOString() };
  lrecSave();
  return isFav(id);
}
// 記一筆練習（同一支同一天一筆；已有就不覆蓋——learn 的 INSERT OR IGNORE）
function practiceLog(item, minutes, source) {
  const key = `${item.id}|${dayKey()}`;
  const cur = LREC.practice_log[key];
  if (cur && !cur.deleted) return false;
  const now = new Date();
  LREC.practice_log[key] = { practiced_at: now.toISOString(), minutes: Math.max(1, Math.round(minutes || item.duration_min || 1)), source, at: now.toISOString() };
  lrecSave();
  return true;
}
// 播放器每 5 秒、暫停、播完時呼叫（courses.js 的 progressSave 轉過來）：記續看位置；這次真正播放 ≥ 80% 就自動記一筆
function practiceProgressSave(meta, el) {
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  const now = new Date().toISOString();
  LREC.practice_progress[meta.itemId] = { t_s: Math.round(el.currentTime * 10) / 10, duration_s: dur ? Math.round(dur) : 0, at: now };
  if (dur && !meta.durationMin) LREC.practice_durations[meta.itemId] = { duration_s: Math.round(dur * 10) / 10, at: now };
  let watched = 0;
  for (let i = 0; i < el.played.length; i++) watched += el.played.end(i) - el.played.start(i);
  lrecSave('progress');
  if (dur && watched >= dur * AUTO_LOG_RATIO && !meta.autoLogged) {
    meta.autoLogged = true;
    if (practiceLog({ id: meta.itemId, duration_min: meta.durationMin }, dur / 60, 'auto80') && typeof meta.onLogged === 'function') meta.onLogged('auto80');
  }
}

/* ── 練習主頁：影片｜清單｜紀錄 ── */
async function viewPractice(qs) {
  const cat = await catalog();
  if (!cat) return emptyState();
  await lrec();
  const data = await practiceData();
  const head = h('div', { class: 'doc-head' }, h('h1', null, '練習'));
  if (!data) {
    const s = await gSettings();
    return setView(head, h('p', { class: 'note' }, s.enabled && gHasToken()
      ? '雲端硬碟「OM App」資料夾裡還沒有 learn 匯出的練習目錄（learn-export.json），請在電腦上的 learn 啟用匯出。'
      : '練習目錄由 learn 匯出到雲端硬碟。到「同步」頁啟用「雲端硬碟影音」並登入 Google，第一次讀到之後離線也能看。'),
      h('a', { class: 'btn primary', href: '#/settings' }, '前往設定'));
  }
  let view = new URLSearchParams(qs || '').get('view') || pstore('om-practice-view') || 'videos';
  if (!['videos', 'lists', 'log'].includes(view)) view = 'videos';
  const pane = h('div', { class: 'tab-pane' });
  const show = (k) => {
    view = k;
    pstore('om-practice-view', k);
    setQs('view', k === 'videos' ? null : k);
    pane.replaceChildren(k === 'videos' ? practiceVideos(data) : k === 'lists' ? practiceLists(data) : practiceLogView(data));
  };
  setView(head, tabBar([['videos', `影片（${data.items.length}）`], ['lists', `清單（${data.lists.length}）`], ['log', '紀錄']], view, show), pane);
  show(view);
}
function styleDot(style) { return h('span', { class: 'p-dot', 'data-s': style || '' }); }
function practiceVideos(data) {
  const st = Object.assign({ q: '', minutes: '', energy: [], styles: [], fav: false, audio: false }, pstore('om-practice-filters') || {});
  const save = () => pstore('om-practice-filters', st);
  const styles = (data.style_order || []).filter((x) => data.items.some((i) => i.style === x))
    .concat([...new Set(data.items.map((i) => i.style).filter(Boolean))].filter((x) => !(data.style_order || []).includes(x)));
  const chip = (label, on, onclick, extra) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(!!on), onclick }, extra || null, label);
  const filters = h('div', { class: 'p-filters' });
  const q = h('input', { type: 'search', class: 'csearch', placeholder: '搜尋標題、老師、標籤、摘要', 'aria-label': '搜尋練習' });
  q.value = st.q;
  const count = h('p', { class: 'muted' });
  const list = h('ul', { class: 'list p-items' });
  const random = h('button', { type: 'button', class: 'btn' }, '隨機選一支');
  let current = [];
  const paintFilters = () => {
    filters.replaceChildren(
      h('div', { class: 'p-row' }, P_MINUTES.map(([k, label]) => chip(label, st.minutes === k, () => { st.minutes = st.minutes === k ? '' : k; save(); paint(); }))),
      h('div', { class: 'p-row' }, (data.energies || ['活力', '平衡', '放鬆']).map((e) => chip(e, st.energy.includes(e), () => { st.energy = st.energy.includes(e) ? st.energy.filter((x) => x !== e) : [...st.energy, e]; save(); paint(); }, h('span', { class: 'p-energy', 'data-e': e }))),
        chip('最愛', st.fav, () => { st.fav = !st.fav; save(); paint(); }, h('span', { class: 'p-star' }, '★')), chip('只聽音訊', st.audio, () => { st.audio = !st.audio; save(); paint(); })),
      h('div', { class: 'p-row' }, styles.map((x) => chip(x, st.styles.includes(x), () => { st.styles = st.styles.includes(x) ? st.styles.filter((y) => y !== x) : [...st.styles, x]; save(); paint(); }, styleDot(x)))));
  };
  const matches = () => {
    const words = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minute = P_MINUTES.find(([k]) => k === st.minutes);
    return data.items.filter((r) => (!minute || minute[2](r.duration_min))
      && (!st.energy.length || st.energy.includes(r.energy)) && (!st.styles.length || st.styles.includes(r.style))
      && (!st.fav || isFav(r.id)) && (!st.audio || r.kind === 'audio')
      && words.every((w) => [r.title, r.style, r.teacher, r.series, r.summary, ...(r.tags || [])].join(' ').toLowerCase().includes(w)));
  };
  const paint = () => {
    paintFilters();
    current = matches();
    count.textContent = `符合 ${current.length} 支（共 ${data.items.length} 支）`;
    list.replaceChildren(...(current.length ? current.map((r) => practiceRow(r)) : [h('li', { class: 'muted' }, '沒有符合的影片。試著拿掉一兩個條件，或按「清除條件」。')]));
    random.disabled = !current.length;
  };
  let typing;
  q.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { st.q = q.value; save(); paint(); }, 150); });
  random.addEventListener('click', () => {
    if (!current.length) return;
    const pick = current[Math.floor(Math.random() * current.length)];
    const el = list.querySelector(`[data-id="${CSS.escape(pick.id)}"]`);
    list.querySelectorAll('.flash').forEach((x) => x.classList.remove('flash'));
    if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  });
  const clear = h('button', { type: 'button', class: 'btn quiet', onclick: () => { Object.assign(st, { q: '', minutes: '', energy: [], styles: [], fav: false, audio: false }); q.value = ''; save(); paint(); } }, '清除條件');
  paint();
  return h('div', null, q, filters, h('div', { class: 'row' }, random, clear), count, list);
}
function practiceRow(r, href) {
  const meta = [r.style, r.level ? `Lv ${r.level}` : '', r.teacher, r.series ? r.series + (r.episode != null ? ` 第 ${r.episode} 集` : '') : '', r.kind === 'audio' ? '音訊' : ''].filter(Boolean).join('・');
  return h('li', null, h('a', { class: 'item p-item', 'data-id': r.id, 'data-s': r.style || '', href: href || '#/practice/item/' + encodeURIComponent(r.id) },
    h('span', { class: 'p-spine' }, r.duration_min != null ? [h('b', null, String(r.duration_min)), h('small', null, '分鐘')] : h('small', null, '時長未知')),
    h('span', { class: 'p-body' },
      h('span', { class: 't' }, isFav(r.id) ? h('span', { class: 'p-star', 'aria-label': '最愛' }, '★ ') : null, r.title),
      h('span', { class: 'm' }, meta),
      r.energy || (r.tags || []).length ? h('span', { class: 'chips' }, r.energy ? h('span', { class: 'tag' }, h('span', { class: 'p-energy', 'data-e': r.energy }), r.energy) : null,
        (r.tags || []).map((x) => h('span', { class: 'tag' }, x))) : null,
      r.summary ? h('span', { class: 'snip' }, r.summary) : null)));
}
// 清單：本人排的＋系列（有集數）＋課堂錄影（依日期）；「接續」開下一支沒開過的（開過＝有播放紀錄；「重新開始」只影響這支手機的顯示）
function listResetAt(l) { return (pstore('om-practice-reset') || {})[l.key] || ''; }
function listDone(l) { const r = listResetAt(l); return l.rows.map((x) => { const p = LREC.practice_progress[x.id]; return !!(p && p.at > r); }); }
function practiceLists(data) {
  const wrap = h('ul', { class: 'p-lists' });
  for (const l of data.lists) {
    const done = listDone(l);
    const next = done.findIndex((x) => !x);
    const unit = P_UNIT[l.kind] || '支';
    const total = l.rows.reduce((s, r) => s + (r.duration_min || 0), 0);
    const nOpened = done.filter(Boolean).length;
    const label = (k) => (l.kind === 'user' ? `${k + 1}.` : `第 ${k + 1} ${unit}`);
    const strip = h('div', { class: 'p-strip', 'aria-hidden': 'true' });
    l.rows.forEach((r, k) => { const sp = h('span', { 'data-s': r.style || '', class: done[k] ? 'on' : null }); sp.style.flex = String(Math.max(1, r.duration_min || 1)); strip.append(sp); });
    const action = next >= 0
      ? h('a', { class: 'btn primary', href: `#/practice/item/${encodeURIComponent(l.rows[next].id)}?list=${l.n}&k=${next}` }, svgIcon('play'), `${next ? '接續' : '開始'}${label(next)}`)
      : h('button', { type: 'button', class: 'btn quiet', onclick: () => { const m = pstore('om-practice-reset') || {}; m[l.key] = new Date().toISOString(); pstore('om-practice-reset', m); wrap.replaceWith(practiceLists(data)); } }, '全部開過・重新開始');
    wrap.append(h('li', { class: 'card p-list' },
      h('div', { class: 'p-lhead' }, h('div', null, h('h3', null, h('span', { class: 'tag' }, P_KIND[l.kind] || ''), ' ', l.name),
        h('p', { class: 'muted' }, [l.teacher, `${l.rows.length} ${unit}`, total ? `共 ${total} 分` : '', nOpened ? `開過 ${nOpened}／${l.rows.length}` : ''].filter(Boolean).join('・'))), action),
      strip,
      h('details', { open: l.rows.length <= 8 }, h('summary', null, `全部 ${l.rows.length} ${unit}`),
        h('ol', { class: 'p-entries' }, l.rows.map((r, k) => h('li', { class: (done[k] ? 'opened' : '') + (k === next ? ' next' : '') },
          h('a', { href: `#/practice/item/${encodeURIComponent(r.id)}?list=${l.n}&k=${k}` }, h('span', { class: 'eno' }, label(k)),
            h('span', { class: 'et' }, r.title, h('small', null, [r.style, r.level ? `Lv ${r.level}` : '', r.energy].filter(Boolean).join('・'))),
            h('span', { class: 'em' }, r.duration_min != null ? `${r.duration_min} 分` : ''))))))));
  }
  return data.lists.length ? wrap : h('p', { class: 'muted' }, '還沒有清單。');
}
// 紀錄：近 60 天依日期分組；可刪除誤記（刪除標記照資料契約）
function practiceLogView(data) {
  const rows = Object.entries(LREC.practice_log).filter(([, v]) => !v.deleted).map(([k, v]) => ({ k, id: k.split('|')[0], day: k.split('|')[1], ...v }))
    .sort((a, b) => b.day.localeCompare(a.day) || String(b.practiced_at).localeCompare(String(a.practiced_at)));
  const since = dayKey(new Date(Date.now() - 60 * 86400000));
  const recent = rows.filter((r) => r.day >= since);
  const total = recent.reduce((s, r) => s + (r.minutes || 0), 0);
  const wrap = h('div', null, h('p', { class: 'muted' }, recent.length ? `近 60 天練了 ${recent.length} 次、共 ${total} 分鐘。這支手機上的紀錄；P4 之後會和電腦、其他裝置同步。` : '近 60 天還沒有紀錄。播放時看到 80% 或按「練完了」就會記一筆。'));
  let day = null, ul = null;
  for (const r of recent) {
    if (r.day !== day) { day = r.day; wrap.append(secTitle(day)); ul = h('ul', { class: 'list' }); wrap.append(ul); }
    const item = data.byId.get(r.id);
    const del = h('button', { type: 'button', class: 'btn quiet', onclick: () => { LREC.practice_log[r.k] = { deleted: true, at: new Date().toISOString() }; lrecSave(); wrap.replaceWith(practiceLogView(data)); } }, '刪除');
    ul.append(h('li', { class: 'p-logrow' }, h('a', { class: 'item', href: item ? '#/practice/item/' + encodeURIComponent(item.id) : '#/practice' },
      h('span', { class: 't' }, item ? item.title : '（目錄裡已沒有這支）'),
      h('span', { class: 'm' }, `${r.minutes || '?'} 分・${r.source === 'auto80' ? '看到 80% 自動記' : r.source === 'manual' ? '按「練完了」' : r.source || ''}`)), del));
  }
  return wrap;
}

/* ── 播放頁 ── */
async function viewPracticeItem(id, qs) {
  const cat = await catalog();
  if (!cat) return emptyState();
  await lrec();
  const data = await practiceData();
  const item = data && data.byId.get(id);
  if (!item) return setView(h('h1', null, '找不到這支練習'), h('p', null, h('a', { href: '#/practice' }, '回練習目錄')));
  const params = new URLSearchParams(qs || '');
  const list = params.has('list') ? data.lists.find((l) => l.n === Number(params.get('list'))) : null;
  const k = list ? Number(params.get('k')) : -1;
  const s = await gSettings();
  const sig = viewAbort.signal;
  const mine = () => !!(PLAYER && PLAYER.meta && PLAYER.meta.itemId === item.id);
  const prog = LREC.practice_progress[item.id];
  const status = h('div', { class: 'status', role: 'status' });
  const slot = h('div', { class: 'lesson-slot p-slot' });
  const meta = { kind: 'practice', itemId: item.id, durationMin: item.duration_min, onLogged: () => { status.textContent = '看到 80%，已記一筆練習紀錄。'; paintDone(); } };
  const doneBtn = h('button', { type: 'button', class: 'btn' });
  const paintDone = () => { const today = LREC.practice_log[`${item.id}|${dayKey()}`]; const on = !!(today && !today.deleted); doneBtn.textContent = on ? '✓ 今天練過了' : '✓ 練完了'; doneBtn.disabled = on; };
  doneBtn.addEventListener('click', () => { if (practiceLog(item, (mine() && Number.isFinite(playerEl().duration) ? playerEl().duration / 60 : item.duration_min), 'manual')) status.textContent = '已記一筆練習紀錄。'; paintDone(); });
  paintDone();
  const favBtn = h('button', { type: 'button', class: 'btn' });
  const paintFav = () => { favBtn.textContent = isFav(item.id) ? '★ 最愛' : '☆ 加入最愛'; favBtn.setAttribute('aria-pressed', String(isFav(item.id))); };
  favBtn.addEventListener('click', () => { toggleFav(item.id); paintFav(); });
  paintFav();
  // 練習音檔（kind＝audio）可以下載離線；下載過的優先用手機上的
  const offSpec = item.kind === 'audio' && item.drive_id ? { key: 'practice:' + item.id, title: item.title, kind: 'practice', ref: item.id, driveId: item.drive_id } : null;
  const offE = offSpec ? await offDone(offSpec.key) : null;
  const start = async () => {
    const e = offSpec && await offDone(offSpec.key);
    if (e) {
      const p0 = LREC.practice_progress[item.id];
      const t = p0 && p0.duration_s && p0.t_s < p0.duration_s * 0.95 ? p0.t_s : 0;
      try { await playerOpen(offFile(e), { t, mode: 'audio', meta }); const el = playerEl(); if (el) el.play().catch(() => {}); }
      catch (err) { status.textContent = '離線播放失敗：' + err.message; }
      return;
    }
    if (!s.enabled) { status.textContent = '到「同步」頁啟用「雲端硬碟影音」並登入 Google，就能在這裡播放。'; return; }
    if (!gHasToken() || gMinutesLeft() < RENEW_BEFORE_MIN) return gLogin({ returnHash: location.hash, resume: null }).catch((e) => { status.textContent = e.message; });
    status.textContent = '讀取雲端硬碟…';
    try {
      // 匯出檔帶的是雲端硬碟 ID：先確認檔案還在（不在垃圾桶），拿到大小給 Service Worker 補 Content-Range
      const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(item.drive_id)}?fields=id,name,size,mimeType,trashed`)).json();
      if (f.trashed) { status.textContent = '這支影片在雲端硬碟的垃圾桶裡。請在電腦上的 learn 重新匯出練習目錄。'; return; }
      status.textContent = '';
      const p0 = LREC.practice_progress[item.id];
      const t = p0 && p0.duration_s && p0.t_s < p0.duration_s * 0.95 ? p0.t_s : 0;
      await playerOpen({ id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || '' }, { t, mode: item.kind === 'audio' ? 'audio' : undefined, meta });
      const el = playerEl();
      if (el) el.play().catch(() => {});
    } catch (e) { status.textContent = e.status === 404 ? '雲端硬碟上找不到這支影片（可能被移除或改了權限）。' : e.status === 401 ? 'Google 登入已過期，請重新登入。' : '讀取失敗：' + e.message; }
  };
  const playBtn = h('button', { type: 'button', class: 'btn primary', onclick: start }, svgIcon('play'), prog && prog.t_s > 5 && (!prog.duration_s || prog.t_s < prog.duration_s * 0.95) ? `從 ${clock(prog.t_s)} 繼續` : '播放');
  const matBtn = h('button', { type: 'button', class: 'btn', onclick: () => matMode(true) }, '墊旁模式');
  const nav = list ? h('div', { class: 'doc-nav' },
    k > 0 ? h('a', { class: 'btn', href: `#/practice/item/${encodeURIComponent(list.rows[k - 1].id)}?list=${list.n}&k=${k - 1}` }, svgIcon('back'), '上一支') : h('span'),
    h('a', { class: 'btn quiet', href: '#/practice?view=lists' }, `${list.name}（${k + 1}／${list.rows.length}）`),
    k + 1 < list.rows.length ? h('a', { class: 'btn', href: `#/practice/item/${encodeURIComponent(list.rows[k + 1].id)}?list=${list.n}&k=${k + 1}` }, '下一支', svgIcon('chev')) : h('span')) : null;
  const nextHref = list && k + 1 < list.rows.length ? `#/practice/item/${encodeURIComponent(list.rows[k + 1].id)}?list=${list.n}&k=${k + 1}&auto=1` : null;
  const endNote = h('div', { class: 'note end-note', hidden: true });
  const head = h('div', { class: 'doc-head p-head', 'data-s': item.style || '' }, h('nav', { class: 'crumb' }, h('a', { href: '#/practice' }, '練習')), h('h1', null, item.title));
  const metaLine = [item.style, item.level ? `Lv ${item.level}` : '', item.teacher, item.series ? item.series + (item.episode != null ? ` 第 ${item.episode} 集` : '') : '', item.duration_min != null ? `${item.duration_min} 分鐘` : '', item.kind === 'audio' ? '音訊' : ''].filter(Boolean).join('・');
  setView(head, h('p', { class: 'page-sub' }, metaLine),
    h('div', { class: 'chips' }, item.energy ? h('span', { class: 'tag' }, h('span', { class: 'p-energy', 'data-e': item.energy }), item.energy) : null, (item.tags || []).map((x) => h('span', { class: 'tag' }, x))),
    h('section', { class: 'lesson-media' }, slot, status,
      h('div', { class: 'row' }, mine() ? null : playBtn, item.kind === 'audio' ? null : matBtn, favBtn, doneBtn, offSpec && (s.enabled || offE) ? offButton(offSpec) : null,
        h('a', { class: 'btn', href: driveViewUrl(item.drive_id), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '雲端硬碟'))), endNote,
    item.summary ? h('p', null, item.summary) : null,
    (item.notes || []).length ? h('ul', { class: 'p-notes' }, item.notes.map((x) => h('li', null, x))) : null, nav);
  PLAYER_SLOT = { name: item.drive_id, el: slot };
  sig.addEventListener('abort', () => { if (PLAYER_SLOT && PLAYER_SLOT.el === slot) PLAYER_SLOT = null; matMode(false, true); });
  if (mine()) { playerAdopt(slot); PLAYER.meta = meta; }
  else if (params.get('auto') === '1' && (offE || (s.enabled && gHasToken()))) start();   // 清單接下一支（墊旁模式倒數後）
  // 播完：清單有下一支就提示（墊旁模式時 5 秒後自動接下一支，learn 同一套）
  let countdown = null;
  const tick = setInterval(() => {
    if (!mine()) return;
    const el = playerEl();
    if (el.ended && endNote.hidden) {
      endNote.hidden = false;
      endNote.replaceChildren('這一支播完了。', nextHref ? h('a', { class: 'btn primary', href: nextHref }, '下一支') : h('span', null, list ? '清單播完了。' : ''));
      if (nextHref && document.body.classList.contains('mat-open')) {
        let left = 5;
        countdown = setInterval(() => { left--; matStatus(`下一支 ${left} 秒後開始`); if (left <= 0) { clearInterval(countdown); location.hash = nextHref; } }, 1000);
      }
    }
    if (!el.ended) endNote.hidden = true;
    matPaint();
  }, 500);
  sig.addEventListener('abort', () => { clearInterval(tick); if (countdown) clearInterval(countdown); });
  if (pstore('om-mat-mode') && item.kind !== 'audio') matMode(true, true);

  // 墊旁模式（learn 1d）：播放畫面撐滿、底部大按鈕（時間、進度、−15／+15、播放、速度、★、✓ 完成），兩公尺外也按得到；
  // 保持螢幕亮著；播放中 4 秒沒動作就收起按鈕，點一下叫回來。開著就記住，下次開播放頁直接進墊旁模式
  function matMode(on, quiet) {
    let ui = document.querySelector('.mat-ui');
    if (!on) {
      if (ui) ui.remove();
      document.body.classList.remove('mat-open');
      if (!quiet) pstore('om-mat-mode', false);
      if (window.__wake) { window.__wake.release().catch(() => {}); window.__wake = null; }
      if (PLAYER) { PLAYER.v.controls = true; PLAYER.a.controls = true; }   // 原生控制列回來
      return;
    }
    if (!quiet) pstore('om-mat-mode', true);
    document.body.classList.add('mat-open');
    if (!ui) {
      ui = h('div', { class: 'mat-ui' },
        h('div', { class: 'mat-top' }, h('button', { type: 'button', class: 'btn mat-btn', 'aria-label': '離開墊旁模式', onclick: () => matMode(false) }, svgIcon('back')), h('strong', null, item.title)),
        h('div', { class: 'mat-bar' },
          h('div', { class: 'mat-time' }, h('span', { class: 'mat-cur' }, '00:00'), h('input', { type: 'range', class: 'mat-seek', min: '0', max: '1000', value: '0', 'aria-label': '播放位置' }), h('span', { class: 'mat-dur' }, '--:--')),
          h('div', { class: 'mat-ctrls' },
            h('button', { type: 'button', class: 'btn mat-btn', 'data-skip': '-15' }, '−15'),
            h('button', { type: 'button', class: 'btn primary mat-play', 'aria-label': '播放' }, svgIcon('play')),
            h('button', { type: 'button', class: 'btn mat-btn', 'data-skip': '15' }, '+15'),
            h('button', { type: 'button', class: 'btn mat-btn mat-rate' }, '1×'),
            h('button', { type: 'button', class: 'btn mat-btn mat-star' }, '★'),
            h('button', { type: 'button', class: 'btn primary mat-done' }, '✓ 完成')),
          h('p', { class: 'mat-status' })));
      document.body.append(ui);
      let idle;
      const wake = () => { ui.classList.remove('is-idle'); clearTimeout(idle); const el = playerEl(); if (el && !el.paused) idle = setTimeout(() => ui.classList.add('is-idle'), 4000); };
      ui.addEventListener('pointerdown', (e) => { if (ui.classList.contains('is-idle')) { e.preventDefault(); e.stopPropagation(); } wake(); }, true);
      ui.addEventListener('click', async (e) => {
        const el = playerEl();
        const skip = e.target.closest('[data-skip]');
        if (e.target.closest('.mat-play')) { if (!mine()) await start(); else if (el.paused) el.play().catch(() => {}); else el.pause(); }
        else if (skip && el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + Number(skip.dataset.skip)));
        else if (e.target.closest('.mat-rate')) { const r = RATES[(RATES.indexOf(playerRate()) + 1) % RATES.length]; playerSetRate(r); }
        else if (e.target.closest('.mat-star')) { toggleFav(item.id); paintFav(); }
        else if (e.target.closest('.mat-done')) doneBtn.click();
        wake(); matPaint();
      });
      ui.querySelector('.mat-seek').addEventListener('input', (e) => { const el = playerEl(); if (el && Number.isFinite(el.duration)) el.currentTime = (Number(e.target.value) / 1000) * el.duration; });
      wake();
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { window.__wake = w; }).catch(() => {});
    }
    matPaint();
  }
  function matStatus(text) { const n = document.querySelector('.mat-status'); if (n) n.textContent = text; }
  const shortClock = (x) => { x = Math.max(0, Math.floor(x || 0)); const hh = Math.floor(x / 3600); const mm = String(Math.floor(x / 60) % 60).padStart(2, '0'); const ss = String(x % 60).padStart(2, '0'); return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`; };
  function matPaint() {
    const ui = document.querySelector('.mat-ui');
    if (!ui) return;
    const el = mine() ? playerEl() : null;
    if (el && PLAYER.v.controls) { PLAYER.v.controls = false; PLAYER.a.controls = false; }   // 墊旁模式只用大按鈕（learn 同）
    const d = el && Number.isFinite(el.duration) ? el.duration : (item.duration_min || 0) * 60;
    const cur = el ? el.currentTime : 0;
    ui.querySelector('.mat-cur').textContent = shortClock(cur);
    ui.querySelector('.mat-dur').textContent = d ? shortClock(d) : '--:--';
    ui.querySelector('.mat-seek').value = d ? String(Math.round((cur / d) * 1000)) : '0';
    ui.querySelector('.mat-play').replaceChildren(svgIcon(el && !el.paused ? 'pause' : 'play'));
    ui.querySelector('.mat-rate').textContent = `${playerRate()}×`;
    ui.querySelector('.mat-star').textContent = isFav(item.id) ? '★' : '☆';
    const today = LREC.practice_log[`${item.id}|${dayKey()}`];
    ui.querySelector('.mat-done').textContent = today && !today.deleted ? '✓ 練過了' : '✓ 完成';
    if (!el && !ui.querySelector('.mat-status').textContent) matStatus(s.enabled && gHasToken() ? '按播放開始。' : '要先在「同步」頁啟用雲端硬碟影音並登入。');
  }
}
