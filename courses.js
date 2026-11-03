// OM Reader——課程層（P2a）：課程清單、課程頁（講次｜整門課摘要｜講義｜筆記）、講次頁（播放、逐字稿、AI 摘要、講義、筆記）、
// 學習進度與首頁的「繼續上課」。對照 learn 的功能逐項移植（docs/OM-App-整合計畫.md §4，在 learn repo）。
// 資料：課程結構直接讀資料包裡的 vault/self/resources/_courses.json（/sync 產生的課程索引）；
// 逐字稿、摘要、講義、筆記的渲染用 learn 交過來的 vendor/learn-text.js（learn 的正本副本，App 這邊不改它）。
// 進度先記在這支手機（加密），格式照 OM App ↔ learn 資料契約的 progress／recent（P4 寫進雲端硬碟的紀錄檔時直接沿用）。
'use strict';

const COURSE_INDEX = 'vault/self/resources/_courses.json';
let COURSES = null;   // { list, byId, lessonById }
let LREC = null;      // { progress: { media.key: {t_s, duration_s, completed, at} }, recent: { lesson_id: {course_id, at} } }
let LEXPORT = null;    // learn-export.json（learn → App）：首頁分組、概念引用（規格：learn repo docs/om-app-contract.md §1）
let lexportChecked = false;
LOCK_HOOKS.push(() => { COURSES = null; LREC = null; LEXPORT = null; });

// 讀 learn 匯出到雲端硬碟「OM App/learn-export.json」的檔：先用手機上的加密快取；有登入時每次開 App 比對一次
// 雲端硬碟上的版本（md5），變了才重新下載。沒登入、離線、沒權限都照用快取。
async function learnExport() {
  if (!LEXPORT) {
    const rec = await kvGet('learn-export');
    if (rec) { try { LEXPORT = JSON.parse(td.decode(await open_(rec))); } catch (e) { LEXPORT = null; } }
  }
  if (!lexportChecked && gHasToken() && navigator.onLine) {
    lexportChecked = true;
    try {
      const folder = await driveFolderFind(['OM App']);
      const f = folder && await driveFindIn(folder, 'learn-export.json');
      if (f && (!LEXPORT || LEXPORT.md5 !== f.md5Checksum)) {
        const data = await (await driveRead(f.id)).json();
        if (data && data.format === 'om-app-learn-export') {
          LEXPORT = { data, md5: f.md5Checksum, modified: f.modifiedTime, at: Date.now() };
          await kvSet('learn-export', await seal(te.encode(JSON.stringify(LEXPORT))));
        }
      }
    } catch (e) { /* 用快取 */ }
  }
  return LEXPORT ? LEXPORT.data : null;
}
// 概念頁：標題 → 路徑（摘要【名詞】↗ 用）
function conceptByTitle(ex) {
  const m = new Map();
  for (const [rel, pg] of Object.entries((ex && ex.concepts && ex.concepts.pages) || {})) m.set(String(pg.title).toLowerCase(), rel);
  return m;
}
// 同名檔不只一個：列出來讓本人選（本人 2026-11-03：不要隨便挑一個）；選了記住
function driveChooser(found, box, onPick) {
  box.replaceChildren(h('p', { class: 'note' }, `雲端硬碟上叫「${found.name}」的檔有 ${found.choices.length} 個，請選要用哪一個（之後會記住）：`),
    listOf(found.choices.map((f) => h('li', { class: 'choice' },
      h('span', { class: 't' }, `${f.modified ? f.modified.slice(0, 16).replace('T', ' ') : '（時間不明）'}・${fmtMB(f.size)}`),
      h('span', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: async () => onPick(await driveChoose(found.name, f)) }, '用這個'),
        h('a', { class: 'btn', href: driveViewUrl(f.id), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '雲端硬碟看'))))));
}

