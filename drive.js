// OM Reader——雲端硬碟模組：用檔名找檔案 ID（結果加密快取）、讀檔、建立與改寫 App 自己的檔、找或建資料夾。
// 網路只連 www.googleapis.com（CSP 鎖定），token 由 google.js 管。
'use strict';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
const D_FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum';
const D_FOLDER = 'application/vnd.google-apps.folder';
let driveCache = null;   // 檔名 → { id, name, size, mime, n（同名幾個）, at }；解密後只在記憶體，上鎖就丟
LOCK_HOOKS.push(() => { driveCache = null; });

async function driveCacheLoad() {
  if (driveCache) return driveCache;
  const rec = await kvGet('drive-ids');
  driveCache = {};
  if (rec) { try { driveCache = JSON.parse(td.decode(await open_(rec))); } catch (e) { driveCache = {}; } }
  return driveCache;
}
async function driveCacheSave() { await kvSet('drive-ids', await seal(te.encode(JSON.stringify(driveCache)))); }
const dEsc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const driveViewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

// 用檔名找（name = '…' and trashed = false），結果加密快取。快取規則（本人 2026-11-03，PDF 改名、重新上傳時）：
// - 檔名（pdf_key／media.key）變了：快取以檔名為鍵，自然當新檔名重查
// - validate：開檔前確認快取的 ID 還在、沒進垃圾桶；404 或在垃圾桶就丟掉這筆、用檔名重查一次
// - 同名不只一個：不自己挑，回傳 { choices } 讓本人選；選好的用 driveChoose 記住
// - 同一個 ID 內容被換掉：講義 PDF 與影音每次都從雲端硬碟現讀，不快取內容，所以不會拿到舊的
async function driveFind(name, { fresh = false, validate = false } = {}) {
  const c = await driveCacheLoad();
  let hit = fresh ? null : c[name] || null;
  if (hit && validate) {
    try {
      const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(hit.id)}?fields=id,trashed,size,modifiedTime`)).json();
      if (f.trashed) hit = null; else if (f.size) hit.size = Number(f.size);
    } catch (e) { if (e.status === 404) hit = null; else throw e; }
    if (!hit) { delete c[name]; await driveCacheSave(); }
  }
  if (hit) return hit;
  const qs = new URLSearchParams({ q: `name = '${dEsc(name)}' and trashed = false`, fields: `files(${D_FIELDS})`, pageSize: '10', spaces: 'drive' });
  const files = (await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [];
  if (!files.length) return null;
  const pack = (f) => ({ id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || '', modified: f.modifiedTime || '' });
  if (files.length > 1) return { name, choices: files.map(pack) };
  hit = { ...pack(files[0]), at: Date.now() };
  c[name] = hit;
  await driveCacheSave();
  return hit;
}
async function driveChoose(name, f) {
  const c = await driveCacheLoad();
  c[name] = { ...f, chosen: true, at: Date.now() };
  await driveCacheSave();
  return c[name];
}
// 唯讀找資料夾（不建立）：給讀 learn 匯出檔用
async function driveFolderFind(parts) {
  let parent = 'root';
  for (const name of parts) {
    const qs = new URLSearchParams({ q: `name = '${dEsc(name)}' and mimeType = '${D_FOLDER}' and '${dEsc(parent)}' in parents and trashed = false`, fields: 'files(id)' });
    const f = ((await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [])[0];
    if (!f) return null;
    parent = f.id;
  }
  return parent;
}
async function driveMeta(id) {
  const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${D_FIELDS}`)).json();
  return { id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || '' };
}
async function driveRead(id) { return gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, { timeout: 120000 }); }   // 講義 PDF 可能很大：2 分鐘

// 找或建一串資料夾（從「我的雲端硬碟」根目錄往下），回傳最後一層的 ID
async function driveFolder(parts) {
  let parent = 'root';
  for (const name of parts) {
    const qs = new URLSearchParams({ q: `name = '${dEsc(name)}' and mimeType = '${D_FOLDER}' and '${dEsc(parent)}' in parents and trashed = false`, fields: 'files(id)' });
    let f = ((await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [])[0];
    if (!f) {
      f = await (await gfetch(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: D_FOLDER, parents: [parent] }) })).json();
    }
    parent = f.id;
  }
  return parent;
}
async function driveFindIn(parentId, name) {
  const qs = new URLSearchParams({ q: `name = '${dEsc(name)}' and '${dEsc(parentId)}' in parents and trashed = false`, fields: `files(${D_FIELDS})` });
  return ((await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [])[0] || null;
}
// 建立 App 自己的檔（drive.file 權限只能改 App 建的檔）
async function driveCreate(parentId, name, text, mime = 'application/json') {
  const boundary = 'om' + gRandom();
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + JSON.stringify({ name, parents: [parentId], mimeType: mime })
    + `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${text}\r\n--${boundary}--`;
  return (await gfetch(`${DRIVE_UP}/files?uploadType=multipart&fields=${D_FIELDS}`, { method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
}
async function driveUpdate(id, text, mime = 'application/json') {
  return (await gfetch(`${DRIVE_UP}/files/${encodeURIComponent(id)}?uploadType=media&fields=${D_FIELDS}`, { method: 'PATCH',
    headers: { 'Content-Type': mime }, body: text })).json();
}
