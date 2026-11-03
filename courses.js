// OM Reader——課程層（P2a）：課程清單、課程頁（講次｜整門課摘要｜講義｜筆記）、講次頁（播放、逐字稿、AI 摘要、講義、筆記）、
// 學習進度與首頁的「繼續上課」。對照 learn 的功能逐項移植（docs/OM-App-整合計畫.md §4，在 learn repo）。
// 資料：課程結構直接讀資料包裡的 vault/self/resources/_courses.json（/sync 產生的課程索引）；
// 逐字稿、摘要、講義、筆記的渲染用 learn 交過來的 vendor/learn-text.js（learn 的正本副本，App 這邊不改它）。
// 進度先記在這支手機（加密），格式照 OM App ↔ learn 資料契約的 progress／recent（P4 寫進雲端硬碟的紀錄檔時直接沿用）。
'use strict';

const COURSE_INDEX = 'vault/self/resources/_courses.json';
let COURSES = null;   // { list, byId, lessonById }
let LREC = null;      // { progress: { media.key: {t_s, duration_s, completed, at} }, recent: { lesson_id: {course_id, at} } }
LOCK_HOOKS.push(() => { COURSES = null; LREC = null; });

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
  LREC = { progress: o.progress || {}, recent: o.recent || {}, bookmarks: o.bookmarks || {} };
  return LREC;
}
let lrecTimer = null;
function lrecSave() {
  clearTimeout(lrecTimer);
  lrecTimer = setTimeout(async () => { if (KEY && LREC) await kvSet('learn-rec', await seal(te.encode(JSON.stringify(LREC)))); }, 400);
}
// learn 的規則：拿到長度、套好起始位置之後才寫；≥99% 或播到結束記看完，看完不取消
function progressSave(meta, el) {
  if (!KEY) return;
  if (!LREC) { lrec().then(() => progressSave(meta, el)).catch(() => {}); return; }
  if (el.readyState < 1 || !Number.isFinite(el.currentTime)) return;
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  const prev = LREC.progress[meta.key] || {};
  const now = new Date().toISOString();
  LREC.progress[meta.key] = {
    t_s: Math.round(el.currentTime * 10) / 10, duration_s: dur ? Math.round(dur) : (prev.duration_s || null),
    completed: !!prev.completed || el.ended || (dur > 0 && el.currentTime / dur >= 0.99), at: now,
  };
  LREC.recent[meta.lessonId] = { course_id: meta.courseId, at: now };
  lrecSave();
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
  return [secTitle('繼續上課'), listOf(rows.map(({ lesson: l, course: c }) => {
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
  const byCat = new Map();
  for (const c of ci.list) { const k = c.category || '其他'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(c); }
  const inCourse = new Set(ci.list.flatMap((c) => [...c.lessons.map((l) => vp(l.transcript && l.transcript.md)), ...c.handouts.map((x) => vp(x.md)), ...c.notes.map((x) => vp(x.md))]));
  const loose = cat.docs.filter((d) => d.l === lane && d.s != null && !inCourse.has(d.p) && !isAux(d));
  const total = ci.list.reduce((n, c) => n + c.lessons.length, 0);
  const kids = [h('div', { class: 'doc-head' }, h('h1', null, laneName(lane))),
    h('p', { class: 'page-sub' }, `${laneLabel(lane) ? laneLabel(lane) + '・' : ''}${ci.list.length} 門課・${total} 講・依課程`)];
  for (const [k, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
    kids.push(h('div', { class: 'sec-title' }, h('span', null, areaColor(h('span', { class: 'sec-dot' }), null, k), k)),
      listOf(list.map((c) => {
        const done = c.lessons.filter((l) => (lessonProgress(l) || {}).completed).length;
        return h('li', null, areaColor(h('a', { class: 'item', href: '#/course/' + encodeURIComponent(c.id) }, h('span', { class: 't' }, c.title),
          h('span', { class: 'm' }, `${c.lessons.length} 講${done ? `・已看完 ${done}` : ''}${c.handouts.length ? `・講義 ${c.handouts.length}` : ''}${c.notes.length ? `・我的筆記 ${c.notes.length}` : ''}`)), null, c.category));
      })));
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
  const head = areaColor(h('div', { class: 'doc-head' }, h('nav', { class: 'crumb' }, h('a', { href: '#/l/' + enc('self/resources') }, 'self/resources・課程')),
    h('h1', null, c.title)), null, c.category);
  const sub = h('p', { class: 'page-sub' }, `${c.lessons.length} 講・已看完 ${done}／${c.lessons.length}`);
  const tabs = [['lessons', '講次'], ['digest', '整門課摘要']];
  if (c.handouts.length) tabs.push(['handouts', `講義（${c.handouts.length}）`]);
  if (c.notes.length) tabs.push(['notes', `我的筆記（${c.notes.length}）`]);
  const pane = h('div', { class: 'tab-pane' });
  const show = async (k) => {
    setQs('tab', k === 'lessons' ? null : k);
    pane.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
    if (k === 'lessons') pane.replaceChildren(courseLessons(c));
    else if (k === 'digest') pane.replaceChildren(await courseDigest(c));
    else if (k === 'handouts') pane.replaceChildren(listOf(c.handouts.map((x) => cat.byPath.get(vp(x.md))).filter(Boolean).map((d) => itemLink(d))));
    else if (k === 'notes') pane.replaceChildren(listOf(c.notes.map((x) => cat.byPath.get(vp(x.md))).filter(Boolean).map((d) => itemLink(d))));
  };
  let cur = qsTab(qs, 'lessons');
  if (!tabs.some((t) => t[0] === cur)) cur = 'lessons';
  setView(head, h('div', { class: 'chips' }, c.category ? areaChip(c.category) : null), sub, tabBar(tabs, cur, show), pane);
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
function summarySection(sec, timeEl, { termChips = false } = {}) {
  if (sec.name === '主旨') return h('p', { class: 'summary-gist' }, sec.text);
  const box = h('section', { class: 'summary-section ' + (SECTION_CLASS[sec.name] || 'other') }, h('h4', null, sec.name));
  if (sec.text) box.append(h('p', null, sec.text));
  if (sec.items.length) {
    if (termChips && sec.name === '名詞') {
      box.append(h('div', { class: 'chips' }, sec.items.map((it) => {
        const cut = it.text.search(/[：:]/);
        return h('span', { class: 'tag', title: it.text }, cut > 0 ? it.text.slice(0, cut) : it.text);
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
  const mediaNote = h('p', { class: 'status', role: 'status' });
  const playBtn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('play'), prog && !prog.completed && prog.t_s > 5 ? `從 ${clock(prog.t_s)} 繼續` : '播放');
  const startAt = (t) => openLessonMedia(l, meta, t, isAudio, mediaNote);
  playBtn.addEventListener('click', () => startAt(startT || (prog && !prog.completed ? prog.t_s : 0)));
  const rateRow = h('div', { class: 'rate-row', role: 'group', 'aria-label': '播放速度' },
    RATES.map((r) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(r === playerRate()), 'data-rate': r,
      onclick: (e) => { playerSetRate(r); rateRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, r + '×')));
  const followBox = h('input', { type: 'checkbox', id: 'follow' });
  followBox.checked = (() => { try { return localStorage.getItem('om-follow') !== '0'; } catch (e) { return true; } })();
  followBox.addEventListener('change', () => { try { localStorage.setItem('om-follow', followBox.checked ? '1' : '0'); } catch (e) { /* 略過 */ } });
  const s = await gSettings();
  const media = h('section', { class: 'lesson-media' }, slot, mediaNote);
  if (!key) mediaNote.textContent = '這一講沒有影音檔。';
  else if (!s.enabled) mediaNote.append('影音在雲端硬碟。到「同步」頁啟用「雲端硬碟影音」後，就能在這裡播放。');
  else media.append(h('div', { class: 'row' }, mine() ? null : playBtn), rateRow, h('label', { class: 'check', for: 'follow' }, followBox, '逐字稿跟隨播放'));

  // 分頁：逐字稿｜摘要｜講義｜我的筆記
  const text = l.transcript ? await textOf(l.transcript.md) : null;
  const summary = text && l.summary ? LearnText.summaryOf(text, l.summary) : null;
  const handouts = (l.handout_ids || []).map((hid) => c.handouts.find((x) => x.id === hid)).filter(Boolean);
  const tabs = [['transcript', '逐字稿'], ['summary', '摘要']];
  if (handouts.length) tabs.push(['handouts', `講義（${handouts.length}）`]);
  if (c.notes.length) tabs.push(['notes', '我的筆記']);
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
  panes.handouts = async () => {
    const box = h('div');
    for (const x of handouts) {
      const t = await textOf(x.md);
      const d = CAT.byPath.get(vp(x.md));
      const row = h('div', { class: 'row' }, d ? h('a', { class: 'btn quiet', href: pageHref(d.p) }, '單獨開啟') : null);
      if (x.pdf_key && s.enabled) row.append(h('button', { type: 'button', class: 'btn', onclick: () => openDrivePdf(x.pdf_key, row) }, svgIcon('external'), '原檔 PDF'));
      box.append(h('section', { class: 'handout' }, h('h3', null, x.handout_title || x.title), row,
        t ? learnHtml(asHtml(LearnText.renderMarkdown(t, x.body_start_line || 1))) : h('p', { class: 'muted' }, '講義文字還沒同步。')));
    }
    return box;
  };
  panes.notes = async () => {
    const box = h('div');
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
        const input = h('input', { type: 'text', class: 'bookmark-text', placeholder: '寫一句話（可留白）', 'aria-label': '書籤內容' });
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
  setView(head, h('p', { class: 'page-sub' }, [l.order, l.series, l.date].filter(Boolean).join('・')), media,
    tabBar(tabs, cur, show), pane, back, toc, nav);
  await show(cur);

  // 播放畫面：這一講的播放器已經在跑（例如從底部小播放器點回來）就借進來；之後才開的，開好會自己借進來
  PLAYER_SLOT = key ? { name: key, el: slot } : null;
  sig.addEventListener('abort', () => { if (PLAYER_SLOT && PLAYER_SLOT.el === slot) PLAYER_SLOT = null; });
  if (mine()) playerAdopt(slot);
  else if (startT && s.enabled && gHasToken()) startAt(startT);   // 從摘要或深連結帶 ?t= 進來：直接開到那一秒

  // 點時間戳：這一講正在播就跳過去；還沒開就從那一秒開始
  function wireSeek(root) {
    root.querySelectorAll('[data-seek]').forEach((b) => {
      b.disabled = !(key && s.enabled);
      b.addEventListener('click', () => {
        const t = Number(b.dataset.seek);
        if (mine()) { const el = playerEl(); el.currentTime = t; el.play().catch(() => {}); } else startAt(t);
      });
    });
  }
  // 逐字稿跟著播放高亮；手動捲動後 8 秒不搶回；目前那段不在畫面上時出現「回到 hh:mm:ss」
  let userScrollUntil = 0, active = null;
  const markManual = () => { userScrollUntil = performance.now() + 8000; };
  window.addEventListener('touchstart', markManual, { passive: true, signal: sig });
  window.addEventListener('wheel', markManual, { passive: true, signal: sig });
  back.addEventListener('click', () => { userScrollUntil = 0; const n = pane.querySelector('.seg.active'); if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' }); back.hidden = true; });
  const tick = setInterval(() => {
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
      if (found) { found.classList.add('active'); if (followBox.checked && performance.now() >= userScrollUntil && !el.paused) found.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      active = found;
    }
    const items = [...pane.querySelectorAll('.summary-items li[data-t]')];
    let fi = null;
    for (const it of items) if (Number(it.dataset.t) <= now) fi = it;
    items.forEach((it) => it.classList.toggle('active', it === fi));
    if (active && !el.paused) {
      const box = active.getBoundingClientRect();
      const off = box.bottom < 0 || box.top > window.innerHeight;
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

// LearnText.renderMarkdown 回傳字串；renderTranscript 回傳 {html}
function asHtml(x) { return typeof x === 'string' ? x : (x && x.html) || ''; }

// 用 media.key 到雲端硬碟找檔，開播放器（帶 meta 才會記進度）
async function openLessonMedia(l, meta, t, isAudio, note) {
  if (!gHasToken() || gMinutesLeft() < RENEW_BEFORE_MIN) {
    return gLogin({ returnHash: location.hash, resume: null }).catch((e) => { note.textContent = e.message; });
  }
  note.textContent = '在雲端硬碟找檔…';
  try {
    const f = await driveFind(l.media.key);
    if (!f) { note.textContent = `雲端硬碟上找不到「${l.media.key}」。`; return; }
    note.textContent = f.n > 1 ? `雲端硬碟上同名的有 ${f.n} 個，先用第一個。` : '';
    await playerOpen(f, { t, mode: isAudio ? 'audio' : undefined, meta });
    const el = playerEl();
    if (el) el.play().catch(() => {});
  } catch (e) { note.textContent = e.status === 401 ? 'Google 登入已過期，請重新登入。' : '找檔失敗：' + e.message; }
}
// 講義原檔：從雲端硬碟讀進來，開新視窗看（頁面內嵌只顯示第一頁；App 內顯示留給 P2b 的 pdf.js）
async function openDrivePdf(name, row) {
  const w = window.open('', '_blank');
  try {
    const f = await driveFind(name);
    if (!f) { if (w) w.close(); row.append(h('span', { class: 'muted' }, '雲端硬碟上找不到這份 PDF。')); return; }
    const blob = await (await driveRead(f.id)).blob();
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    if (w) w.location.href = url; else window.open(url, '_blank');
  } catch (e) { if (w) w.close(); row.append(h('span', { class: 'muted' }, '讀取失敗：' + e.message)); }
}
// 文章頁上的逐字稿：給一個「講次頁」按鈕（課程索引已載入時）
function lessonLinkFor(p) {
  if (!COURSES) return null;
  for (const [id, x] of COURSES.lessonById) if (x.lesson.transcript && vp(x.lesson.transcript.md) === p) return '#/lesson/' + id;
  return null;
}
