// OM Reader——Google 登入：整頁跳轉到 Google 再跳回來，不載入任何 Google 程式。
// 權限只有 drive.readonly（讀影音、講義）＋drive.file（建立與改寫 App 自己的檔）。
// token 只放記憶體（這一頁＋Service Worker），約一小時失效，不寫進手機的儲存空間；
// 上鎖時不丟（背景聲音要繼續播），「刪除手機上的全部資料」時才丟。
// 用戶端 ID 由本人在設定頁輸入，以開啟鎖的金鑰加密存在這支手機。
// 整套功能預設關閉：設定頁打開「啟用」之前，App 不會出現任何 Google 相關的東西。
'use strict';

const G_SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const G = { token: null, exp: 0, sizes: new Map(), lastReturn: null };

async function gSettings() {
  const s = (await kvGet('google')) || {};
  let client = '';
  if (s.client && KEY) { try { client = td.decode(await open_(s.client)); } catch (e) { client = ''; } }
  return { enabled: !!s.enabled, client };
}
async function gSaveSettings({ enabled, client }) {
  const cur = (await kvGet('google')) || {};
  const next = { enabled: enabled == null ? !!cur.enabled : !!enabled, client: cur.client || null };
  if (client != null) next.client = client ? await seal(te.encode(client)) : null;
  await kvSet('google', next);
}
const gMinutesLeft = () => (G.token ? Math.floor((G.exp - Date.now()) / 60000) : 0);
const gHasToken = () => !!G.token && Date.now() < G.exp;
function gRedirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function gRandom() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); }
function gStore(kind, k, v) { try { if (v == null) window[kind].removeItem(k); else window[kind].setItem(k, v); } catch (e) { /* 封鎖時略過 */ } }
function gLoad(kind, k) { try { return window[kind].getItem(k); } catch (e) { return null; } }

// 跳去 Google 登入。回來的頁面與要接回的播放位置先加密存起來，解鎖後才讀（見 gAfterUnlock）
async function gLogin({ returnHash, resume, silent } = {}) {
  const s = await gSettings();
  if (!s.enabled) throw new Error('雲端硬碟影音還沒啟用');
  if (!/\.apps\.googleusercontent\.com$/.test(s.client)) throw new Error('還沒填 OAuth 用戶端 ID');
  const state = gRandom();
  gStore('sessionStorage', 'om-g-state', state);
  gStore('localStorage', 'om-g-state', state);   // 主畫面 App 跳回來若換了頁面環境，sessionStorage 會不見
  const pending = { hash: returnHash || location.hash || '#/', resume: resume || null, at: Date.now() };
  await kvSet('g-pending', await seal(te.encode(JSON.stringify(pending))));
  const p = new URLSearchParams({ client_id: s.client, redirect_uri: gRedirectUri(), response_type: 'token',
    scope: G_SCOPES, include_granted_scopes: 'true', state });
  if (silent) p.set('prompt', 'none');
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

// 啟動時、路由之前呼叫：網址 # 後面若是 Google 帶回來的結果，取下、核對 state、立刻從網址清掉
// （App 換頁也用 #，不先清掉會被當成一個頁面網址）
function gTakeReturn() {
  const hash = location.hash;
  if (!/^#(?:[^/].*&)?(access_token|error)=/.test(hash) || hash.startsWith('#/')) return null;
  const p = new URLSearchParams(hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const got = p.get('state');
  const ok = !!got && (got === gLoad('sessionStorage', 'om-g-state') || got === gLoad('localStorage', 'om-g-state'));
  gStore('sessionStorage', 'om-g-state', null);
  gStore('localStorage', 'om-g-state', null);
  if (!ok) return (G.lastReturn = { ok: false, error: 'state 不符：不是這次登入的回應，已丟掉' });
  if (p.get('error')) return (G.lastReturn = { ok: false, error: 'Google 回應：' + p.get('error') });
  G.token = p.get('access_token');
  G.exp = Date.now() + Number(p.get('expires_in') || 0) * 1000;
  gTellSW();
  return (G.lastReturn = { ok: true });
}

// 解鎖後：回到登入前的那一頁；有要接回的播放就交給播放元件
async function gAfterUnlock() {
  const rec = await kvGet('g-pending');
  if (!rec) return;
  await idbDel('kv', 'g-pending');
  let pending = null;
  try { pending = JSON.parse(td.decode(await open_(rec))); } catch (e) { return; }
  if (!pending || Date.now() - pending.at > 30 * 60 * 1000) return;   // 半小時前的就不接了
  if (pending.hash && pending.hash !== location.hash) history.replaceState(null, '', location.pathname + location.search + pending.hash);
  if (pending.resume && gHasToken() && typeof playerOpen === 'function') {
    setTimeout(() => playerOpen(pending.resume.file, { t: pending.resume.t, mode: pending.resume.mode, resumed: true }), 0);
  }
}
UNLOCK_HOOKS.push(gAfterUnlock);

function gForget() { G.token = null; G.exp = 0; G.sizes.clear(); gTellSW(); }

// token 與檔案大小交給 Service Worker（SW 被系統停掉再叫醒時兩者都不見，會向頁面要）
function gTellSW() {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (c) c.postMessage({ type: 'gtoken', token: gHasToken() ? G.token : null, sizes: Object.fromEntries(G.sizes) });
}
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'g-need-token') gTellSW();
    else if (m.type === 'g-unauthorized' && typeof playerUnauthorized === 'function') playerUnauthorized(m.status);
  });
}

async function gfetch(url, opts = {}) {
  if (!gHasToken()) { const e = new Error('Google 登入已過期，請重新登入'); e.status = 401; throw e; }
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + G.token }, opts.headers || {}),
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  }));
  if (!res.ok) {
    const e = new Error(`Google HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res;
}
