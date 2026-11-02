// OM Reader 測試頁（probe）——驗證正式 App 依賴的四個前提，全部在本機執行。
// 不載入任何外部程式；網路只連 api.github.com（CSP 鎖定）。token 只存在本機，結果摘要不含它。
'use strict';

const $ = (id) => document.getElementById(id);
const R = {}; // 測試結果，餵給「結果」摘要
const MB = 1024 * 1024;

function setResult(key, value) { R[key] = value; renderSummary(); }
function ghStatusText(status) {
  return {
    401: 'token 無效或已過期',
    403: '被拒（token 權限不足，或這個網路的請求額度用完）',
    404: '找不到——repo 名稱打錯，或 token 沒授權這個 repo',
  }[status] || '非預期的回應';
}
function fmtMB(bytes) { return (bytes / MB).toFixed(1) + ' MB'; }
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
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 無痕或封鎖時略過 */ } }

// ── 0 環境 ───────────────────────────────────────────────
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function iosVersion() {
  const m = navigator.userAgent.match(/OS (\d+)[._](\d+)(?:[._](\d+))? like Mac OS X/);
  return m ? m.slice(1).filter(Boolean).join('.') : '（非 iOS 或無法辨識）';
}
async function renderEnv() {
  const dl = $('env');
  dl.textContent = '';
  const standalone = isStandalone();
  kv(dl, '開啟方式', standalone ? '主畫面 App' : 'Safari 分頁（請改從主畫面開）');
  kv(dl, 'iOS 版本', iosVersion());
  kv(dl, '安全環境', window.isSecureContext ? '是' : '否');
  let sw = '不支援';
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      sw = reg ? (reg.active ? '已啟用' : '安裝中') : '未註冊';
    } catch (e) { sw = '讀取失敗'; }
  }
  kv(dl, 'Service Worker', sw);
  kv(dl, '儲存 API', navigator.storage && navigator.storage.persist ? '有' : '無');
  kv(dl, '通行金鑰 API', window.PublicKeyCredential ? '有' : '無');
  setResult('env', { standalone, ios: iosVersion(), secure: window.isSecureContext, sw });
}

