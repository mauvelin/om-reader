// OM Reader——App 內顯示 PDF（pdf.js，站內託管於 vendor/pdfjs/）。
// iPhone 的頁面內嵌只會顯示第一頁（測試頁實測），所以自己逐頁畫在 canvas 上：先放好每頁的位置，捲到附近才畫。
// 縮放交給系統的雙指縮放（learn 也是這樣，不另做縮放選單）。pdf.js 只在第一次用到時才載入。
'use strict';

let pdfjsReady = null;
function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfjsReady = null; reject(new Error('pdf.js 沒有載入')); };
      document.head.append(s);
    });
  }
  return pdfjsReady;
}

// 把 PDF（ArrayBuffer 或 Blob）畫進 container；回傳 { pages }
async function pdfInto(container, data) {
  const lib = await loadPdfJs();
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const doc = await lib.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false,
    cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
  }).promise;
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const box = h('div', { class: 'pdf-pages' });
  container.replaceChildren(h('p', { class: 'muted pdf-count' }, `共 ${doc.numPages} 頁・雙指可放大`), box);
  const width = () => Math.max(200, box.clientWidth || container.clientWidth || 360);
  const slots = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const c = h('canvas', { class: 'pdf-page', 'data-page': String(n), 'aria-label': `第 ${n} 頁` });
    c.style.aspectRatio = `${base.width} / ${base.height}`;   // 先用第一頁的比例佔位，畫的時候換成該頁的
    box.append(c);
    slots.push(c);
  }
  const draw = async (c) => {
    if (c.dataset.drawn) return;
    c.dataset.drawn = '1';
    const page = await doc.getPage(Number(c.dataset.page));
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: (width() * dpr) / vp1.width });
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); draw(en.target).catch(() => {}); }
    }, { rootMargin: '800px 0px' });
    slots.forEach((c) => io.observe(c));
  } else slots.forEach((c) => draw(c).catch(() => {}));
  return { pages: doc.numPages };
}
