// OM Reader——外殼：設定與同步頁、開啟鎖畫面、路由、頂列與明暗，最後啟動。
'use strict';

async function wipeAll() {
  lockNow();
  const d = await db(); d.close(); dbp = null;
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = res; });
}

async function viewSettings() {
  const cfg = await getConfig();
  const repo = h('input', { id: 'cfg-repo', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'owner/repo', value: cfg.repo || '' });
  const token = h('input', { id: 'cfg-token', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: cfg.token ? '（已存，留空表示不變）' : 'github_pat_…' });
  const out = h('p', { class: 'status', role: 'status' });
  const quota = h('p', { class: 'muted quota', hidden: true });
  const showQuota = (rate) => {
    if (!rate || rate.remaining == null) return;
    quota.hidden = false;
    quota.textContent = `GitHub 額度：這一小時還剩 ${Number(rate.remaining).toLocaleString()} 次` +
      (rate.reset ? `，${new Date(rate.reset * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 重置` : '') + '（所有 token 共用）';
  };
  const prog = h('progress', { max: '100', value: '0', hidden: true });
  const checkBtn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('sync'), '檢查更新');
  const choice = h('div', { class: 'row', hidden: true });
  const info = h('dl', { class: 'kv' });
  const fillInfo = async () => {
    info.replaceChildren();
    const s = (await kvGet('state')) || {};
    const add = (k, v) => info.append(h('dt', null, k), h('dd', null, v));
    add('上次同步', s.syncedAt ? new Date(s.syncedAt).toLocaleString('zh-TW') : '尚未');
    add('資料版本', s.commit ? s.commit.slice(0, 7) : '—');
    if (s.pendingMedia) add('尚未下載', `${s.pendingMedia} 個圖片與附件`);
    if (navigator.storage && navigator.storage.estimate) {
      try { const e = await navigator.storage.estimate(); add('手機已用', `${fmtMB(e.usage || 0)}／配額 ${fmtMB(e.quota || 0)}`); } catch (e) { /* 略過 */ }
    }
    if (navigator.storage && navigator.storage.persisted) {
      try { add('持久儲存', (await navigator.storage.persisted()) ? '是' : '否'); } catch (e) { /* 略過 */ }
    }
  };
  const doSync = async (plan, textOnly) => {
    choice.hidden = true; checkBtn.disabled = true; prog.hidden = false;
    try {
      const res = await runSync(plan, { textOnly }, (p) => {
        prog.max = Math.max(1, p.totalBytes); prog.value = p.doneBytes;
        out.textContent = `下載中 ${p.doneFiles}／${p.totalFiles}（${fmtMB(p.doneBytes)}／${fmtMB(p.totalBytes)}）${p.failed ? `，失敗 ${p.failed}` : ''}`;
        showQuota(p.rate);
      });
      showQuota(res.rate);
      if (res.complete) updateInfo = null;
      if (res.busy) out.textContent = '已在同步中。';
      else if (res.complete) out.textContent = `同步完成：下載 ${res.downloaded} ${plan.packed ? '包' : '個檔'}，清掉 ${res.removed} 筆舊資料。${textOnly ? '圖片與附件留到下次。' : ''}`;
      else if (res.stopErr && res.stopErr.rateLimited) out.textContent = `GitHub 每小時額度用完，已下載的都保留了。${res.rate && res.rate.reset ? new Date(res.rate.reset * 1000).toLocaleTimeString('zh-TW') + ' 後' : '稍後'}再同步會接著下載。`;
      else if (res.stopErr) out.textContent = `同步中止：${res.stopErr.message}`;
      else out.textContent = `同步未完成：${res.failed} 個檔下載失敗，再同步一次會補抓。`;
    } catch (e) {
      out.textContent = '同步失敗：' + (e.message || e);
    } finally {
      checkBtn.disabled = false; checkBtn.className = 'btn primary'; prog.hidden = true; fillInfo();
    }
  };
  checkBtn.addEventListener('click', async () => {
    const r = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const tk = token.value.trim() || cfg.token;
    if (!(r === 'local' || /^[\w.-]+\/[\w.-]+$/.test(r)) || (!tk && r !== 'local')) { out.textContent = '請填 repo（擁有者/名稱）與 token。'; return; }
    await setConfig(r, tk);
    token.value = '';
    checkBtn.disabled = true; choice.hidden = true;
    out.textContent = '比對檔案清單…';
    try {
      const plan = await planSync();
      showQuota(plan.rate);
      const total = plan.textBytes + plan.mediaBytes;
      if (!plan.want.length && !plan.stale.length) { out.textContent = '已是最新，沒有要下載的。'; return; }
      out.textContent = `這次要下載 ${plan.want.length} ${plan.packed ? '包' : '個檔'}、共 ${fmtMB(total)}（約 ${plan.requests} 次請求）：文字與索引 ${fmtMB(plan.textBytes)}，圖片與附件 ${fmtMB(plan.mediaBytes)}。`;
      checkBtn.className = 'btn';
      choice.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => doSync(plan, false) }, `全部下載（${fmtMB(total)}）`));
      if (plan.mediaFiles) choice.append(h('button', { type: 'button', class: 'btn', onclick: () => doSync(plan, true) }, `只下載文字（${fmtMB(plan.textBytes)}）`));
      choice.hidden = false;
    } catch (e) {
      out.textContent = e.status === 401 ? 'token 無效或已過期，請貼上新的 token。' : e.status === 404 ? '找不到 repo：名稱錯誤或 token 沒授權。' : '檢查失敗：' + (e.message || e);
    } finally { checkBtn.disabled = false; }
  });
  const lockBtn = h('button', { type: 'button', class: 'btn', onclick: () => { lockNow(); route(); } }, svgIcon('lock'), '立刻上鎖');
  const clearBtn = h('button', { type: 'button', class: 'btn quiet danger' }, '刪除手機上的全部資料');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('刪除這支手機上的全部資料、token 與開啟鎖設定？（資料 repo 不受影響，之後可以重新同步）')) return;
    await wipeAll();
    location.hash = '#/';
    route();
  });
  setView(h('h1', null, '同步與設定'),
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('label', { for: 'cfg-repo' }, '資料 repo（擁有者/名稱）'), repo),
      h('div', { class: 'field' }, h('label', { for: 'cfg-token' }, '唯讀 token'), token),
      h('div', { class: 'row' }, checkBtn), out, choice, prog, quota),
    secTitle('這支手機'), h('div', { class: 'card' }, info),
    h('p', { class: 'muted' }, '只下載有變動的檔。repo 名稱與 token 只存在這支手機，token 與所有資料都以 Face ID 導出的金鑰加密。token 到期後在這裡貼上新的即可。'),
    h('div', { class: 'row' }, lockBtn, clearBtn));
  fillInfo();
}