// learn-text 的圖片：![[圖]] 換成資料包裡的檔，交給 hydrateMedia 解密顯示
if (window.LearnText) {
  LearnText.configure({
    attachmentUrl: (name) => { const d = resolveLink(name, ''); return d ? 'om:' + encodeURIComponent(d.p) : ''; },
    renderImage: (src, alt) => (src.startsWith('om:')
      ? `<img data-om="${md.utils.escapeHtml(decodeURIComponent(src.slice(3)))}" alt="${md.utils.escapeHtml(alt)}">`
      : `<span class="wl-missing">${md.utils.escapeHtml(alt)}</span>`),
  });
}
function learnHtml(html) {
  const frag = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    ADD_ATTR: ['data-t', 'data-seek', 'data-line', 'data-om', 'target'],
  });
  const wrap = h('div', { class: 'md learn' });
  wrap.append(frag);
  hydrateMedia(wrap);
  return wrap;
}
const vp = (rel) => (rel ? 'vault/' + rel : null);
// 短格式：不到一小時只寫分:秒（35:22），超過寫 1:05:22（播放鈕用，控制列才放得下一行）
const clockShort = (x) => { x = Math.max(0, Math.floor(x || 0)); const hh = Math.floor(x / 3600); const mm = String(Math.floor(x / 60) % 60).padStart(2, '0'); const ss = String(x % 60).padStart(2, '0'); return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`; };
const clock = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60)].map((v) => String(v).padStart(2, '0')).join(':');

async function courseIndex() {
  if (COURSES) return COURSES;
  const cat = await catalog();
  const d = cat && cat.byPath.get(COURSE_INDEX);
  if (!d) return null;
  const text = await docText(d);
  if (!text) return null;
  const j = JSON.parse(text);
  const byId = new Map(), lessonById = new Map();
  for (const c of j.courses || []) {
    byId.set(c.id, c);
    c.lessons.forEach((l, i) => lessonById.set(l.id, { lesson: l, course: c, i }));
  }
  COURSES = { list: j.courses || [], byId, lessonById };
  return COURSES;
}
async function textOf(rel) {
  const d = CAT && CAT.byPath.get(vp(rel));
  return d ? docText(d) : null;
}

/* ── 學習進度（加密存在這支手機） ── */
async function lrec() {
  if (LREC) return LREC;
  const r = await kvGet('learn-rec');
  let o = {};
  if (r) { try { o = JSON.parse(td.decode(await open_(r))); } catch (e) { o = {}; } }
  LREC = { progress: o.progress || {}, recent: o.recent || {}, bookmarks: o.bookmarks || {},
    practice_progress: o.practice_progress || {}, practice_durations: o.practice_durations || {},
    favorites: o.favorites || {}, practice_log: o.practice_log || {} };
  return LREC;
}
let lrecTimer = null;
// kind＝'progress'：播放中的進度（紀錄同步最多每分鐘寫一次）；其他變動停手幾秒就寫（records.js）
function lrecSave(kind) {
  clearTimeout(lrecTimer);
  if (typeof recTouch === 'function') recTouch(kind);
  lrecTimer = setTimeout(async () => { if (KEY && LREC) await kvSet('learn-rec', await seal(te.encode(JSON.stringify(LREC)))); }, 400);
}
// learn 的規則：拿到長度、套好起始位置之後才寫；≥99% 或播到結束記看完，看完不取消
function progressSave(meta, el) {
  if (!KEY) return;
  if (!LREC) { lrec().then(() => progressSave(meta, el)).catch(() => {}); return; }
  if (el.readyState < 1 || !Number.isFinite(el.currentTime)) return;
  if (meta.kind === 'practice') return practiceProgressSave(meta, el);   // 練習影片：practice.js
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  const prev = LREC.progress[meta.key] || {};
  const now = new Date().toISOString();
  LREC.progress[meta.key] = {
    t_s: Math.round(el.currentTime * 10) / 10, duration_s: dur ? Math.round(dur) : (prev.duration_s || 0),
    completed: !!prev.completed || el.ended || (dur > 0 && el.currentTime / dur >= 0.99), at: now,
  };
  LREC.recent[meta.lessonId] = { course_id: meta.courseId, at: now };
  lrecSave('progress');
}
function lessonProgress(l) {
  const p = LREC && l.media && l.media.key ? LREC.progress[l.media.key] : null;
  if (!p) return null;
  const pct = p.duration_s ? Math.min(100, Math.round((p.t_s / p.duration_s) * 100)) : null;
  return { ...p, pct };
}
function progressBadge(l) {
  const p = lessonProgress(l);
  if (!p) return null;
  if (p.completed) return h('span', { class: 'done', 'aria-label': '已看完' }, '✓');
  return h('span', { class: 'pct' }, p.pct != null ? `${p.pct}%` : clock(p.t_s));
}

/* ── 首頁：繼續上課 ── */
async function continueSection() {
  const ci = await courseIndex();
  if (!ci) return [];
  await lrec();
  const rows = Object.entries(LREC.recent).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
    .map(([id]) => ci.lessonById.get(id)).filter((x) => x && !(lessonProgress(x.lesson) || {}).completed).slice(0, 3);
  if (!rows.length) return [];
  return [secTitle('繼續上課', '#/history?k=lesson', '全部'), listOf(rows.map(({ lesson: l, course: c }) => {
    const p = lessonProgress(l);
    return h('li', null, areaColor(h('a', { class: 'item', href: '#/lesson/' + l.id },
      h('span', { class: 't' }, `${l.order ? l.order + '　' : ''}${l.lesson_title || l.title}`),
      h('span', { class: 'm' }, `${c.title}${p ? `・看到 ${clock(p.t_s)}${p.pct != null ? `（${p.pct}%）` : ''}` : ''}`)), null, c.category));
  }))];
}

/* ── 課程清單（self/resources） ── */
async function viewCourses(cat, lane) {
  const ci = await courseIndex();
  if (!ci) return setView(h('h1', null, '找不到課程索引'), h('p', null, '資料包裡沒有 _courses.json，請先同步。'));
  await lrec();
  // 只有筆記、沒有講次的課：預設不列，開關打開才列（learn 的 U8；本人 2026-11-03：做成開關）
  const notesOnly = (c) => !(c.stats && c.stats.lessons) && !c.lessons.length;
  const showNotesOnly = (() => { try { return localStorage.getItem('om-notes-only') === '1'; } catch (e) { return false; } })();
  const nNotesOnly = ci.list.filter(notesOnly).length;
  const byCat = new Map();
  for (const c of ci.list) {
    if (notesOnly(c) && !showNotesOnly) continue;
    const k = c.category || '其他'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(c);
  }
  const inCourse = new Set(ci.list.flatMap((c) => [...c.lessons.map((l) => vp(l.transcript && l.transcript.md)), ...c.handouts.map((x) => vp(x.md)), ...c.notes.map((x) => vp(x.md))]));
  const loose = cat.docs.filter((d) => d.l === lane && d.s != null && !inCourse.has(d.p) && !isAux(d));
  const total = ci.list.reduce((n, c) => n + c.lessons.length, 0);
  const kids = [h('div', { class: 'doc-head' }, h('h1', null, '課程')),
    h('p', { class: 'page-sub' }, `${laneLabel(lane) ? laneLabel(lane) + '・' : ''}${ci.list.length} 門課・${total} 講・依課程`), courseSearchBox(null)];
  if (nNotesOnly) {
    const box = h('input', { type: 'checkbox', id: 'notes-only' });
    box.checked = showNotesOnly;
    box.addEventListener('change', () => { try { localStorage.setItem('om-notes-only', box.checked ? '1' : '0'); } catch (e) { /* 略過 */ } viewCourses(cat, lane); });
    kids.push(h('label', { class: 'check', for: 'notes-only' }, box, `也顯示只有筆記、沒有講次的課（${nNotesOnly} 門）`));
  }
  const ex = await learnExport();
  const grp = ex && ex.courses && ex.courses.by_course;
  const row = (c) => {
    const done = c.lessons.filter((l) => (lessonProgress(l) || {}).completed).length;
    const tags = grp && grp[c.id] ? (grp[c.id].tags || []) : [];
    return h('li', null, areaColor(h('a', { class: 'item', href: '#/course/' + encodeURIComponent(c.id) }, h('span', { class: 't' }, c.title),
      h('span', { class: 'm' }, `${notesOnly(c) ? '只有筆記' : `${c.lessons.length} 講`}${done ? `・已看完 ${done}` : ''}${c.handouts.length ? `・講義 ${c.handouts.length}` : ''}${c.notes.length ? `・我的筆記 ${c.notes.length}` : ''}`),
      tags.length ? h('span', { class: 'chips' }, tags.filter((x) => x !== '只有筆記').map((x) => h('span', { class: 'tag' }, x))) : null), null, c.category));
  };
  if (grp) {   // learn 的分組：主題 → 老師（learn 的 config/course_groups.json，App 不移植分組規則）
    const shown = [...byCat.values()].flat();
    const subjects = new Map();
    for (const c of shown) {
      const g = grp[c.id] || { subject: '其他', teacher: '未標示' };
      if (!subjects.has(g.subject)) subjects.set(g.subject, new Map());
      const tm = subjects.get(g.subject);
      if (!tm.has(g.teacher)) tm.set(g.teacher, []);
      tm.get(g.teacher).push(c);
    }
    const order = ex.courses.subject_order || [];
    const rank = (x) => { const k = order.indexOf(x); return k < 0 ? 999 : k; };
    for (const sub of [...subjects.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh-Hant'))) {
      kids.push(h('div', { class: 'sec-title subject' }, sub));
      for (const [teacher, list] of subjects.get(sub)) kids.push(h('div', { class: 'teacher-head' }, teacher), listOf(list.map(row)));
    }
  } else {
    for (const [k, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
      kids.push(h('div', { class: 'sec-title' }, h('span', null, areaColor(h('span', { class: 'sec-dot' }), null, k), k)), listOf(list.map(row)));
    }
    kids.push(h('p', { class: 'muted' }, '登入 Google 後，會讀 learn 匯出的分組（主題 → 老師）與概念。'));
  }
  if (loose.length) kids.push(h('details', { class: 'aux' }, h('summary', null, `不屬於任何課程（${loose.length}）`), listOf(loose.map((d) => itemLink(d)))));
  kids.push(h('p', { class: 'muted more' }, h('a', { href: '#/l/' + enc(lane) + '?all=1' }, '改看全部檔案清單')));
  setView(...kids);
}
// 舊網址 #/c/<序號>：換成課程 ID
async function viewCourse(ci) {
  const cat = await catalog();
  const old = ((cat && cat.ui && cat.ui.courses) || [])[ci];
  const idx = await courseIndex();
  const c = old && idx && idx.list.find((x) => x.title === old.t);
  if (c) { history.replaceState(null, '', location.pathname + location.search + '#/course/' + encodeURIComponent(c.id)); return viewCourseById(c.id, ''); }
  setView(h('h1', null, '找不到這門課'));
}

/* ── 分頁列（講次｜整門課摘要…）：選中用石頭色系 ── */
function tabBar(tabs, cur, onPick) {
  const bar = h('div', { class: 'seg-tabs', role: 'tablist' });
  for (const [k, label] of tabs) {
    bar.append(h('button', { type: 'button', role: 'tab', class: 'filter', 'aria-pressed': String(k === cur), 'aria-selected': String(k === cur),
      onclick: (e) => { bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); onPick(k); } }, label));
  }
  return bar;
}
const qsTab = (qs, def) => new URLSearchParams(qs || '').get('tab') || def;
function setQs(key, val) {
  const [base, qs] = location.hash.split('?');
  const p = new URLSearchParams(qs || '');
  if (val == null) p.delete(key); else p.set(key, val);
  history.replaceState(null, '', location.pathname + location.search + base + (p.toString() ? '?' + p : ''));
}

/* ── 課程頁 ── */
async function viewCourseById(id, qs) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const ci = await courseIndex();
  const c = ci && ci.byId.get(id);
  if (!c) return setView(h('h1', null, '找不到這門課'));
  await lrec();
  const done = c.lessons.filter((l) => (lessonProgress(l) || {}).completed).length;
  const head = areaColor(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/courses' }, '課程')),
    h('h1', null, c.title)), null, c.category);
  const sub = h('p', { class: 'page-sub' }, `${c.lessons.length} 講・已看完 ${done}／${c.lessons.length}`);
  const tabs = [['lessons', '講次'], ['digest', '整門課摘要']];
  if (c.handouts.length) tabs.push(['handouts', `講義（${c.handouts.length}）`]);
  if (c.notes.length) tabs.push(['notes', `我的筆記（${c.notes.length}）`]);
  const exC = await learnExport();
  const cmap = exC && exC.concepts && exC.concepts.by_course ? exC.concepts.by_course[c.id] || [] : [];
  if (cmap.length) tabs.push(['concepts', `概念地圖（${cmap.length}）`]);
  tabs.push(['search', '搜尋本課']);
  const pane = h('div', { class: 'tab-pane' });
  const show = async (k) => {
    setQs('tab', k === 'lessons' ? null : k);
    pane.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
    if (k === 'lessons') pane.replaceChildren(courseLessons(c));
    else if (k === 'digest') pane.replaceChildren(await courseDigest(c));
    else if (k === 'handouts') pane.replaceChildren(listOf(c.handouts.map((x) => cat.byPath.get(vp(x.md))).filter(Boolean).map((d) => itemLink(d))));
    else if (k === 'notes') pane.replaceChildren(listOf(c.notes.map((x) => cat.byPath.get(vp(x.md))).filter(Boolean).map((d) => itemLink(d))));
    else if (k === 'concepts') pane.replaceChildren(listOf(cmap.map((x) => { const d = cat.byPath.get('vault/' + x.path);
      return h('li', null, h('a', { class: 'item', href: d ? pageHref(d.p) : '#/' }, h('span', { class: 't' }, x.title), h('span', { class: 'm' }, `引用 ${x.refs} 處・${x.lessons} 講`))); })));
    else if (k === 'search') { const box = courseSearchBox(c); pane.replaceChildren(box); box.querySelector('input').focus(); }
  };
  let cur = qsTab(qs, 'lessons');
  if (!tabs.some((t) => t[0] === cur)) cur = 'lessons';
  // 有影音的課：整門課一起下載離線（啟用雲端硬碟功能才出現）
  const offSpecs = c.lessons.filter((l) => l.media && l.media.key && offCanMedia(l.media.key))
    .map((l) => ({ key: l.media.key, src: l.media.source_file, title: `${c.title}｜${l.order ? l.order + ' ' : ''}${l.lesson_title || l.title}`, kind: 'lesson', ref: l.id, driveName: l.media.key }));
  const allAudio = offSpecs.every((x) => !/\.(mp4|m4v|mov|webm)$/i.test(x.key));
  const gs = await gSettings();
  // 影片課：前幾講在雲端硬碟上有同名聲音檔，就出現「影片｜聲音」切換
  // 索引記了轉錄用音檔（source_file）的課直接出現；否則看前幾講在雲端硬碟上有沒有同名聲音檔
  let hasAlt = offSpecs.some((x) => isVideoKey(x.key) && altNames(x.key, x.src)[0] === x.src);
  if (!hasAlt && !allAudio && gs.enabled && gHasToken()) {
    const first = offSpecs.filter((x) => isVideoKey(x.key)).slice(0, 3);
    hasAlt = (await Promise.all(first.map((x) => driveAlt(x.key, x.src).catch(() => null)))).some(Boolean);
  }
  const offRow = offSpecs.length && gs.enabled ? offCourseRow(offSpecs, allAudio ? '音檔' : '影音', hasAlt ? { courseId: c.id } : {}) : null;
  setView(head, h('div', { class: 'chips' }, c.category ? areaChip(c.category) : null), sub, offRow, tabBar(tabs, cur, show), pane);
  show(cur);
}
// 講次：多梯次依系列分組；章（NN.NN 的 NN）一列標題，帶該章講義；每講列尾 ✓ 或看到幾成
function courseLessons(c) {
  const wrap = h('div');
  const multi = new Set(c.lessons.map((l) => l.series || '')).size > 1;
  let series = null, chapter = null, list = null;
  const chapterHandouts = (ch) => c.handouts.filter((x) => x.chapter === ch && (!multi || x.series === series));
  for (const l of c.lessons) {
    if (multi && (l.series || '') !== series) {
      series = l.series || '';
      chapter = null;
      wrap.append(h('div', { class: 'sec-title' }, series || '其他'));
      list = null;
    }
    if (l.chapter != null && l.chapter !== chapter) {
      chapter = l.chapter;
      const hs = chapterHandouts(chapter);
      wrap.append(h('div', { class: 'chapter-head' }, h('span', null, `第 ${chapter} 章`),
        ...hs.map((x) => { const d = CAT.byPath.get(vp(x.md)); return d ? h('a', { class: 'chip-link', href: pageHref(d.p) }, '講義：' + (x.handout_title || x.title)) : null; })));
      list = null;
    }
    if (!list) { list = h('ul', { class: 'list lessons' }); wrap.append(list); }
    list.append(h('li', null, h('a', { class: 'item lesson-row', href: '#/lesson/' + l.id },
      h('span', { class: 't' }, `${l.order || l.date || ''}${l.order || l.date ? '　' : ''}${l.lesson_title || l.title}`),
      h('span', { class: 'm' }, l.media && l.media.kind ? (/^mp[34]$|^m4a$/.test(l.media.kind) && l.media.kind !== 'mp4' ? '音訊' : '影片') : ''),
      progressBadge(l))));
  }
  return wrap;
}
// 整門課摘要：各講主旨＋重點依講次串起，其餘收合；時間點直接開該講並跳到那一秒
async function courseDigest(c) {
  const wrap = h('div', { class: 'digest' });
  for (const l of c.lessons) {
    const text = l.transcript ? await textOf(l.transcript.md) : null;
    const s = text && l.summary ? LearnText.summaryOf(text, l.summary) : null;
    const art = h('article', { class: 'digest-lesson' }, h('h3', null, h('a', { href: '#/lesson/' + l.id }, `${l.order ? l.order + '　' : ''}${l.lesson_title || l.title}`)));
    if (!s) art.append(h('p', { class: 'muted' }, '這一講沒有 AI 摘要。'));
    else {
      const link = (t) => h('a', { class: 'ts', href: `#/lesson/${l.id}?t=${t}` }, clock(t));
      const main = s.sections.filter((x) => x.name === '主旨' || x.name === '重點');
      const rest = s.sections.filter((x) => x.name && x.name !== '主旨' && x.name !== '重點');
      main.forEach((x) => art.append(summarySection(x, link)));
      if (rest.length) art.append(h('details', null, h('summary', null, rest.map((x) => x.name).join('、')), ...rest.map((x) => summarySection(x, link))));
    }
    wrap.append(art);
  }
  return wrap;
}
const SECTION_CLASS = { 主旨: 'main', 重點: 'main', 練習應用: 'practice', 名詞: 'terms' };
let TERM_PAGES = null;   // 概念頁標題 → 路徑（講次頁開頭設好）
function summarySection(sec, timeEl, { termChips = false } = {}) {
  if (sec.name === '主旨') return h('p', { class: 'summary-gist' }, sec.text);
  const box = h('section', { class: 'summary-section ' + (SECTION_CLASS[sec.name] || 'other') }, h('h4', null, sec.name));
  if (sec.text) box.append(h('p', null, sec.text));
  if (sec.items.length) {
    if (termChips && sec.name === '名詞') {
      box.append(h('div', { class: 'chips' }, sec.items.map((it) => {
        const cut = it.text.search(/[：:]/);
        const name = cut > 0 ? it.text.slice(0, cut) : it.text;
        const key = name.replace(/[（(].*$/, '').trim().toLowerCase();
        const rel = TERM_PAGES && (TERM_PAGES.get(name.toLowerCase()) || TERM_PAGES.get(key));
        const d = rel && CAT.byPath.get('vault/' + rel);
        return h('span', { class: 'tag', title: it.text }, name, d ? h('a', { class: 'concept-arrow', href: pageHref(d.p), 'aria-label': `wiki 概念頁：${docTitle(d)}` }, '↗') : null);
      })));
    } else {
      box.append(h('ul', { class: 'summary-items' }, sec.items.map((it) => h('li', it.t_s == null ? null : { 'data-t': it.t_s },
        it.t_s == null ? null : timeEl(it.t_s), h('span', null, it.text)))));
    }
  }
  return box;
}

/* ── 講次頁 ── */
async function viewLesson(id, qs) {
  const cat = await catalog();
  if (!cat) return emptyState();
  const ci = await courseIndex();
  const hit = ci && ci.lessonById.get(id);
  if (!hit) return setView(h('h1', null, '找不到這一講'));
  await lrec();
  const { lesson: l, course: c, i } = hit;
  const key = l.media && l.media.key;
  const meta = key ? { key, lessonId: l.id, courseId: c.id } : null;
  const startT = Number(new URLSearchParams(qs || '').get('t')) || 0;
  const prog = lessonProgress(l);
  const isAudio = l.media && l.media.kind && l.media.kind !== 'mp4';
  const sig = viewAbort.signal;
  const mine = () => !!(PLAYER && PLAYER.meta && PLAYER.meta.lessonId === l.id);

  // 播放區：播放畫面借進這裡；沒啟用、沒登入時說明怎麼做
  const slot = h('div', { class: 'lesson-slot' });
  const mediaNote = h('div', { class: 'status', role: 'status' });   // div：同名檔的選單也放這裡
  const playBtn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('play'), prog && !prog.completed && prog.t_s > 5 ? `從 ${clockShort(prog.t_s)}` : '播放');   // 本人 2026-11-04：拿掉「繼續」，控制列才放得下一行
  // 離線影音（P5）：講次的 mp3／m4a／mp4 可以下載到手機；下載過的優先用手機上的，不用網路、不用登入
  const offSpec = key && offCanMedia(key) ? { key, title: `${c.title}｜${l.order ? l.order + ' ' : ''}${l.lesson_title || l.title}`, kind: 'lesson', ref: l.id, driveName: key } : null;
  const offE = offSpec ? await offDone(key) : null;
  // 影片講次另有同名聲音檔（.mp3／.m4a）：可以選播、下載哪一種（每門課記一個偏好）
  const altKeys = key && isVideoKey(key) ? altNames(key, l.media.source_file) : [];
  let alt = null;                                         // { name, size }：雲端硬碟上或手機上有的聲音檔
  const altOff = altKeys.length ? await offAltDone(key, l.media.source_file) : null;
  if (altOff) alt = { name: altOff.drive.name, size: altOff.size };
  else if (altKeys.length && altKeys[0] === l.media.source_file) alt = { name: l.media.source_file, size: 0 };   // 索引記了轉錄用的音檔：先顯示切換，雲端硬碟查不到再收起
  let src = srcPref(c.id);
  const wantAudio = () => !!alt && src === 'audio';
  const startAt = async (t) => {
    let audio = wantAudio();
    let e = await offDone(audio ? alt.name : key);
    if (!e && !gHasToken()) {   // 沒登入：選的那種沒下載、另一種有，就播有的那種
      const other = audio ? await offDone(key) : (alt ? await offDone(alt.name) : null);
      if (other) { e = other; audio = !audio; }
    }
    if (!e) return openLessonMedia(l, meta, t, audio || isAudio, mediaNote, audio ? alt.name : key);
    mediaNote.textContent = '';
    try { await playerOpen(offFile(e), { t, mode: audio || isAudio ? 'audio' : undefined, meta }); const el = playerEl(); if (el) el.play().catch(() => {}); }
    catch (err) { mediaNote.textContent = '離線播放失敗：' + err.message; }
  };
  playBtn.addEventListener('click', () => startAt(startT || (prog && !prog.completed ? prog.t_s : 0)));
  // 控制列只佔一行（本人 2026-11-03：播放與倍速鈕太佔版面）：播放｜速度下拉｜跟隨｜收起影片
  const rateSel = h('select', { class: 'rate-sel', 'aria-label': '播放速度' }, RATES.map((r) => h('option', { value: r }, r + '×')));
  rateSel.value = playerRate();
  rateSel.addEventListener('change', () => playerSetRate(rateSel.value));
  const followBox = h('input', { type: 'checkbox', id: 'follow' });
  followBox.checked = (() => { try { return localStorage.getItem('om-follow') !== '0'; } catch (e) { return true; } })();
  followBox.addEventListener('change', () => { try { localStorage.setItem('om-follow', followBox.checked ? '1' : '0'); } catch (e) { /* 略過 */ } });
  const s = await gSettings();
  const media = h('section', { class: 'lesson-media' }, slot, mediaNote);
  if (!key) mediaNote.textContent = '這一講沒有影音檔。';
  else if (!s.enabled && !offE) mediaNote.append('影音在雲端硬碟。到「同步」頁啟用「雲端硬碟影音」後，就能在這裡播放。');
  // 收起影片：只藏畫面，聲音照播、控制列留著（learn 的做法；每一講開始都是展開的）
  const fold = h('button', { type: 'button', class: 'btn quiet fold', 'aria-pressed': 'false', hidden: true, title: '收起影片畫面，只聽聲音、逐字稿變高' }, '收起影片');
  fold.addEventListener('click', () => {
    const off = media.classList.toggle('video-off');
    fold.textContent = off ? '展開影片' : '收起影片';
    fold.setAttribute('aria-pressed', String(off));
  });
  playBtn.hidden = mine();
  const playable = !!key && (s.enabled || !!offE || !!altOff);
  // 下載鈕跟著「影片｜聲音」的選擇換
  const offSlot = h('span', { class: 'off-slot' });
  const paintOff = () => {
    if (!offSpec) return;
    offSlot.replaceChildren(offButton(wantAudio() ? { ...offSpec, key: alt.name, title: offSpec.title + '（聲音）', driveName: alt.name } : offSpec));
  };
  paintOff();
  // 「影片｜聲音」切換：還沒開始播時才出現（播放中要聽聲音可以改用播放器的聲音模式）
  const srcRow = h('div', { class: 'seg-tabs src-row', role: 'group', 'aria-label': '播放影片或聲音', hidden: true });
  const paintSrc = () => {
    srcRow.replaceChildren(...[['video', '影片'], ['audio', alt && alt.size ? `聲音（${fmtSize(alt.size)}）` : '聲音']].map(([v, name]) =>
      h('button', { type: 'button', class: 'filter', 'aria-pressed': String((src === 'audio' && alt ? 'audio' : 'video') === v), onclick: () => { src = v; srcSet(c.id, v); paintSrc(); paintOff(); } }, name)));
    srcRow.hidden = !alt || mine();
  };
  if (playable) media.append(srcRow, h('div', { class: 'lesson-ctl' }, playBtn, rateSel,
    h('label', { class: 'check follow', for: 'follow', title: '逐字稿跟隨播放' }, followBox, '跟隨'), fold, offSlot));
  if (altKeys.length && s.enabled && gHasToken()) {   // 雲端硬碟上有沒有同名聲音檔：查到再顯示切換（不擋畫面）
    driveAlt(key, l.media.source_file).then((f) => { if (f) alt = { name: f.name, size: f.size }; else if (!altOff) alt = null; paintSrc(); paintOff(); }).catch(() => {});
  }
  paintSrc();

  // 分頁：逐字稿｜摘要｜講義｜我的筆記
  const text = l.transcript ? await textOf(l.transcript.md) : null;
  const summary = text && l.summary ? LearnText.summaryOf(text, l.summary) : null;
  const handouts = (l.handout_ids || []).map((hid) => c.handouts.find((x) => x.id === hid)).filter(Boolean);
  const attached = new Set(c.lessons.flatMap((y) => y.handout_ids || []));
  const sharedIds = new Set(c.handouts.filter((x) => !attached.has(x.id)).map((x) => x.id));
  const mineHandouts = [...handouts, ...c.handouts.filter((x) => sharedIds.has(x.id))];
  const mineIds = new Set(mineHandouts.map((x) => x.id));
  const otherHandouts = [];
  for (const y of c.lessons) for (const hid of y.handout_ids || []) {
    const x = c.handouts.find((z) => z.id === hid);
    if (x && !mineIds.has(x.id) && !otherHandouts.some((o) => o.x.id === x.id)) otherHandouts.push({ x, lesson: y });
  }
  const tabs = [['transcript', '逐字稿'], ['summary', '摘要']];
  if (c.handouts.length) tabs.push(['handouts', mineHandouts.length ? `講義（${mineHandouts.length}）` : '講義']);
  if (c.notes.length) tabs.push(['notes', '我的筆記']);
  const ex = await learnExport();
  TERM_PAGES = conceptByTitle(ex);
  const lconcepts = ex && ex.concepts && ex.concepts.by_lesson ? ex.concepts.by_lesson[l.id] || [] : [];
  if (lconcepts.length) tabs.push(['concepts', `概念（${lconcepts.length}）`]);
  tabs.push(['bookmarks', '書籤']);
  const panes = {};
  const pane = h('div', { class: 'tab-pane' });
  const seekBtn = (t) => h('button', { type: 'button', class: 'ts', 'data-seek': String(t) }, clock(t));
  panes.transcript = () => {
    if (!text) return h('p', { class: 'muted' }, '這一講的逐字稿還沒同步。');
    return learnHtml(LearnText.renderTranscript(text, l.transcript.body_start_line).html);
  };
  panes.summary = () => {
    if (!summary) return h('p', { class: 'muted' }, '這一講還沒有 AI 摘要。');
    const box = h('div', { class: 'summary' }, summary.sections.map((x) => summarySection(x, seekBtn, { termChips: true })));
    if (summary.note) box.append(h('p', { class: 'muted' }, 'AI 摘要：' + summary.note));
    return box;
  };
  // 講義：有原檔 PDF 的兩份都在，工具列「原檔／文字版」切換（learn 4158fda 的做法：預設原檔；選擇所有講義共用、
  // 換頁也記得）。沒有 PDF 的只有文字版、不出切換鈕；原檔不是 PDF（txt／docx）時文字版為主、給「開啟原檔」。
  // 原檔要從雲端硬碟讀：沒啟用或沒登入時照樣顯示文字版，並說明原因
  // 講義分頁（learn 71bd5a6）：頁籤＝這一講的講義＋全課共用的（沒有掛在任何一講上的，標「全課」）；
  // 其他講次的講義收進「其他講次 ▾」下拉，依講次分組，選了才讀。頁籤名稱去掉開頭重複的講名，全名放在 title
  const handoutSection = async (x) => {
    const t = await textOf(x.md);
    const d = CAT.byPath.get(vp(x.md));
    const isPdf = !!x.pdf_key && /\.pdf$/i.test(x.pdf_key);
    const row = h('div', { class: 'row' }, d ? h('a', { class: 'btn quiet', href: pageHref(d.p) }, '單獨開啟') : null);
    const pdfBox = h('div', { class: 'pdf-view hv-pdf' });
    const textBox = h('div', { class: 'hv-text' }, t ? learnHtml(asHtml(LearnText.renderMarkdown(t, x.body_start_line || 1))) : h('p', { class: 'muted' }, '講義文字還沒同步。'));
    const sec = h('section', { class: 'handout' }, h('h3', null, x.handout_title || x.title));
    if (isPdf) {
      const bar = h('div', { class: 'seg-tabs hv-bar', role: 'group', 'aria-label': '原檔或文字版' });
      let loaded = false, failed = false;   // 原檔讀不到：文字版照樣顯示（learn：PDF 未就位就顯示文字版）
      const apply = (v) => {
        bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hv === v)));
        const can = s.enabled && gHasToken();
        const wantPdf = v === 'pdf' && can;
        pdfBox.hidden = !wantPdf;
        textBox.hidden = wantPdf;
        note.textContent = v === 'pdf' && !can ? (s.enabled ? '原檔在雲端硬碟，要登入 Google 才讀得到；先顯示文字版。' : '原檔在雲端硬碟，啟用「雲端硬碟影音」並登入後才讀得到；先顯示文字版。') : '';
        if (wantPdf && !loaded) { loaded = true; openDrivePdf(x.pdf_key, row, pdfBox, null).then((ok) => { if (!ok) { failed = true; textBox.hidden = false; } }); }
        if (wantPdf && failed) textBox.hidden = false;
      };
      const note = h('p', { class: 'muted' });
      for (const [v, label, title] of [['pdf', '原檔', '同學或課程提供的原始 PDF'], ['text', '文字版', '整理過的文字版（含更正）']]) {
        bar.append(h('button', { type: 'button', class: 'filter', 'data-hv': v, title, onclick: () => {
          try { localStorage.setItem('om-handout-view', v); } catch (e) { /* 略過 */ }
          apply(v);   // 一次只顯示一份講義；選擇記成偏好，下一份也照這個顯示
        } }, label));
      }
      sec.append(bar, row, note, pdfBox, textBox);
      apply(handoutView());
    } else {
      if (x.pdf_key && s.enabled) row.append(h('button', { type: 'button', class: 'btn', onclick: async () => {
        const f = await driveFind(x.pdf_key, { validate: true }).catch(() => null);
        if (f && f.id) window.open(driveViewUrl(f.id), '_blank', 'noopener');
      } }, svgIcon('external'), '開啟原檔'));
      sec.append(row, textBox);
    }
    return sec;
  };
  panes.handouts = async () => {
    const box = h('div');
    const doc = h('div', { class: 'hc-doc' });
    const show = async (x) => { doc.replaceChildren(h('p', { class: 'muted' }, '載入中…')); doc.replaceChildren(await handoutSection(x)); wireSeek(doc); };
    const trim = (name) => { const lt = l.lesson_title || ''; const n = String(name || ''); return lt && n.startsWith(lt) && n.length > lt.length ? n.slice(lt.length).replace(/^[\s｜|:：-]+/, '') : n; };
    const tabsRow = h('div', { class: 'seg-tabs hc-tabs', role: 'tablist' });
    mineHandouts.forEach((x, k) => tabsRow.append(h('button', { type: 'button', class: 'filter', role: 'tab', 'aria-pressed': String(k === 0), title: x.handout_title || x.title,
      onclick: (e) => { tabsRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); if (other) other.value = ''; show(x); } },
      trim(x.handout_title || x.title), sharedIds.has(x.id) ? h('span', { class: 'hc-badge' }, '全課') : null)));
    let other = null;
    if (otherHandouts.length) {
      other = h('select', { class: 'hc-other', 'aria-label': '其他講次的講義' }, h('option', { value: '' }, '其他講次的講義'));
      const groups = new Map();
      for (const { x, lesson } of otherHandouts) { const g = lesson ? `${lesson.order ? lesson.order + '　' : ''}${lesson.lesson_title || lesson.title}` : '其他'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
      for (const [g, xs] of groups) other.append(h('optgroup', { label: g }, xs.map((x) => h('option', { value: x.id }, x.handout_title || x.title))));
      other.addEventListener('change', () => {
        const x = c.handouts.find((y) => y.id === other.value);
        if (!x) return;
        tabsRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        show(x);
      });
    }
    box.append(h('div', { class: 'hc-tools' }, tabsRow, other));
    box.append(doc);
    if (mineHandouts.length) await show(mineHandouts[0]);
    else doc.replaceChildren(h('p', { class: 'muted' }, '這一講沒有掛接講義；可從「其他講次」選一份。'));
    return box;
  };
  panes.concepts = () => h('div', null, lconcepts.map((x) => {
    const d = CAT.byPath.get('vault/' + x.path);
    return h('section', { class: 'concept-refs' }, h('h3', null, d ? h('a', { href: pageHref(d.p) }, x.title) : x.title),
      h('ul', { class: 'summary-items' }, x.refs.map((r) => h('li', { 'data-t': r.t_s }, seekBtn(r.t_s), h('span', null, r.snippet)))));
  }));
  panes.notes = async () => {
    const box = h('div');
    // 我的筆記裡「@講次 hh:mm:ss 一句話」的片段：出現在對應講次（learn 同一套錨點）
    if (l.order) {
      const frags = [];
      for (const x of c.notes) for (const line of LearnText.splitlines(await textOf(x.md) || '')) {
        const m = /^\s*(?:[-*]\s+)?@(\S+)\s+(\d{1,2}):(\d{2}):(\d{2})\s*(.*)$/.exec(line);
        if (m && m[1] === l.order) frags.push({ t: (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]), text: m[5] });
      }
      if (frags.length) box.append(h('section', { class: 'handout' }, h('h3', null, `這一講的筆記片段（${frags.length}）`),
        h('ul', { class: 'summary-items' }, frags.sort((a, b) => a.t - b.t).map((f) => h('li', { 'data-t': f.t }, seekBtn(f.t), h('span', null, f.text))))));
    }
    for (const x of c.notes) {
      const t = await textOf(x.md);
      const d = CAT.byPath.get(vp(x.md));
      box.append(h('section', { class: 'handout' }, h('h3', null, d ? h('a', { href: pageHref(d.p) }, docTitle(d)) : x.md),
        t ? learnHtml(asHtml(LearnText.renderMarkdown(t, x.body_start_line || 1))) : h('p', { class: 'muted' }, '筆記還沒同步。')));
    }
    return box;
  };
  panes.bookmarks = () => {
    const status = h('p', { class: 'status', role: 'status' });
    const list = h('ul', { class: 'bookmarks' });
    const render = () => {
      const rows = bookmarksOf(l.id);
      list.replaceChildren(...(rows.length ? rows.map((b) => {
        const input = h('input', { type: 'text', class: 'bookmark-text', placeholder: '寫一句話（可留白）', 'aria-label': '書籤內容', maxlength: '500' });
        input.value = b.text || '';
        input.addEventListener('change', () => bookmarkPut(b.uid, { ...LREC.bookmarks[b.uid], text: input.value }));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        const del = h('button', { type: 'button', class: 'btn quiet', 'aria-label': '刪除這個書籤', onclick: () => { LREC.bookmarks[b.uid] = { deleted: true, at: new Date().toISOString() }; lrecSave(); render(); } }, '刪除');
        return h('li', { class: 'bookmark' }, seekBtn(Math.floor(b.t_s)), input, del);
      }) : [h('li', { class: 'muted' }, '還沒有書籤。播放時按「＋ 在這裡加書籤」。')]));
      wireSeek(list);
    };
    const add = h('button', { type: 'button', class: 'btn primary', onclick: () => {
      if (!mine()) { status.textContent = '要先播放這一講，才知道書籤落在哪一秒。'; return; }
      const uid = crypto.randomUUID ? crypto.randomUUID() : gRandom();
      const now = new Date().toISOString();
      bookmarkPut(uid, { lesson_id: l.id, course_id: c.id, t_s: Math.round(playerEl().currentTime * 10) / 10, text: '', created_at: now });
      render();
      const inputs = list.querySelectorAll('.bookmark-text');
      const row = [...list.querySelectorAll('.bookmark')].find((li) => li.querySelector('.ts') && Number(li.querySelector('.ts').dataset.seek) === Math.floor(LREC.bookmarks[uid].t_s));
      (row ? row.querySelector('.bookmark-text') : inputs[inputs.length - 1]).focus();
    } }, '＋ 在這裡加書籤');
    const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
      const rows = bookmarksOf(l.id);
      if (!rows.length) { status.textContent = '這一講還沒有書籤可以複製。'; return; }
      const txt = rows.map((b) => bookmarkLine(l, b)).join('\n');
      status.textContent = (await copyText(txt)) ? `已複製 ${rows.length} 行，貼到 Notion 的課程筆記即可；下次同步後會出現在對應的講次旁邊。` : '自動複製失敗：' + txt;
    } }, '複製成筆記格式');
    render();
    return h('div', null, h('div', { class: 'row' }, add, copy), status, list);
  };
  const back = h('button', { type: 'button', class: 'btn back-current', hidden: true });
  const show = async (k) => {
    setQs('tab', k === 'transcript' ? null : k);
    pane.replaceChildren(await panes[k]());
    wireSeek(pane);
  };
  let cur = qsTab(qs, 'transcript');
  if (!tabs.some((t) => t[0] === cur)) cur = 'transcript';

  const prev = c.lessons[i - 1], next = c.lessons[i + 1];
  // 影片下方的重點刻度（重點與練習應用的時間點）：拿到長度才畫，點了跳過去
  const points = (summary ? summary.sections : []).filter((x) => x.name === '重點' || x.name === '練習應用')
    .flatMap((x) => x.items.filter((it) => it.t_s != null).map((it) => ({ ...it, kind: x.name })));
  const ticks = h('div', { class: 'ticks', hidden: true, 'aria-label': '重點時間' });
  let ticksFor = 0;
  const drawTicks = (dur) => {
    if (!points.length || !dur || dur === ticksFor) return;
    ticksFor = dur;
    // 位置用 element.style 設（CSP 擋 style 屬性，不擋程式設定的樣式）
    ticks.replaceChildren(...points.map((pt) => {
      const b = h('button', { type: 'button', class: 'tick' + (pt.kind === '練習應用' ? ' practice' : ''), 'data-seek': String(pt.t_s),
        'aria-label': `${clock(pt.t_s)} ${pt.text.slice(0, 24)}`, title: `${clock(pt.t_s)} ${pt.text.slice(0, 40)}` });
      b.style.left = `${Math.min(100, Math.max(0, (pt.t_s / dur) * 100)).toFixed(2)}%`;
      return b;
    }));
    ticks.hidden = false;
    wireSeek(ticks);
  };
  // 播完：提示下一講，不自動播
  const endNote = h('div', { class: 'note end-note', hidden: true }, '這一講播完了。',
    next ? h('a', { class: 'btn primary', href: '#/lesson/' + next.id }, `下一講：${next.order ? next.order + '　' : ''}${next.lesson_title || next.title}`) : h('span', null, '這是最後一講。'));
  media.append(ticks, endNote);
  // 講次目錄：同一門課的全部講次，目前這一講標出來（多梯次依系列分組）
  const toc = h('details', { class: 'aux lesson-toc' }, h('summary', null, `講次目錄（${i + 1}／${c.lessons.length}）`));
  let tocSeries = null, tocList = null;
  for (const x of c.lessons) {
    if ((x.series || '') !== tocSeries || !tocList) {
      tocSeries = x.series || '';
      if (new Set(c.lessons.map((y) => y.series || '')).size > 1) toc.append(h('div', { class: 'chapter-head' }, tocSeries || '其他'));
      tocList = h('ol', { class: 'toc-list' });
      toc.append(tocList);
    }
    tocList.append(h('li', { class: x.id === l.id ? 'here' : null }, x.id === l.id
      ? h('span', null, `${x.order ? x.order + '　' : ''}${x.lesson_title || x.title}（這一講）`)
      : h('a', { href: '#/lesson/' + x.id }, `${x.order ? x.order + '　' : ''}${x.lesson_title || x.title}`), progressBadge(x)));
  }
  const nav = h('div', { class: 'doc-nav' },
    prev ? h('a', { class: 'btn', href: '#/lesson/' + prev.id, 'aria-label': `上一講 ${prev.order || ''}` }, svgIcon('back'), prev.order || '上一講') : h('span'),
    h('a', { class: 'btn quiet', href: '#/course/' + encodeURIComponent(c.id) }, '講次目錄'),
    next ? h('a', { class: 'btn', href: '#/lesson/' + next.id, 'aria-label': `下一講 ${next.order || ''}` }, next.order || '下一講', svgIcon('chev')) : h('span'));
  const head = areaColor(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/course/' + encodeURIComponent(c.id) }, c.title)),
    h('h1', null, l.lesson_title || l.title)), null, c.category);
  // iPad 等寬螢幕：左欄播放（固定不捲走）、右欄逐字稿與其他分頁；iPhone 照常單欄（CSS 決定）
  // iPhone：播放區（影片、控制列、重點刻度）釘在頂列下方，頁籤列黏在播放區下方，逐字稿在底下捲動（learn 手機版的做法）
  const left = h('div', { class: 'lesson-left' }, media);
  const tabsEl = tabBar(tabs, cur, show);
  const layout = h('div', { class: 'lesson-layout' + (playable ? ' has-player' : '') }, left, h('div', { class: 'lesson-right' }, tabsEl, pane));
  setView(head, h('p', { class: 'page-sub' }, [l.order, l.series, l.date].filter(Boolean).join('・')), layout, back, toc, nav);
  const topBar = document.querySelector('.bar');
  const measure = () => {
    layout.style.setProperty('--bar-h', `${Math.round(topBar ? topBar.getBoundingClientRect().height : 0)}px`);
    layout.style.setProperty('--left-h', `${Math.round(left.getBoundingClientRect().height)}px`);
  };
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(measure);
    ro.observe(left); if (topBar) ro.observe(topBar);
    sig.addEventListener('abort', () => ro.disconnect());
  }
  measure();
  // 看得到逐字稿的範圍：頂列（或黏住的頁籤列）下緣 → 底部分頁列上緣
  const visTop = () => Math.max(topBar ? topBar.getBoundingClientRect().bottom : 0, tabsEl.getBoundingClientRect().bottom);
  const visBottom = () => { const t = document.querySelector('.tabs'); return t ? t.getBoundingClientRect().top : window.innerHeight; };
  const scrollToSeg = (n, smooth) => {
    const r = n.getBoundingClientRect(), top = visTop(), bot = visBottom();
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top - top - Math.max(0, (bot - top - r.height) / 3)), behavior: smooth ? 'smooth' : 'auto' });
  };
  document.body.classList.add('wide-page');
  sig.addEventListener('abort', () => document.body.classList.remove('wide-page'));
  await show(cur);
  if (startT) {
    const segs = [...pane.querySelectorAll('.seg[data-t]')];
    let target = null;
    for (const n of segs) { if (Number(n.dataset.t) <= startT) target = n; else break; }
    if (target) { target.classList.add('flash'); requestAnimationFrame(() => scrollToSeg(target)); }
  }

  // 播放畫面：這一講的播放器已經在跑（例如從底部小播放器點回來）就借進來；之後才開的，開好會自己借進來
  PLAYER_SLOT = key ? { name: key, alt: altKeys, el: slot } : null;
  sig.addEventListener('abort', () => { if (PLAYER_SLOT && PLAYER_SLOT.el === slot) PLAYER_SLOT = null; });
  if (mine()) playerAdopt(slot);
  else if (startT && (offE || (s.enabled && gHasToken()))) startAt(startT);   // 從摘要或深連結帶 ?t= 進來：直接開到那一秒

  // 點時間戳：這一講正在播就跳過去；還沒開就從那一秒開始
  function wireSeek(root) {
    root.querySelectorAll('[data-seek]').forEach((b) => {
      b.disabled = !playable;
      b.addEventListener('click', () => {
        const t = Number(b.dataset.seek);
        if (mine()) { const el = playerEl(); el.currentTime = t; el.play().catch(() => {}); } else startAt(t);
      });
    });
  }
  // 逐字稿跟著播放高亮；手動捲動後 8 秒不搶回；目前那段不在畫面上時出現「回到 hh:mm:ss」
  let userScrollUntil = 0, active = null;
  // 點播放區與頁籤列（收起影片、換速度、切頁籤）不算手動捲動，跟隨不暫停
  const markManual = (e) => { if (e && e.target && e.target.closest && e.target.closest('.lesson-left, .seg-tabs, .bar')) return; userScrollUntil = performance.now() + 8000; };
  window.addEventListener('touchstart', markManual, { passive: true, signal: sig });
  window.addEventListener('wheel', markManual, { passive: true, signal: sig });
  back.addEventListener('click', () => { userScrollUntil = 0; const n = pane.querySelector('.seg.active'); if (n) scrollToSeg(n, true); back.hidden = true; });
  const tick = setInterval(() => {
    playBtn.hidden = mine();
    fold.hidden = !mine() || PLAYER.mode === 'audio';
    srcRow.hidden = !alt || mine();
    if (!mine()) { back.hidden = true; return; }
    const el = playerEl();
    if (Number.isFinite(el.duration)) drawTicks(el.duration);
    endNote.hidden = !el.ended;
    const now = el.currentTime;
    const segs = [...pane.querySelectorAll('.seg[data-t]')];
    let found = null;
    for (const n of segs) { if (Number(n.dataset.t) <= now) found = n; else break; }
    if (found !== active) {
      pane.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
      if (found) { found.classList.add('active'); if (followBox.checked && performance.now() >= userScrollUntil && !el.paused) scrollToSeg(found, true); }
      active = found;
    }
    const items = [...pane.querySelectorAll('.summary-items li[data-t]')];
    let fi = null;
    for (const it of items) if (Number(it.dataset.t) <= now) fi = it;
    items.forEach((it) => it.classList.toggle('active', it === fi));
    if (active && !el.paused) {
      const box = active.getBoundingClientRect();
      const off = box.bottom < visTop() || box.top > visBottom();
      back.hidden = !off;
      if (off) back.textContent = `回到 ${clock(Number(active.dataset.t))}`;
    } else back.hidden = true;
  }, 500);
  sig.addEventListener('abort', () => clearInterval(tick));
}
/* ── 書籤（照資料契約 bookmarks：鍵＝uid；刪除寫成刪除標記，同步時別台裝置才不會把它帶回來） ── */
function bookmarksOf(lessonId) {
  return Object.entries(LREC.bookmarks).filter(([, b]) => !b.deleted && b.lesson_id === lessonId)
    .map(([uid, b]) => ({ uid, ...b })).sort((a, b) => a.t_s - b.t_s);
}
function bookmarkPut(uid, b) { LREC.bookmarks[uid] = { ...b, at: new Date().toISOString() }; lrecSave(); }
// 「複製成筆記格式」：@講次 hh:mm:ss 一句話——本人 Notion 課程筆記已在用的錨點格式（learn 同一套）
function bookmarkLine(l, b) {
  const text = (b.text || '').replace(/\s+/g, ' ').trim();
  const time = clock(Math.floor(b.t_s));
  if (l.order) return `@${l.order} ${time}${text ? ' ' + text : ''}`;
  return `${time}${text ? ' ' + text : ''}（${l.lesson_title || l.title}${l.date ? '，' + l.date : ''}）`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const area = h('textarea', { readonly: true });
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const ok = document.execCommand && document.execCommand('copy');
    area.remove();
    return !!ok;
  }
}