// ── 1 儲存 ───────────────────────────────────────────────
const DB_NAME = 'om-probe';
const CHUNK = 10 * MB;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}
function reqP(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
// 每塊開頭 8 bytes 寫塊號，其餘用可驗證的樣式填滿（塊號 + 位置）
function makeChunk(buf, index) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x4f4d5052); // 'OMPR'
  dv.setUint32(4, index);
  for (let i = 8; i < u8.length; i += 4096) u8[i] = (index + i / 4096) & 0xff;
}
function checkChunk(buf, index) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength !== CHUNK) return false;
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== 0x4f4d5052 || dv.getUint32(4) !== index) return false;
  for (let i = 8; i < u8.length; i += 4096 * 37) if (u8[i] !== ((index + i / 4096) & 0xff)) return false;
  return true;
}
async function readMeta() {
  try {
    const db = await openDB();
    const tx = db.transaction(['meta', 'chunks'], 'readonly');
    const meta = await reqP(tx.objectStore('meta').get('info'));
    const count = await reqP(tx.objectStore('chunks').count());
    db.close();
    return { meta, count };
  } catch (e) { return { meta: null, count: 0, err: String(e) }; }
}
async function renderStorage() {
  const dl = $('st-info');
  dl.textContent = '';
  let persisted = '不支援';
  if (navigator.storage && navigator.storage.persisted) {
    try { persisted = (await navigator.storage.persisted()) ? '是' : '否'; } catch (e) { persisted = '讀取失敗'; }
  }
  kv(dl, '持久儲存', persisted);
  let est = null;
  if (navigator.storage && navigator.storage.estimate) {
    try { est = await navigator.storage.estimate(); } catch (e) { /* 略過 */ }
  }
  kv(dl, '已用／配額', est ? `${fmtMB(est.usage || 0)}／${fmtMB(est.quota || 0)}` : '無法讀取');
  const { meta, count } = await readMeta();
  if (meta) {
    const days = ((Date.now() - meta.writtenAt) / 86400000).toFixed(1);
    const intact = count === meta.chunks;
    kv(dl, '上次寫入', `${new Date(meta.writtenAt).toLocaleString('zh-TW')}（${days} 天前）`);
    kv(dl, '目前還在', `${count}／${meta.chunks} 塊（${count * 10} MB）${intact ? '' : '——有部分被清掉'}`);
    setResult('storageSurvival', { days: Number(days), chunks: count, expected: meta.chunks, intact });
  } else {
    kv(dl, '測試資料', '尚未寫入');
  }
  setResult('storageInfo', {
    persisted,
    usageMB: est ? Math.round((est.usage || 0) / MB) : null,
    quotaMB: est ? Math.round((est.quota || 0) / MB) : null,
  });
}
async function onPersist() {
  if (!(navigator.storage && navigator.storage.persist)) { $('st-out').textContent = '這個瀏覽器不支援持久儲存 API'; return; }
  try {
    const granted = await navigator.storage.persist();
    $('st-out').textContent = granted ? '系統同意持久儲存' : '系統沒有同意（主畫面 App 通常會同意；Safari 分頁可能拒絕）';
    setResult('persistRequest', granted);
  } catch (e) { $('st-out').textContent = '請求失敗：' + e; setResult('persistRequest', 'error'); }
  renderStorage();
}
async function onWrite() {
  const target = Math.max(10, Math.min(2000, Number($('st-mb').value) || 300));
  const chunks = Math.ceil(target / 10);
  const btn = $('st-write');
  const prog = $('st-prog');
  btn.disabled = true; prog.hidden = false; prog.max = chunks; prog.value = 0;
  const out = $('st-out');
  const t0 = performance.now();
  let written = 0;
  let error = null;
  try {
    await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res; });
    const db = await openDB();
    const buf = new ArrayBuffer(CHUNK);
    for (let i = 0; i < chunks; i++) {
      makeChunk(buf, i);
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(buf, i); // put 當下就做結構化複製，buf 之後可重用
      await txDone(tx);
      written = i + 1;
      prog.value = written;
      out.textContent = `寫入中… ${written * 10}／${chunks * 10} MB`;
    }
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ writtenAt: Date.now(), chunks: written }, 'info');
    await txDone(tx);
    db.close();
  } catch (e) {
    error = (e && e.name) ? `${e.name}: ${e.message}` : String(e);
    try {
      const db = await openDB();
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ writtenAt: Date.now(), chunks: written }, 'info');
      await txDone(tx);
      db.close();
    } catch (e2) { /* 已在報錯 */ }
  }
  const secs = (performance.now() - t0) / 1000;
  const speed = (written * 10 / secs).toFixed(1);
  out.textContent = error
    ? `寫到 ${written * 10} MB 時失敗：${error}`
    : `寫入完成：${written * 10} MB，用時 ${secs.toFixed(1)} 秒（${speed} MB/s）。過幾天再打開這頁，看「目前還在」那一行。`;
  setResult('storageWrite', { targetMB: chunks * 10, writtenMB: written * 10, seconds: Number(secs.toFixed(1)), error });
  btn.disabled = false; prog.hidden = true;
  renderStorage();
}
async function onVerify() {
  const out = $('st-out');
  out.textContent = '驗證中…';
  try {
    const db = await openDB();
    const meta = await reqP(db.transaction('meta').objectStore('meta').get('info'));
    if (!meta) { out.textContent = '還沒有測試資料'; db.close(); return; }
    let good = 0;
    for (let i = 0; i < meta.chunks; i++) {
      const buf = await reqP(db.transaction('chunks').objectStore('chunks').get(i));
      if (buf && checkChunk(buf, i)) good++;
    }
    db.close();
    const ok = good === meta.chunks;
    out.textContent = ok ? `驗證通過：${good} 塊（${good * 10} MB）內容完整` : `驗證失敗：${meta.chunks} 塊中只有 ${good} 塊完整`;
    setResult('storageVerify', { good, expected: meta.chunks, ok });
  } catch (e) { out.textContent = '驗證失敗：' + e; setResult('storageVerify', { error: String(e) }); }
}
async function onClear() {
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = res; r.onerror = res; r.onblocked = res; });
  $('st-out').textContent = '測試資料已清除';
  delete R.storageSurvival;
  renderStorage();
}

