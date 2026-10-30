# 同樂・學習無邊界

同樂國小七項數位學習作品的一頁式入口網站。採繁體中文與臺灣用語，無需安裝套件或建置。

## 檔案

- `index.html`：完整介紹、七張專案卡、學習理念、探索入口，以及登入／分享作品對話框。
- `styles.css`：手機單欄、平板雙欄、電腦三欄的響應式設計，結尾是社群互動樣式。
- `script.js`：作品分類篩選及探索入口互動（也會計入使用者分享的作品）。
- `social.js`：Google 登入、分享作品、按讚、留言。
- `config.js`：Supabase 連線設定（填入後才是正式模式）。
- `supabase-setup.sql`：資料表、權限規則（RLS）與封面圖儲存空間，貼到 Supabase SQL Editor 執行。
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

## 社群功能：登入、分享作品、按讚、留言

- **瀏覽**：任何人都能看作品、按讚數與留言。
- **按讚、留言、分享作品**：必須先用 Google 登入。每人對每個作品只能按一次讚；留言上限 300 字；只能刪除自己的留言與作品。
- **管理者**：登錄在 `admins` 資料表的 Google 信箱可刪除任何人的留言與作品。信箱只存在資料庫，不會出現在前端或 GitHub。
- **作品身分標示**：每張卡右上角有「教師作品」「學生作品」或「訪客作品」徽章，篩選列也能只看學生或教師作品。身分由資料庫依登入信箱網域自動判斷（`tmail.ilc.edu.tw` → 教師、`smail.ilc.edu.tw` → 學生、管理者 → 教師、其他 → 訪客），前端無法自行更改；信箱本身不會公開。七個內建作品固定標為「教師作品」，要改請編輯 `index.html` 的 `data-role` 與徽章文字。
- **暱稱**：留言與作品顯示使用者自己設定的暱稱（預設為 Google 顯示名稱），電子郵件不會公開。
- **兩個校園導覽卡**：「同樂校園導覽」連到 3D 校園完整版（教育帳號登入），「訪客校園引導」連到免登入的訪客版。

### 啟用步驟（約 10 分鐘）

1. 在 [Supabase](https://supabase.com) 建立專案（可沿用同樂小行星使用的專案）。
2. **SQL Editor** 貼上 `supabase-setup.sql` 全部內容執行；最後一行 `insert into public.admins …` 先把信箱改成管理者的 Google 信箱，並移除開頭的 `--`。
3. **Authentication → Providers → Google** 啟用，填入 Google Cloud 的 OAuth Client ID／Secret（Google Cloud 的授權重新導向 URI 填 Supabase 頁面上顯示的 callback URL）。
4. **Authentication → URL Configuration**：Site URL 填 `https://hsiao103.github.io/tongle-learning/`，Redirect URLs 也加入同一網址。
5. 把 **Project Settings → API** 的 Project URL 與 anon (publishable) key 填進 `config.js`。anon key 本來就是公開用的，安全由資料表 RLS 負責，可放心上傳 GitHub。
6. 重新部署後，頁首會顯示「Google 登入」，示範模式的黃色提示條也會消失。

`config.js` 留空時是**示範模式**：按讚、留言、分享都可試玩，但資料只存在目前瀏覽器、登入是模擬的，不是真正的 Google 登入。

### 作品點擊統計（含未登入訪客）

- 每次有人按名片上的「前往作品」，會記錄一次「開啟」。**同一位訪客、同一個作品、同一天只算一次**，避免重複整理被灌數字。
- 名片右下角顯示該作品的累計開啟次數；管理者會在「分享我的作品」旁看到 **📊 點擊統計**，可看近 7／30／90 天的每日長條圖，以及各作品的訪客、教師、學生開啟次數。
- 隱私：不記 IP、姓名或信箱，只用瀏覽器裡隨機產生的匿名代號去重；身分依登入信箱網域在資料庫端判斷（tmail＝教師、smail＝學生、未登入＝訪客）。
- 啟用：重新貼上執行最新的 `supabase-setup.sql`（可重複執行）。還沒執行前，名片上不會顯示次數，其他功能不受影響。
- 數字代表「點了連結」，不等於真正使用或學習；廣告攔截器、直接輸入網址等情況不會被計入。

### 之後想加強時

- **已執行過舊版 SQL 的話**：身分標示需要重新貼上執行一次 `supabase-setup.sql`（可重複執行，不會刪資料）。
- **限制只有教育帳號能分享**：目前任何 Google 帳號登入後都能分享。若要只開放 `tmail.ilc.edu.tw`／`smail.ilc.edu.tw`，需在 `works`、`comments` 的 insert policy 加上 `auth.jwt() ->> 'email'` 網域檢查（只改前端擋不住，必須寫在資料庫規則）。
- **先審核再公開**：可在 `works` 加 `approved` 欄位，讀取規則改為只顯示已核准或自己的作品。

## 後續維護

作品名稱、說明與網址直接編輯 `index.html`。調整配色可修改 `styles.css` 開頭的色彩變數。分類由卡片的 `data-category` 與按鈕的 `data-filter` 對應。

卡片插畫是主題示意，不是原網站截圖或精確校園模型。網站未置入追蹤碼；社群功能啟用後會載入 Supabase 的 JavaScript 套件（cdn.jsdelivr.net）並連線到你的 Supabase 專案。停用 JavaScript 仍可閱讀全部七項作品及開啟連結，分類、登入、按讚、留言與分享則需 JavaScript。

本次交付為可部署檔案，尚未上傳或變更任何 GitHub 儲存庫。

## 許願池（登入後才看得到）

- 登入後，頁面會出現「🪙 許願池」區塊與導覽連結；未登入時兩者都不會顯示，也不會向資料庫發出請求。
- 保護是雙重的：前端隱藏，加上資料庫列級安全（RLS）只允許 `authenticated` 讀取，未登入者即使直接呼叫 API 也讀不到任何願望。
- 登入者可投下願望（2–200 字，每人 24 小時最多 10 個）、按「我也想要」，並刪除自己的願望；排序依「我也想要」數量。
- 管理者（`admins` 名單）可將願望標為「已實現」，也可刪除任何願望。
- 啟用方式：把最新的 `supabase-setup.sql` 在 Supabase SQL Editor 再執行一次（可重複執行，第 7c 節）。
