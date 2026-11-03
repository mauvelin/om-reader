// OM Reader——播放元件：雲端硬碟的影片與聲音。
// 播放器只連同源網址 drive-media/<檔案 ID>，由 Service Worker 帶上 token 與 Range 轉給 Drive API（token 不出現在網址上）。
// 聲音模式＝用 <audio> 播同一個檔：iPhone 一進背景就會暫停 <video>，<audio> 可以繼續播，鎖定畫面用 Media Session 控制。
// 播放器放在 #view 之外：換頁、上鎖都不拆它；上鎖時畫面蓋上鎖定頁、聲音照播。
// token 策略（本人 2026-11-03 定）：開播前剩不到 15 分鐘先續期；播放中收到 401 就記下位置、跳去登入、回來自動接回。
'use strict';

const RENEW_BEFORE_MIN = 15;
const dock = h('section', { class: 'dock', hidden: true, 'aria-label': '播放器' });
document.body.append(dock);
let PLAYER = null;   // { file, mode: 'video'|'audio', v, a, hide, wantLogin }
const playerEl = () => (PLAYER ? (PLAYER.mode === 'audio' ? PLAYER.a : PLAYER.v) : null);
const playerSrc = (id) => 'drive-media/' + encodeURIComponent(id);

function dockShow(...kids) {
  dock.replaceChildren(...kids.filter(Boolean));
  dock.hidden = false;
  document.body.classList.add('has-dock');
}
function playerClose() {
  if (PLAYER) for (const el of [PLAYER.v, PLAYER.a]) { el.pause(); el.removeAttribute('src'); el.load(); }
  PLAYER = null;
  dock.replaceChildren();
  dock.hidden = true;
  document.body.classList.remove('has-dock');
  if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch (e) { /* 略過 */ } }
}