// ── 2 GitHub API ─────────────────────────────────────────
const GH_KEY = 'om-probe-gh';
function loadGh() {
  const raw = lsGet(GH_KEY);
  if (!raw) return;
  try {
    const v = JSON.parse(raw);
    $('gh-repo').value = v.repo || '';
    $('gh-token').value = v.token || '';
    $('gh-remember').checked = true;
  } catch (e) { lsDel(GH_KEY); }
}
async function gh(path, token, accept) {
  const headers = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('https://api.github.com' + path, { headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  return res;
}
async function onGhRun() {
  const list = $('gh-out');
  list.textContent = '';
  const repo = $('gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $('gh-token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { step(list, false, '請填 repo（擁有者/名稱）與 token'); return; }
  if ($('gh-remember').checked) lsSet(GH_KEY, JSON.stringify({ repo, token })); else lsDel(GH_KEY);
  const res = {};
  const btn = $('gh-run');
  btn.disabled = true;
  try {
    // a. 不帶 token：私有 repo 應該回 404（連存在與否都不透露）
    let li = step(list, null, '不帶 token 讀取（應該被拒）');
    try {
      const r = await gh('/repos/' + repo, null);
      res.anonStatus = r.status;
      li.remove();
      const anonMsg = r.status === 404 ? '（外人看不到這個 repo，正確）'
        : r.status === 200 ? '——外人讀得到，這個 repo 不是私有的！'
        : `——${ghStatusText(r.status)}，這一項無法判定`;
      step(list, r.status === 404 ? true : r.status === 200 ? false : null, `不帶 token 讀取：HTTP ${r.status}${anonMsg}`);
    } catch (e) {
      res.anonStatus = 'fetch-error';
      li.remove();
      step(list, false, '不帶 token 的請求送不出去（可能是網路或 CORS）：' + e);
    }
    // b. 帶 token 讀 repo 資訊
    li = step(list, null, '帶 token 讀取 repo 資訊');
    let branch = 'main';
    try {
      const r = await gh('/repos/' + repo, token);
      res.repoStatus = r.status;
      res.rateRemaining = r.headers.get('x-ratelimit-remaining');
      res.rateLimit = r.headers.get('x-ratelimit-limit');
      li.remove();
      if (r.ok) {
        const j = await r.json();
        branch = j.default_branch || 'main';
        res.private = j.private;
        res.perms = j.permissions ? Object.keys(j.permissions).filter((k) => j.permissions[k]).join(',') : null;
        step(list, true, `讀到 repo 資訊（private=${j.private}，預設分支 ${branch}）`);
        step(list, res.rateLimit != null, `讀得到額度標頭：剩 ${res.rateRemaining}／${res.rateLimit} 次`);
      } else {
        step(list, false, `HTTP ${r.status}：${ghStatusText(r.status)}`);
      }
    } catch (e) {
      res.repoStatus = 'fetch-error';
      li.remove();
      step(list, false, '帶 token 的請求被擋（CORS 預檢或網路）：' + e);
    }
    // c. 檔案樹（正式 App 同步時用它比對差異）
    if (res.repoStatus === 200) {
      li = step(list, null, '讀取檔案樹');
      try {
        const t0 = performance.now();
        const r = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
        res.treeStatus = r.status;
        li.remove();
        if (r.ok) {
          const j = await r.json();
          res.treeEntries = (j.tree || []).length;
          res.treeMs = Math.round(performance.now() - t0);
          step(list, true, `檔案樹 ${res.treeEntries} 筆，用時 ${res.treeMs} ms`);
        } else if (r.status === 409) {
          step(list, false, 'repo 是空的（還沒有任何 commit）——建 repo 時要勾 Add a README');
        } else {
          step(list, false, `檔案樹 HTTP ${r.status}`);
        }
      } catch (e) { res.treeStatus = 'fetch-error'; li.remove(); step(list, false, '讀檔案樹失敗：' + e); }
      // d. 單檔原始內容（正式 App 下載資料包分片用）
      li = step(list, null, '讀取 README 原始內容');
      try {
        const r = await gh(`/repos/${repo}/readme`, token, 'application/vnd.github.raw+json');
        res.readmeStatus = r.status;
        li.remove();
        if (r.ok) {
          const txt = await r.text();
          res.readmeBytes = txt.length;
          step(list, true, `讀到 README（${txt.length} 字元）`);
        } else {
          step(list, false, `README HTTP ${r.status}`);
        }
      } catch (e) { res.readmeStatus = 'fetch-error'; li.remove(); step(list, false, '讀 README 失敗：' + e); }
    }
  } finally {
    btn.disabled = false;
    res.pass = res.anonStatus === 404 && res.repoStatus === 200 && res.treeStatus === 200 && res.readmeStatus === 200;
    setResult('github', res);
  }
}
function onGhForget() {
  lsDel(GH_KEY);
  $('gh-token').value = '';
  $('gh-remember').checked = false;
  $('gh-out').textContent = '';
  step($('gh-out'), true, '已清除這支手機上記住的 token');
}

// ── 3 Face ID（WebAuthn 平台驗證器＋PRF）──────────────────
const CRED_KEY = 'om-probe-cred';
const PRF_SALT = new TextEncoder().encode('om-reader-probe-prf-salt-v1-----'); // 32 bytes，測試用固定鹽
function b64u(buf) {
  const s = String.fromCharCode(...new Uint8Array(buf));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
async function onLockCreate() {
  const list = $('lk-out');
  list.textContent = '';
  if (!window.PublicKeyCredential) { step(list, false, '這個瀏覽器不支援通行金鑰'); setResult('lockCreate', { supported: false }); return; }
  const r = { supported: true };
  try {
    r.platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    step(list, r.platformAvailable, `裝置內建驗證（Face ID／Touch ID）${r.platformAvailable ? '可用' : '不可用'}`);
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'OM Reader 測試' },
        user: { id: rand(16), name: 'om-reader-probe', displayName: 'OM Reader 測試' },
        challenge: rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none',
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    r.created = true;
    r.prfEnabled = !!(ext.prf && ext.prf.enabled);
    r.prfAtCreate = !!(ext.prf && ext.prf.results && ext.prf.results.first);
    lsSet(CRED_KEY, b64u(cred.rawId));
    step(list, true, '通行金鑰已建立');
    step(list, r.prfEnabled, `PRF（從 Face ID 導出加密金鑰）${r.prfEnabled ? '支援' : '不支援或未回報'}`);
  } catch (e) {
    r.created = false;
    r.error = e && e.name ? e.name : String(e);
    step(list, false, `建立失敗：${r.error}${r.error === 'NotAllowedError' ? '（取消了，或逾時）' : ''}`);
  }
  setResult('lockCreate', r);
}
async function onLockUnlock() {
  const list = $('lk-out');
  list.textContent = '';
  const id = lsGet(CRED_KEY);
  if (!id) { step(list, false, '還沒建立通行金鑰，先按「建立通行金鑰」'); return; }
  const r = {};
  try {
    const t0 = performance.now();
    const a = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: unb64u(id), transports: ['internal', 'hybrid'] }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    r.ms = Math.round(performance.now() - t0);
    const flags = new Uint8Array(a.response.authenticatorData)[32];
    r.userVerified = (flags & 0x04) !== 0;
    const ext = a.getClientExtensionResults ? a.getClientExtensionResults() : {};
    const first = ext.prf && ext.prf.results && ext.prf.results.first;
    r.prfKey = !!(first && first.byteLength === 32);
    r.ok = true;
    step(list, r.userVerified, `解鎖成功，${r.userVerified ? '有' : '沒有'}經過 Face ID 驗證（${r.ms} ms）`);
    step(list, r.prfKey, r.prfKey ? '拿到 32 bytes 的 PRF 金鑰——正式版可以用它把手機上的資料再加密一層' : '沒拿到 PRF 金鑰——正式版的開啟鎖只能當門禁，不能當加密金鑰');
    if (r.prfKey) {
      // 再做一次，確認同一把鹽導出的金鑰穩定（加密要靠它每次都一樣）
      const a2 = await navigator.credentials.get({
        publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64u(id) }], userVerification: 'required', extensions: { prf: { eval: { first: PRF_SALT } } } },
      });
      const f2 = a2.getClientExtensionResults().prf.results.first;
      const same = b64u(first) === b64u(f2);
      r.prfStable = same;
      step(list, same, same ? '第二次導出的金鑰一模一樣（可以拿來加密）' : '兩次導出的金鑰不同——不能拿來加密');
    }
  } catch (e) {
    r.ok = false;
    r.error = e && e.name ? e.name : String(e);
    step(list, false, `解鎖失敗：${r.error}${r.error === 'NotAllowedError' ? '（取消了，或逾時）' : ''}`);
  }
  setResult('lockUnlock', r);
}
function onLockForget() {
  lsDel(CRED_KEY);
  $('lk-out').textContent = '';
  step($('lk-out'), true, '這頁已忘記金鑰。iCloud 鑰匙圈裡那一把可到「設定 → 密碼」搜尋 mauvelin.github.io 刪除');
}

