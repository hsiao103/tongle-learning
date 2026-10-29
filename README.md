# 同樂・學習無邊界

同樂國小七項數位學習作品的一頁式入口網站。採繁體中文與臺灣用語，無需安裝套件或建置。

## 檔案

- `index.html`：完整介紹、七張專案卡、學習理念、探索入口。
- `styles.css`：手機單欄、平板雙欄、電腦三欄的響應式設計。
- `script.js`：作品分類篩選及探索入口互動。
- `assets/`：本站自製 SVG 概念插畫與網站圖示，無外部字型或圖片依賴。
- `.nojekyll`：讓 GitHub Pages 直接提供靜態檔案。
- `link-check.md`：七項作品的連結檢查紀錄及驗證範圍。

## 部署到 GitHub Pages

1. 建立或選擇一個 GitHub 儲存庫。
2. 將 `index.html`、`styles.css`、`script.js`、`assets/` 與 `.nojekyll` 放在儲存庫根目錄，並提交變更。請保留 `assets` 資料夾層級。
3. 開啟儲存庫的 **Settings → Pages**。
4. 在 **Build and deployment → Source** 選擇 **Deploy from a branch**。
5. 選擇存放檔案的分支（通常為 `main`），資料夾選 **/ (root)**，按 **Save**。
6. 等待部署完成，開啟 Pages 顯示的網址。

本站使用相對路徑，支援 `https://帳號.github.io/儲存庫名稱/`。若部署在 `docs/`，請將整套網站檔案移入該資料夾，並在 Pages 設定選擇 `/docs`。

也可先直接開啟 `index.html` 預覽。壓縮檔請先解壓縮，再上傳其中的檔案；不必上傳壓縮檔本身。

## 後續維護

作品名稱、說明與網址直接編輯 `index.html`。調整配色可修改 `styles.css` 開頭的色彩變數。分類由卡片的 `data-category` 與按鈕的 `data-filter` 對應。

卡片插畫是主題示意，不是原網站截圖或精確校園模型。網站未置入追蹤碼、表單或第三方套件。停用 JavaScript 仍可閱讀全部七項作品及開啟連結，分類功能則需 JavaScript。

本次交付為可部署檔案，尚未上傳或變更任何 GitHub 儲存庫。