/* ── 課程內搜尋（learn 的規則：全部課程最多列 200 處並顯示總數；摘要句排前面；筆記保留名額；
   命中逐字稿就連到那一講的那一秒）。先用 App 的全文索引篩出候選檔，再逐行比對 ── */
const SEARCH_MAX = 200, SEARCH_NOTES_QUOTA = 30;
const STAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] /;
async function courseSearch(q, only) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], total: 0 };
  const { paths } = await search(q);
  const cand = new Set(paths);
  const ci = await courseIndex();
  const has = (line) => { const x = (line || '').toLowerCase(); return terms.every((t) => x.includes(t)); };
  const sum = [], tr = [], notes = [];
  for (const c of only ? [only] : ci.list) {
    for (const l of c.lessons) {
      const p = l.transcript && vp(l.transcript.md);
      if (!p || !cand.has(p)) continue;
      const lines = LearnText.splitlines(await textOf(l.transcript.md) || '');
      const inSum = (n) => l.summary && n >= l.summary.start_line && n <= l.summary.end_line;
      let t = null;
      for (let n = 1; n <= lines.length; n++) {
        const line = lines[n - 1];
        const m = STAMP_RE.exec(line);
        if (m) t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        if (n < (l.transcript.body_start_line || 1) && !inSum(n)) continue;
        if (!has(line)) continue;
        if (inSum(n)) {
          const mt = /\[(\d{2}):(\d{2}):(\d{2})\]/.exec(line);
          sum.push({ kind: '摘要', c, l, t: mt ? (+mt[1]) * 3600 + (+mt[2]) * 60 + (+mt[3]) : null, text: line });
        } else tr.push({ kind: '逐字稿', c, l, t, text: line.replace(STAMP_RE, '') });
      }
    }
    for (const x of [...c.notes.map((y) => [y, '筆記']), ...c.handouts.map((y) => [y, '講義'])]) {
      const p = vp(x[0].md);
      if (!p || !cand.has(p)) continue;
      const d = CAT.byPath.get(p);
      for (const line of LearnText.splitlines(await textOf(x[0].md) || '')) if (has(line)) notes.push({ kind: x[1], c, d, text: line });
    }
  }
  const total = sum.length + tr.length + notes.length;
  const keepNotes = notes.slice(0, Math.min(SEARCH_NOTES_QUOTA, notes.length));
  const hits = [...sum, ...tr].slice(0, SEARCH_MAX - keepNotes.length).concat(keepNotes);
  return { hits, total, terms };
}
function markTerms(text, terms) {
  const out = h('span', { class: 'snip' });
  const low = text.toLowerCase();
  let i = 0;
  const cut = text.length > 140 ? Math.max(0, low.indexOf(terms[0]) - 40) : 0;
  if (cut) { out.append('…'); i = cut; }
  const end = Math.min(text.length, i + 160);
  while (i < end) {
    let best = -1, len = 0;
    for (const t of terms) { const k = low.indexOf(t, i); if (k >= 0 && k < end && (best < 0 || k < best)) { best = k; len = t.length; } }
    if (best < 0) { out.append(text.slice(i, end)); break; }
    out.append(text.slice(i, best), h('mark', null, text.slice(best, best + len)));
    i = best + len;
  }
  if (end < text.length) out.append('…');
  return out;
}
function courseSearchBox(only) {
  const input = h('input', { type: 'search', class: 'csearch', enterkeyhint: 'search', placeholder: only ? '搜尋這門課（逐字稿、摘要、講義、筆記）' : '搜尋全部課程', 'aria-label': '搜尋課程' });
  const out = h('div', { class: 'csearch-out' });
  const go = async () => {
    const q = input.value.trim();
    if (!q) { out.replaceChildren(); return; }
    out.replaceChildren(h('p', { class: 'muted' }, '搜尋中…'));
    const { hits, total, terms } = await courseSearch(q, only);
    if (!total) { out.replaceChildren(h('p', { class: 'muted' }, `找不到「${q}」。`)); return; }
    out.replaceChildren(h('p', { class: 'muted' }, total > hits.length ? `共 ${total} 處，列出前 ${hits.length} 處（摘要在前、筆記保留名額）。` : `共 ${total} 處。`),
      listOf(hits.map((x) => {
        const href = x.l ? `#/lesson/${x.l.id}?t=${x.t || 0}${x.kind === '摘要' ? '&tab=summary' : ''}` : pageHref(x.d.p);
        const where = x.l ? `${x.l.order ? x.l.order + '　' : ''}${x.l.lesson_title || x.l.title}` : docTitle(x.d);
        return h('li', null, h('a', { class: 'item', href }, h('span', { class: 't' }, where),
          h('span', { class: 'm' }, [x.kind, x.t != null ? clock(x.t) : null, only ? null : x.c.title].filter(Boolean).join('・')), markTerms(x.text, terms)));
      })));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); go(); } });
  input.addEventListener('search', go);
  return h('div', { class: 'csearch-box' }, input, out);
}