// ── 4 Notion ────────────────────────────────────────────
function notionId(url) {
  try {
    const u = new URL(url.trim());
    if (!/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const flat = seg.replace(/-/g, '');
    const m = flat.match(/([0-9a-f]{32})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}
const NT_OPTIONS = [['app', '開了 Notion App'], ['web', '開了網頁'], ['none', '沒反應']];
function renderNotion() {
  const url = $('nt-url').value;
  const id = notionId(url);
  const ul = $('nt-links');
  ul.textContent = '';
  $('nt-id').textContent = url ? (id ? `頁面 ID：${id}` : '認不出這個網址的頁面 ID') : '';
  if (!id) return;
  const variants = [
    ['A', `notion://www.notion.so/${id}`, 'Notion 的 App 專用連結（notion://）', false],
    ['B', `https://www.notion.so/${id}`, '一般網址（www.notion.so）', true],
    ['C', url.trim(), '筆記裡的原網址', true],
  ];
  for (const [key, href, label, blank] of variants) {
    const li = el('li');
    const a = el('a', null, `${key}　${label}`);
    a.href = href;
    if (blank) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    li.append(a, el('span', 'hint', href));
    const chips = el('div', 'chips');
    for (const [val, text] of NT_OPTIONS) {
      const b = el('button', null, text);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(R.notion && R.notion[key] === val));
      b.addEventListener('click', () => {
        R.notion = Object.assign({}, R.notion, { [key]: val });
        chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        renderSummary();
      });
      chips.append(b);
    }
    li.append(chips);
    ul.append(li);
  }
  R.notionFormat = new URL(url.trim()).hostname;
  renderSummary();
}

// ── 5 結果摘要 ───────────────────────────────────────────
function renderSummary() {
  const L = [];
  L.push('OM Reader 測試結果　' + new Date().toLocaleString('zh-TW'));
  const e = R.env || {};
  L.push(`[環境] ${e.standalone ? '主畫面 App' : 'Safari 分頁'}｜iOS ${e.ios || '?'}｜SW ${e.sw || '?'}`);
  const si = R.storageInfo || {};
  L.push(`[儲存] 持久=${si.persisted ?? '?'}｜請求持久=${R.persistRequest ?? '未按'}｜已用 ${si.usageMB ?? '?'} MB／配額 ${si.quotaMB ?? '?'} MB`);
  if (R.storageWrite) {
    const w = R.storageWrite;
    L.push(`[寫入] 目標 ${w.targetMB} MB，寫入 ${w.writtenMB} MB，${w.seconds} 秒${w.error ? '，錯誤 ' + w.error : ''}`);
  }
  if (R.storageVerify) L.push(`[驗證] ${R.storageVerify.ok ? '完整' : '不完整'} ${R.storageVerify.good ?? '?'}／${R.storageVerify.expected ?? '?'} 塊${R.storageVerify.error ? '，錯誤 ' + R.storageVerify.error : ''}`);
  if (R.storageSurvival) {
    const s = R.storageSurvival;
    L.push(`[存活] 寫入後 ${s.days} 天：${s.chunks}／${s.expected} 塊${s.intact ? '，全在' : '，有被清掉'}`);
  }
  if (R.github) {
    const g = R.github;
    L.push(`[GitHub] ${g.pass ? '通過' : '未通過'}｜匿名 ${g.anonStatus}｜帶 token ${g.repoStatus}｜private=${g.private}｜權限 ${g.perms}｜樹 ${g.treeStatus}（${g.treeEntries ?? '-'} 筆，${g.treeMs ?? '-'} ms）｜README ${g.readmeStatus}｜額度 ${g.rateRemaining}/${g.rateLimit}`);
  }
  if (R.lockCreate) {
    const c = R.lockCreate;
    L.push(`[Face ID 建立] ${c.created ? '成功' : '失敗'}｜平台驗證 ${c.platformAvailable}｜PRF ${c.prfEnabled}${c.error ? '｜錯誤 ' + c.error : ''}`);
  }
  if (R.lockUnlock) {
    const u = R.lockUnlock;
    L.push(`[Face ID 解鎖] ${u.ok ? '成功' : '失敗'}｜UV ${u.userVerified}｜PRF 金鑰 ${u.prfKey}｜穩定 ${u.prfStable ?? '-'}${u.error ? '｜錯誤 ' + u.error : ''}`);
  }
  if (R.notion || R.notionFormat) {
    const n = R.notion || {};
    const t = (k) => ({ app: 'App', web: '網頁', none: '沒反應' }[n[k]] || '未回報');
    L.push(`[Notion] 原網址網域 ${R.notionFormat || '?'}｜A notion:// → ${t('A')}｜B www.notion.so → ${t('B')}｜C 原網址 → ${t('C')}`);
  }
  $('summary').value = L.join('\n');
  lsSet(RESULT_KEY, JSON.stringify(R)); // 只含測試結果，不含 token、repo 名稱與 Notion 網址
}
const RESULT_KEY = 'om-probe-results';
function loadResults() {
  try { Object.assign(R, JSON.parse(lsGet(RESULT_KEY) || '{}')); } catch (e) { lsDel(RESULT_KEY); }
}
async function onCopy() {
  const txt = $('summary').value;
  try { await navigator.clipboard.writeText(txt); $('copy-out').textContent = '已複製'; }
  catch (e) {
    const ta = $('summary');
    ta.removeAttribute('readonly'); ta.select(); ta.setSelectionRange(0, txt.length);
    const ok = document.execCommand && document.execCommand('copy');
    ta.setAttribute('readonly', '');
    $('copy-out').textContent = ok ? '已複製' : '自動複製失敗，請長按上面的文字框手動複製';
  }
}

// ── 啟動 ────────────────────────────────────────────────
function init() {
  $('st-persist').addEventListener('click', onPersist);
  $('st-write').addEventListener('click', onWrite);
  $('st-verify').addEventListener('click', onVerify);
  $('st-clear').addEventListener('click', onClear);
  $('gh-run').addEventListener('click', onGhRun);
  $('gh-forget').addEventListener('click', onGhForget);
  $('lk-create').addEventListener('click', onLockCreate);
  $('lk-unlock').addEventListener('click', onLockUnlock);
  $('lk-forget').addEventListener('click', onLockForget);
  $('nt-url').addEventListener('input', renderNotion);
  $('copy').addEventListener('click', onCopy);
  loadResults();
  loadGh();
  renderEnv();
  renderStorage();
  renderSummary();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(() => renderEnv()).catch(() => renderEnv());
  }
}
init();
