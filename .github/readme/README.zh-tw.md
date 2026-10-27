# InsightFlare

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | [日本語](/.github/readme/README.ja.md) | 中文（台灣） | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

> 功能強大、注重隱私的開源網站流量分析工具，完全執行於 Cloudflare 上。

Demo: [http://insight-demo.ravelloh.com](http://insight-demo.ravelloh.com/)

![ScreenShot](/.github/screenshot/001.webp)

完全符合 GDPR，無任何 Cookie，無需使用者同意即可合法追蹤造訪資料。獨創的智慧追蹤強度機制，可根據不同地區的隱私法規自動調整訪客識別碼的持久性，最大程度兼顧資料完整性與使用者隱私保護。

前端統計指令碼 SDK 在 gzip 壓縮後僅約 3 KB，透過 Cloudflare 全球 CDN 分發，造訪效能優秀。SDK 自帶自訂事件追蹤（`data-insightflare-event`）和效能指標追蹤。

多語言的儀表盤使用前所未有的視覺化效果，讓你對造訪資料瞭如指掌。獨創的地名多語言翻譯功能，自動翻譯全球 95% 以上的地名，讓你輕鬆瞭解訪客的地理分佈。

Cloudflare 的免費額度可提供每日 10 萬次造訪的免費追蹤，結合邊緣計算帶來極佳效能。

我們不儲存原始 IP 資訊，依靠 Cloudflare 進行地理位置解析，在保護使用者隱私的同時提供高準確度的分析。

---

## 快速開始

只需點選以下按鈕：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare)

Cloudflare 會自動複製此儲存庫、建立並綁定所需要的資源。其中，你需要填寫下面兩個 Secret：

| 名稱                       | 用途                                                       |
| -------------------------- | ---------------------------------------------              |
| `MAIN_SECRET`              | 根金鑰，用於派生訪客隱私 salt、工作階段簽章和 API Key 雜湊金鑰 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 初始化管理員密碼                                           |

