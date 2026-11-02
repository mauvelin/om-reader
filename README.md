# om-reader

OM Wiki 的 iPhone 唯讀閱讀器（PWA）的**程式殼**。這個 repo 只放程式碼，不放任何資料：
資料在另一個私有 repo，repo 名稱與唯讀 token 只在手機上第一次設定時輸入，不寫進程式。

## 目前內容

- `probe/`：上線前的手機測試頁，一次驗四個前提——
  ①主畫面 App 能否離線存下約 300 MB 且不被系統清掉；②能否用唯讀 token 直接呼叫 GitHub API 讀私有 repo；
  ③Face ID（通行金鑰）開啟鎖與 PRF 金鑰導出；④能否從 App 叫起 Notion App。

## 安全約定

- 不載入任何外部程式庫或字型（CSP 只允許連 `api.github.com`）。
- `mauvelin.github.io` 底下只開這一個 Pages 網站：同帳號的 Pages 網站共用同一個瀏覽器來源，
  另開的網站讀得到這個 App 存在手機上的 token 與資料。