function lockScreen(title, text, btnLabel, action, extra) {
  const out = h('p', { class: 'status', role: 'status' });
  const btn = h('button', { type: 'button', class: 'btn primary' }, svgIcon('lock'), btnLabel);
  btn.addEventListener('click', async () => {
    btn.disabled = true; out.textContent = '';
    try { await action(); route(); }
    catch (e) { out.textContent = '沒有成功：' + (e.name === 'NotAllowedError' ? '取消了，或逾時' : (e.message || e)); btn.disabled = false; }
  });
  setView(h('div', { class: 'lock' }, h('img', { src: 'icons/icon-192.png', alt: '' }), h('h1', null, title),
    text ? h('p', { class: 'muted' }, text) : null, btn, out, extra || null));
  btn.focus();
}
async function viewSetupLock() {
  lockScreen('先設定開啟鎖', '手機上的資料會用 Face ID 導出的金鑰加密，沒有你的臉就讀不到。接下來 iOS 會問你要不要把「OM Reader」的通行金鑰存進「密碼」，請同意。',
    '用 Face ID 建立開啟鎖', async () => { await setupLock(); location.hash = '#/settings'; });
}
async function viewLock() {
  const reset = h('button', { type: 'button', class: 'btn quiet' }, '解不開？重設這支手機');
  reset.addEventListener('click', async () => {
    if (!confirm('找不到通行金鑰或一直解不開時才用：刪除這支手機上的全部資料，重新設定開啟鎖、重新同步。資料 repo 不受影響。')) return;
    await wipeAll(); route();
  });
  lockScreen('OM Reader', null, '用 Face ID 解鎖', unlock, reset);
}

