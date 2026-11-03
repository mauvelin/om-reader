// OM Reader——雲端硬碟模組：用檔名找檔案 ID（結果加密快取）、讀檔、建立與改寫 App 自己的檔、找或建資料夾。
// 網路只連 www.googleapis.com（CSP 鎖定），token 由 google.js 管。
'use strict';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
const D_FIELDS = 'id,name,mimeType,size,modifiedTime';
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

// 用檔名找（name = '…' and trashed = false）。同名不只一個時取第一個，並在結果的 n 回報有幾個
async function driveFind(name, { fresh = false } = {}) {
  const c = await driveCacheLoad();
  if (!fresh && c[name]) return c[name];
  const qs = new URLSearchParams({ q: `name = '${dEsc(name)}' and trashed = false`, fields: `files(${D_FIELDS})`, pageSize: '10', spaces: 'drive' });
  const files = (await (await gfetch(`${DRIVE}/files?${qs}`)).json()).files || [];
  if (!files.length) return null;
  const f = files[0];
  const hit = { id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || '', n: files.length, at: Date.now() };
  c[name] = hit;
  await driveCacheSave();
  return hit;
}
async function driveMeta(id) {
  const f = await (await gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${D_FIELDS}`)).json();
  return { id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mimeType || '' };
}
async function driveRead(id) { return gfetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`); }

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
