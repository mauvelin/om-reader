// 在樣式載入前套上使用者選的明暗（避免先閃另一個顏色）。選擇存在這台裝置的 localStorage（只是偏好，不是資料）。
'use strict';
(function () {
  var t = null;
  try { t = localStorage.getItem('om-reader-theme'); } catch (e) { /* 無痕或封鎖時就跟隨系統 */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