/* ════════ 路由 ════════ */
async function route() {
  const hash = location.hash || '#/';
  try {
    if (!window.PublicKeyCredential || !window.crypto || !crypto.subtle) {
      return setView(h('h1', null, '這個瀏覽器不支援'), h('p', null, '需要通行金鑰與 Web Crypto（iOS 18 的 Safari／主畫面 App 都有）。'));
    }
    const hasLock = !!(await kvGet('lock'));
    const locked = !hasLock || !KEY;
    document.body.classList.toggle('locked', locked);
    updateChrome(hash, locked);
    if (!hasLock) return viewSetupLock();
    if (!KEY) return viewLock();
    if (!hash.startsWith('#/s/')) $('#q').value = '';
    stashView();
    curHash = hash;
    if (restoreView(hash)) return;
    if (hash.startsWith('#/browse')) await viewBrowse();
    else if (hash.startsWith('#/history')) await viewHistory();
    else if (hash.startsWith('#/p/')) await viewPage(dec(hash.slice(4)));
    else if (hash.startsWith('#/l/')) await viewLane(dec(hash.slice(4)));
    else if (hash.startsWith('#/c/')) await viewCourse(+hash.slice(4));
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
// 頂列：深層頁（文章、清單、搜尋）顯示「上一頁」；底部分頁標出目前位置
let navDepth = 0;
window.addEventListener('hashchange', () => { navDepth++; route(); });
function updateChrome(hash, locked) {
  const deep = /^#\/(p|l|s|c)\//.test(hash);
  $('#back').hidden = locked || !deep || navDepth === 0;
  $('#brand').hidden = !$('#back').hidden;
  const tab = hash.startsWith('#/browse') || hash.startsWith('#/l/') || hash.startsWith('#/c/') ? 'browse'
    : hash.startsWith('#/history') ? 'history'
      : hash.startsWith('#/settings') ? 'settings'
        : hash.startsWith('#/p/') || hash.startsWith('#/s/') ? null : 'home';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
$('#back').addEventListener('click', () => { navDepth = Math.max(0, navDepth - 2); history.back(); });
// 回到頂端：捲過一個半畫面才出現
const toTop = h('button', { type: 'button', class: 'btn to-top', 'aria-label': '回到頂端', hidden: true, onclick: () => window.scrollTo(0, 0) }, svgIcon('up'));
document.body.append(toTop);
window.addEventListener('scroll', () => { toTop.hidden = document.body.classList.contains('locked') || window.scrollY < window.innerHeight * 1.5; }, { passive: true });
// 明暗：跟隨系統 → 淺色 → 深色（選擇只存在這台裝置）
const THEMES = [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']];
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  try { if (t === 'auto') localStorage.removeItem('om-reader-theme'); else localStorage.setItem('om-reader-theme', t); } catch (e) { /* 略過 */ }
  const tc = { light: '#f8f6f1', dark: '#16171b' };
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('data-media') || m.getAttribute('media');
    if (!m.getAttribute('data-media')) m.setAttribute('data-media', media);
    if (t === 'auto') { m.setAttribute('media', media); m.content = /dark/.test(media) ? tc.dark : tc.light; }
    else { m.removeAttribute('media'); m.content = tc[t]; }
  });
  const btn = $('#theme');
  btn.querySelector('use').setAttribute('href', '#i-' + (t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', '明暗：' + THEMES.find((x) => x[0] === t)[1]);
}
let themeNow = document.documentElement.getAttribute('data-theme') || 'auto';
applyTheme(themeNow);
$('#theme').addEventListener('click', () => {
  themeNow = THEMES[(THEMES.findIndex((x) => x[0] === themeNow) + 1) % THEMES.length][0];
  applyTheme(themeNow);
});

route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
