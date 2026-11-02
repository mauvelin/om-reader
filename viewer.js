// HTML 檢視器：在 sandbox iframe 內，收到父頁送來的 HTML 後整頁寫入。
// sandbox 來源下 localStorage 會丟例外，這裡先換成記憶體版，讓頁面的「記住設定」不會讓程式中斷。
'use strict';
(function () {
  const SHIM = '<script>(function(){function s(){var m=new Map();return{get length(){return m.size},key:function(i){return Array.from(m.keys())[i]||null},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}'
    + 'try{window.localStorage.getItem("x")}catch(e){try{Object.defineProperty(window,"localStorage",{value:s(),configurable:true})}catch(e2){}}'
    + 'try{window.sessionStorage.getItem("x")}catch(e){try{Object.defineProperty(window,"sessionStorage",{value:s(),configurable:true})}catch(e2){}}})();<\/script>';
  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent || !ev.data || ev.data.type !== 'om-html') return;
    let html = String(ev.data.html);
    // shim 插在 <head> 最前面，讓頁面自己的腳本執行前就生效
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + SHIM);
    else html = SHIM + html;
    document.open();
    document.write(html);
    document.close();
  });
})();