// 開一個雲端硬碟檔：file＝{ id, name, size, mime }（size 一定要有：Drive 的回應不公開 Content-Range，SW 要自己補）
async function playerOpen(file, { t = 0, mode, resumed = false } = {}) {
  const s = await gSettings();
  if (!s.enabled) return;
  if (PLAYER) playerClose();
  mode = mode || (/^audio\//.test(file.mime || '') ? 'audio' : 'video');
  const head = h('div', { class: 'dock-head' }, h('span', { class: 'dock-title' }, file.name || '雲端硬碟檔案'),
    h('button', { type: 'button', class: 'btn quiet', onclick: playerClose }, '關閉'));
  if (!gHasToken() || gMinutesLeft() < RENEW_BEFORE_MIN) {   // 開播前先續期，播到一半才不會斷
    const go = h('button', { type: 'button', class: 'btn primary' }, gHasToken() ? '先續期 Google 登入再播' : '登入 Google 再播');
    go.addEventListener('click', () => gLogin({ returnHash: location.hash, resume: { file, t, mode } }).catch((e) => { note.textContent = e.message; }));
    const note = h('p', { class: 'status' }, gHasToken() ? `登入只剩 ${gMinutesLeft()} 分鐘，播到一半會斷。` : 'Google 登入約一小時失效，需要重新登入。');
    dockShow(head, note, h('div', { class: 'row' }, go, h('a', { class: 'btn', href: driveViewUrl(file.id), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '雲端硬碟')));
    return;
  }
  G.sizes.set(file.id, file.size);
  gTellSW();
  const v = h('video', { controls: true, playsinline: true, preload: 'metadata' });
  const a = h('audio', { controls: true, preload: 'metadata' });
  PLAYER = { file, mode, v, a, hide: null, wantLogin: false, lastT: t };   // lastT：最後一個可靠的播放位置（重新載入時 currentTime 會先歸零）
  const note = h('p', { class: 'status', role: 'status' }, resumed ? `已重新登入，接回 ${fmtClock(t)}，按播放繼續。` : '');
  const modeBtn = h('button', { type: 'button', class: 'btn' });
  const paintMode = () => {
    modeBtn.textContent = PLAYER.mode === 'audio' ? '改回影片' : '聲音模式（可在背景播）';
    v.hidden = PLAYER.mode === 'audio';
    a.hidden = PLAYER.mode !== 'audio';
  };
  modeBtn.addEventListener('click', () => { playerSwitch(); paintMode(); });
  for (const el of [v, a]) {
    el.addEventListener('playing', setupMediaSession);
    el.addEventListener('timeupdate', () => { if (PLAYER && el === playerEl() && el.readyState >= 1) PLAYER.lastT = el.currentTime; });
    el.addEventListener('error', () => { if (el === playerEl()) note.textContent = `播放失敗（錯誤碼 ${el.error && el.error.code}）。可改用「雲端硬碟」開啟。`; });
  }
  dockShow(head, h('div', { class: 'dock-media' }, v, a), note,
    h('div', { class: 'row' }, modeBtn, h('a', { class: 'btn', href: driveViewUrl(file.id), target: '_blank', rel: 'noopener noreferrer' }, svgIcon('external'), '雲端硬碟')));
  paintMode();
  playerLoad(playerEl(), t);
}
function playerLoad(el, t) {
  PLAYER.lastT = t;
  el.src = playerSrc(PLAYER.file.id);
  if (t > 0) el.addEventListener('loadedmetadata', () => { el.currentTime = t; }, { once: true });
  el.load();
}
// 影片 ↔ 聲音：從目前位置接著播（在點擊當下呼叫 play，iOS 才允許）
function playerSwitch() {
  if (!PLAYER) return;
  const from = playerEl();
  const t = from.currentTime || 0;
  const wasPlaying = !from.paused;
  from.pause();
  PLAYER.mode = PLAYER.mode === 'audio' ? 'video' : 'audio';
  const to = playerEl();
  if (!to.getAttribute('src')) playerLoad(to, t); else to.currentTime = t;
  if (wasPlaying) to.play().catch(() => {});
}
function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
// 鎖定畫面顯示什麼（課名講次，或只顯示「OM」）本人還沒決定：先只顯示「OM」
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'OM', artist: '' });
    navigator.mediaSession.setActionHandler('play', () => { const el = playerEl(); if (el) el.play(); });
    navigator.mediaSession.setActionHandler('pause', () => { const el = playerEl(); if (el) el.pause(); });
    navigator.mediaSession.setActionHandler('seekbackward', () => { const el = playerEl(); if (el) el.currentTime = Math.max(0, el.currentTime - 15); });
    navigator.mediaSession.setActionHandler('seekforward', () => { const el = playerEl(); if (el) el.currentTime += 15; });
  } catch (e) { /* 部分動作不支援時略過 */ }
}

// SW 說雲端硬碟回 401／403：記下位置，跳去登入，回來自動接回（在背景時等回到前景再跳）
function playerUnauthorized() {
  if (!PLAYER) return;
  if (document.visibilityState === 'visible' && KEY) playerRelogin();
  else PLAYER.wantLogin = true;
}
function playerRelogin() {
  const el = playerEl();
  PLAYER.wantLogin = false;
  const t = el && el.readyState >= 1 && el.currentTime > 0 ? el.currentTime : PLAYER.lastT;
  gLogin({ returnHash: location.hash, resume: { file: PLAYER.file, t, mode: PLAYER.mode } }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && PLAYER && PLAYER.wantLogin && KEY) playerRelogin();
});

// 給 core.js 的自動上鎖用：播放中不計時，暫停或停止之後才開始算
function mediaOnHide() {
  const el = playerEl();
  if (PLAYER) PLAYER.hide = el ? { ct: el.currentTime, playing: !el.paused && !el.ended, rate: el.playbackRate || 1 } : null;
}
function mediaIdleSince(hiddenAt) {
  const el = playerEl();
  const hide = PLAYER && PLAYER.hide;
  if (!el || !hide || !hide.playing) return hiddenAt;
  if (!el.paused && !el.ended) return null;                     // 還在播：不上鎖
  const playedMs = Math.max(0, el.currentTime - hide.ct) / hide.rate * 1000;
  return Math.min(Date.now(), hiddenAt + playedMs);             // 大約在這個時間點停下來
}
