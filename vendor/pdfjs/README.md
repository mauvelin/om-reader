# vendor/pdfjs

Mozilla pdf.js（pdfjs-dist 3.11.174，Apache-2.0，見 LICENSE），站內託管、不連外。用在 App 內顯示 PDF（`pdfview.js`）。
- `pdf.min.js`、`pdf.worker.min.js`：放進離線快取（sw.js SHELL）
- `cmaps/`、`standard_fonts/`：中文等字型對照表與標準字型，用到時才下載，之後留在快取
- 載入時一律 `isEvalSupported: false`（App 的 CSP 不允許 eval／new Function）