// LearnText.renderMarkdown 回傳字串；renderTranscript 回傳 {html}
function asHtml(x) { return typeof x === 'string' ? x : (x && x.html) || ''; }

// 用 media.key 到雲端硬碟找檔，開播放器（帶 meta 才會記進度）
async function openLessonMedia(l, meta, t, isAudio, note, name = l.media.key) {
  if (!gHasToken() || gMinutesLeft() < RENEW_BEFORE_MIN) {
    return gLogin({ returnHash: location.hash, resume: null }).catch((e) => { note.textContent = e.message; });
  }
  note.textContent = '在雲端硬碟找檔…';
  try {
    const found = await driveFind(name, { validate: true });
    if (!found) { note.textContent = `雲端硬碟上找不到「${name}」。`; return; }
    const go = async (f) => {
      note.textContent = '';
      await playerOpen(f, { t, mode: isAudio ? 'audio' : undefined, meta });
      const el = playerEl();
      if (el) el.play().catch(() => {});
    };
    if (found.choices) { note.textContent = ''; return driveChooser(found, note, go); }
    await go(found);
  } catch (e) { note.textContent = e.status === 401 ? 'Google 登入已過期，請重新登入。' : '找檔失敗：' + e.message; }
}
const handoutView = () => { try { return localStorage.getItem('om-handout-view') || 'pdf'; } catch (e) { return 'pdf'; } };
// 講義原檔：從雲端硬碟讀進來，用 pdf.js 直接顯示在講義裡（iPhone 頁面內嵌只顯示第一頁）；另給「開新視窗」
async function openDrivePdf(name, row, box, btn) {   // 回傳 true＝原檔顯示出來了
  if (btn) btn.disabled = true;
  box.replaceChildren(h('p', { class: 'muted' }, '從雲端硬碟讀取…'));
  try {
    const f = await driveFind(name, { validate: true });
    if (!f) { box.replaceChildren(h('p', { class: 'muted' }, '雲端硬碟上找不到這份 PDF，下面是文字版。')); return false; }
    if (f.choices) { return new Promise((res) => driveChooser(f, box, () => openDrivePdf(name, row, box, btn).then(res))); }
    const blob = new Blob([await (await driveRead(f.id)).blob()], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    row.append(h('a', { class: 'btn quiet', href: url, target: '_blank', rel: 'noopener' }, '開新視窗'));
    await pdfInto(box, blob);
    return true;
  } catch (e) { box.replaceChildren(h('p', { class: 'note' }, (e.status === 401 ? 'Google 登入已過期，請重新登入；' : '原檔讀取失敗（' + e.message + '）；') + '下面是文字版。')); return false; }
}
// wiki 概念頁：列出課程裡引用這一頁的地方（learn 匯出的 by_page），點了開那一講那一秒
async function conceptLessonRefs(d) {
  if (!d.p.startsWith('vault/wiki/')) return null;
  const ex = await learnExport().catch(() => null);
  const refs = ex && ex.concepts && ex.concepts.by_page ? ex.concepts.by_page[d.p.slice(6)] : null;
  if (!refs || !refs.length) return null;
  const ci = await courseIndex();
  const items = refs.map((r) => ({ r, x: ci && ci.lessonById.get(r.lesson_id) })).filter((y) => y.x);
  if (!items.length) return null;
  return h('details', { class: 'aux' }, h('summary', null, `課程裡提到這個概念的地方（${items.length}）`),
    listOf(items.map(({ r, x }) => h('li', null, h('a', { class: 'item', href: `#/lesson/${x.lesson.id}?t=${r.t_s || 0}` },
      h('span', { class: 't' }, `${x.lesson.order ? x.lesson.order + '　' : ''}${x.lesson.lesson_title || x.lesson.title}`),
      h('span', { class: 'm' }, `${x.course.title}${r.t_s != null ? '・' + clock(r.t_s) : ''}`))))));
}
// 文章頁上的逐字稿：給一個「講次頁」按鈕（課程索引已載入時）
function lessonLinkFor(p) {
  if (!COURSES) return null;
  for (const [id, x] of COURSES.lessonById) if (x.lesson.transcript && vp(x.lesson.transcript.md) === p) return '#/lesson/' + id;
  return null;
}