`MAIN_SECRET` 用於安全相關的功能，必須是長度超過 16 的隨機字串。可前往 [https://random.ravelloh.com/str/32](https://random.ravelloh.com/str/32) 來產生一個隨機字串。（重新整理頁面可以得到一個新的字串）

`BOOTSTRAP_ADMIN_PASSWORD` 是你的預設管理員帳號密碼。你需要使用 `admin` 帳號和這個密碼登入儀表盤，此後可以在個人設定頁面修改使用者名稱和密碼。

填寫完畢後，等待 3 分鐘讓專案部署完畢，你就可以登入到儀表盤並開始追蹤造訪資料了。此外，你可以在專案的設定頁面自訂其網域。預設網址為 `https://insightflare.<your-cloudflare-username>.workers.dev`

## 特性

### 完整的造訪維度追蹤

![001](/.github/screenshot/001.webp)
![002](/.github/screenshot/002.webp)
![003](/.github/screenshot/003.webp)

### 即時檢視訪客情況

![004](/.github/screenshot/004.webp)
![005](/.github/screenshot/005.webp)

### 分頁面檢視造訪情況

![006](/.github/screenshot/006.webp)

### 追蹤訪客的真實造訪效能

![007](/.github/screenshot/007.webp)
![008](/.github/screenshot/008.webp)
![009](/.github/screenshot/009.webp)

### 對比各個來源的造訪品質

![010](/.github/screenshot/010.webp)
![011](/.github/screenshot/011.webp)
![012](/.github/screenshot/012.webp)

### 追蹤 UTM 活動效果

![013](/.github/screenshot/013.webp)
![014](/.github/screenshot/014.webp)

### 記錄並分析自訂事件

![015](/.github/screenshot/015.webp)
![016](/.github/screenshot/016.webp)
![017](/.github/screenshot/017.webp)

### 洞察每一次工作階段

![018](/.github/screenshot/018.webp)
![019](/.github/screenshot/019.webp)
![020](/.github/screenshot/020.webp)
![021](/.github/screenshot/021.webp)

### 瞭解你的每一位訪客

![022](/.github/screenshot/022.webp)
![023](/.github/screenshot/023.webp)

### 追蹤站點的回訪情況

![024](/.github/screenshot/024.webp)
![025](/.github/screenshot/025.webp)

### 瞭解訪客的地理分佈與市場情報

![026](/.github/screenshot/026.webp)
![027](/.github/screenshot/027.webp)
![028](/.github/screenshot/028.webp)

### 檢視訪客的裝置情況

![029](/.github/screenshot/029.webp)
![030](/.github/screenshot/030.webp)
![031](/.github/screenshot/031.webp)

### 瞭解使用者的瀏覽器及其能力

![032](/.github/screenshot/032.webp)
![033](/.github/screenshot/033.webp)
![034](/.github/screenshot/034.webp)
![035](/.github/screenshot/035.webp)
![036](/.github/screenshot/036.webp)

### 隨時調整你的追蹤設定，無需修改前端 SDK

![037](/.github/screenshot/037.webp)
![038](/.github/screenshot/038.webp)

### 為團隊協作而設計

![039](/.github/screenshot/039.webp)
![040](/.github/screenshot/040.webp)

### 輕鬆瞭解系統的執行狀況

![041](/.github/screenshot/041.webp)
![042](/.github/screenshot/042.webp)

### 完整的多語言翻譯

![043](/.github/screenshot/043.webp)
![044](/.github/screenshot/044.webp)

### 公開分享系統

![045](/.github/screenshot/045.webp)
![046](/.github/screenshot/046.webp)

### 作用域分明的 API 系統

![047](/.github/screenshot/047.webp)

### 定時任務

![048](/.github/screenshot/048.webp)

### 對 JSON 格式的自訂事件進行深度分析

![049](/.github/screenshot/049.webp)
![050](/.github/screenshot/050.webp)
![051](/.github/screenshot/051.webp)
![052](/.github/screenshot/052.webp)
![053](/.github/screenshot/053.webp)

### 使用漏斗來分析造訪與事件

![054](/.github/screenshot/054.webp)

### 定時 / 按條件接收通知郵件

![055](/.github/screenshot/055.webp)
![056](/.github/screenshot/056.webp)
![057](/.github/screenshot/057.webp)

### 多維度的機器人防護與觀測系統

![058](/.github/screenshot/058.webp)
![059](/.github/screenshot/059.webp)
![060](/.github/screenshot/060.webp)
![061](/.github/screenshot/061.webp)
![062](/.github/screenshot/062.webp)

---

## 進階設定

### 啟用分析引擎來進行深度分析

Analytics Engine 是 InsightFlare 可選的高吞吐分析層，用於將請求觀測以及未來的流量、事件分析投影與主資料庫解耦：

- `REQUEST_ANALYTICS` → 請求觀測和異常流量
- `TRAFFIC_ANALYTICS` → 取樣後的流量事實
- `EVENT_ANALYTICS` → 取樣後的自訂事件事實

但是，這需要您手動開啟 Analytics Engine。您只需要前往 [Cloudflare Dashboard](
https://dash.cloudflare.com/?to=/:account/workers/analytics-engine) 並點選右側的“啟用”按鈕即可。之後部署 InsightFlare 時，系統會自動將 Analytics Engine 與您的 Cloudflare 帳戶綁定。

啟用後，InsightFlare 會寫入以上三個資料集。目前版本的“請求觀測”頁面已經使用新的 `REQUEST_ANALYTICS` 資料集查詢；`TRAFFIC_ANALYTICS` 和 `EVENT_ANALYTICS` 會持續累積資料，供後續 Analytics Engine Provider 使用。讀取資料集需要 API Token，請在系統設定中填寫 Cloudflare Account ID 和具備“帳戶分析”讀取權限的 API Token。Reader 設定仍儲存在主資料庫 D1 中，詳見 InsightFlare 後臺設定頁面的“教程”按鈕。

### 接入 AI Agents 進行分析

我們開放了用於 AI Agents 的 Skills，您可以選擇將 InsightFlare 接入您的 Agents，例如 OpenClaw、Codex、Claude Code 等, 讓 Agents 能夠直接存取 InsightFlare 的資料，進行分析和報告產生。
請直接傳送下面的指令給您的 Agent，您需要網域換成您部署的 InsightFlare 例項。您的 Agents 會指引您前往儀表盤為其建立一個專用 API 金鑰，便於其存取 InsightFlare 的資料。

```txt
閱讀 https://<您的 InsightFlare 網域>/.well-known/skills.json，接入這個網站流量分析系統，並指引我進行授權。
```

隨後，您可以以任意自然語言向 Agent 提問，例如：

```txt
“上個月，我的站點的造訪情況如何？造訪量最高的站點中，訪客大都是來自哪裡的？哪些頁面最受歡迎？”
```

### 使用 Cloudflare 變數覆蓋 Wrangler 設定

在 Cloudflare 的建置環境中，可以透過「變數和金鑰」覆蓋 `wrangler.toml` 中需要因部署而變化的設定。`build:pre` 會在部署前讀取這些變數並寫入目前 Wrangler 設定，隨後 `wrangler deploy` 會使用覆蓋後的設定。

常用變數：

| 名稱                                       | 覆蓋目標                              |
| -------------------------------------      | ------------------------------------- |
| `INSIGHTFLARE_WORKER_NAME`                 | Worker 名稱                           |
| `INSIGHTFLARE_D1_DATABASE`                 | D1 資料庫名稱                         |
| `INSIGHTFLARE_D1_DATABASE_ID`              | `DB` 綁定的 D1 資料庫 ID              |
| `INSIGHTFLARE_SITE_SETTINGS_KV_ID`         | `SITE_SETTINGS_KV` 綁定的 KV 名稱空間 |
| `INSIGHTFLARE_ARCHIVE_BUCKET_NAME`         | `ARCHIVE_BUCKET` 綁定的 R2 儲存桶     |
| `INSIGHTFLARE_ARCHIVE_PREVIEW_BUCKET_NAME` | R2 預覽儲存桶                         |
| `SESSION_WINDOW_MINUTES`                   | 工作階段視窗分鐘數                        |
| `SCRIPT_CACHE_TTL_SECONDS`                 | `/script.js` CDN 快取秒數             |
| `PARQUET_WASM_URL`                         | Parquet wasm 下載地址                 |
| `INSIGHTFLARE_EDGE_URL`                    | InsightFlare 服務基準 URL             |

也可以使用 `INSIGHTFLARE_VAR_變數名` 寫入任意 `[vars]` 項。例如 `INSIGHTFLARE_VAR_FEATURE_FLAG=1` 會產生 `FEATURE_FLAG = "1"`。如果使用 `--env production`，可使用 `INSIGHTFLARE_PRODUCTION_D1_DATABASE_ID`、`INSIGHTFLARE_PRODUCTION_VAR_INSIGHTFLARE_EDGE_URL` 這類環境專屬變數覆蓋 `[env.production]` 下的設定。

### 設定 R2 儲存桶用於冷歸檔

只有需要啟用冷歸檔到 R2 時，才需要手動建立 R2 bucket。預設情況下，造訪資料儲存 1 年，超時的資料將被壓縮儲存（可檢視造訪趨勢、資料，但無法進行篩選）。R2 是可選項，Deploy Button 預設不會要求綁定 R2。啟用 R2 後，可對超出 1 年的資料進行詳細查詢。

在 Cloudflare 內建立名為 `insightflare-archive` 的儲存桶。並在 `wrangler.toml` 中取消 `[[r2_buckets]]` 的註釋即可，如下所示：

```toml
[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "insightflare-archive"
preview_bucket_name = "insightflare-archive-preview"
```

### 保持更新

我們創立了開創性的 GitHub App 自動更新系統，帶給你最簡單的更新體驗。

保持更新僅需要兩步：

1. 為你的儲存庫安裝 GitHub App（只需一次，請 **僅選擇你部署的 InsightFlare 的儲存庫**）: [Install InsightFlare Sync](https://github.com/apps/insightflare-sync/installations/new)
2. 當上遊存在更新時，會自動向你的儲存庫提交一個 PR。你只需要合併這個請求即可。

_想要讓自己的專案也能方便的同步到下游？實現細節：[RavelloH/upstream-sync-bot](https://github.com/RavelloH/upstream-sync-bot)（開源模板）+ [RavelloH/InsightFlare-Bot](https://github.com/RavelloH/InsightFlare-Bot)（本專案的 bot 例項）。_

### 自訂事件上報

InsightFlare 的前端 SDK 支援以手動呼叫的方式上報自訂事件，或者透過 DOM 屬性自動上報事件。

#### 手動呼叫

```html
<script defer src="/script.js?siteId=YOUR_SITE_ID"></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    window.insightflare.track("signup_click", {
      plan: "pro",
      source: "pricing",
    });
  });
</script>
```

可用的方法：

- `track(eventName, eventData?)`：上報一個自訂事件。
- `trackOnce(eventName, eventData?)`：同一個事件名在目前頁面生命週期內只上報一次。
- `setGlobalProperties(props)`：為後續事件追加公共欄位。
- `clearGlobalProperties()`：清除公共欄位。

#### 使用者身份識別

使用 `identify` 將目前造訪與登入使用者關聯，同時保留原有的匿名訪客邊界：

```html
<script>
  window.insightflare.identify("user-123", { name: "Alice" });
</script>
```

使用者登入後呼叫 `identify`，即可將目前及後續造訪按使用者統一分析。首次頁面造訪前呼叫也受支援。使用者退出登入時呼叫 `reset()`，結束目前身份、建立新的匿名訪客邊界，並避免後續事件繼承舊帳號：

```js
window.insightflare.reset();
window.insightflare.identify("user-456", { name: "Bob" });
```

切換帳號前請先呼叫 `reset()`。單獨呼叫 `identify("user-456")` 不會建立新的訪客邊界。

#### DOM 屬性自動上報

```html
<!-- 1. 預設點選觸發 -->
<button data-insightflare-event="signup_click">立即註冊</button>
<!-- 這會上報：{ eventName: "signup_click" } -->

<!-- 2. 點選觸發，並透過 data-insightflare-event-* 附加欄位 -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-plan="pro"
  data-insightflare-event-source="pricing"
>
  立即註冊
</button>
<!-- 這會上報：{ eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 3. 點選觸發，並透過 JSON 附加欄位 -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-data='{"plan":"pro","source":"pricing"}'
>
  立即註冊
</button>
<!-- 這會上報：{ eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 4. 表單 submit 觸發 -->
<form
  data-insightflare-event="contact_submit"
  data-insightflare-event-trigger="submit"
  data-insightflare-event-data='{"plan":"pro","source":"landing"}'
>
  ...
</form>

```

## 技術棧

| 層   | 技術                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 前端 | TanStack Start 1、TanStack Router、Vite 8、React 19、Tailwind CSS 4、Radix UI、shadcn、Recharts、deck.gl、maplibre-gl、Motion |
| 後端 | Cloudflare Workers、Durable Objects、D1、R2、KV                                                                               |
| 建置 | Cloudflare Vite Plugin、Wrangler 4、TypeScript 5                                                                              |

---

## 手動部署

不使用部署按鈕，請使用下面的方法來部署：

1. Fork 或 Clone 此儲存庫至你的 GitHub 帳號下
2. 在 Cloudflare 中建立以下資源：
   - D1 資料庫
   - KV Namespace
   - R2 儲存桶（可選，僅冷歸檔到 R2 時需要）
3. 編輯 `wrangler.toml`，將 D1 和 KV 資源綁定到 Worker 上
4. 填寫環境變數（參照 `.dev.vars.example`）
5. 在 Worker 頁面匯入這個儲存庫

### 本地開發

1. 將此儲存庫複製到本機 : `git clone https://github.com/RavelloH/InsightFlare`
2. 安裝依賴 : `pnpm install`
3. 建立本地資料庫 : `pnpm run db:migrate:local`
4. 設定環境變數：（參照 `.dev.vars.example`）
5. 執行開發伺服器 : `pnpm run dev`

`pnpm run dev:ui` 會以 Demo 模式啟動 Vite 開發伺服器，使用前端模擬資料進行 UI 測試。若透過 `pnpm run dev` 啟動，可設定 `DEMO_MODE=1` 啟用 Demo 模式。

## 常用命令

| 命令                                          | 用途                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm run dev`                                 | Vite + Cloudflare Workers 本地開發（使用 `http://localhost:3000`）      |
| `pnpm run dev:ui`                              | 以 Demo 模式啟動 Vite 儀表盤開發伺服器                                  |
| `pnpm run preview:local`                       | 使用本地資源建置並啟動 Wrangler 預覽                                    |
| `pnpm run build`                               | Cloudflare 託管建置入口                                                 |
| `pnpm run build:local`                         | 本地預檢 + 本地 D1 遷移 + 建置                                          |
| `pnpm run build:demo`                          | 無資源綁定的 Demo 建置                                                  |
| `pnpm run deploy`                              | Cloudflare 託管部署入口                                                 |
| `pnpm run publish`                             | 在允許的 Cloudflare 環境中建置並主動釋出                                |
| `pnpm run publish:demo`                        | 建置併發布 Demo Worker                                                  |
| `pnpm run check`                               | 自動修復格式和 lint，並執行 build + typecheck + i18n + test + spec 檢查 |
| `pnpm run check:verify`                        | 嚴格執行完整檢查，不自動修復                                            |
| `pnpm run typecheck`                           | TypeScript 型別檢查                                                     |
| `pnpm run lint` / `lint:fix`                   | ESLint                                                                  |
| `pnpm run format` / `format:check`             | Prettier                                                                |
| `pnpm run check:i18n`                          | 校驗翻譯鍵的完整性                                                      |
| `pnpm run db:migrate:local`                    | 本地 D1 遷移                                                            |
| `pnpm run db:migrate:cf`                       | Cloudflare D1 遷移                                                      |
| `pnpm run db:migration:create`                 | 新建遷移檔案                                                            |
| `pnpm run ops:secret:main`                     | 設定 `MAIN_SECRET` Worker Secret                                        |
| `pnpm run ops:secret:bootstrap-admin-password` | 設定初始化管理員密碼 Secret                                             |
| `pnpm run ops:tail`                            | 檢視線上 Worker 日誌                                                    |

---

## 關鍵設定項目

| 名稱                                 | 含義                                  |
| ------------------------------------ | ---------------------------           |
| `SESSION_WINDOW_MINUTES`             | 工作階段視窗分鐘數（預設 `30`）           |
| `SCRIPT_CACHE_TTL_SECONDS`           | `/script.js` CDN 快取秒數             |
| `PARQUET_WASM_URL`                   | Parquet wasm 下載地址                 |
| `INSIGHTFLARE_EDGE_URL`              | InsightFlare 服務基準 URL             |
| `MAIN_SECRET`（Secret）              | 派生安全金鑰的根金鑰                  |
| `BOOTSTRAP_ADMIN_PASSWORD`（Secret） | 初始化管理員密碼                      |
| `DAILY_SALT_SECRET`（Secret）        | `MAIN_SECRET` 未設定時的相容 fallback |
| `DASHBOARD_SESSION_SECRET`（Secret） | 可選的工作階段簽章覆蓋項                  |

---

## License

[MIT](/LICENSE) © 2026 RavelloH
