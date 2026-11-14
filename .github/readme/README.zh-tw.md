<div align="center">

# InsightFlare

### 資料屬於你，分析運行在自己的 Cloudflare 上。

兼顧隱私與分析深度的開源網站分析平台：即時流量、訪客旅程、轉換漏斗，以及 AI Agent 資料分析。

[**線上體驗**](https://insight-demo.ravelloh.com/) &nbsp;·&nbsp; [**一鍵部署到 Cloudflare**](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare) &nbsp;·&nbsp; [**原始碼**](https://github.com/RavelloH/InsightFlare)

[![GitHub stars](https://img.shields.io/github/stars/RavelloH/InsightFlare?style=flat-square&logo=github)](https://github.com/RavelloH/InsightFlare/stargazers) [![Latest release](https://img.shields.io/github/v/release/RavelloH/InsightFlare?style=flat-square)](https://github.com/RavelloH/InsightFlare/releases) [![License: MIT](https://img.shields.io/github/license/RavelloH/InsightFlare?style=flat-square)](/LICENSE)

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | [日本語](/.github/readme/README.ja.md) | 中文（台灣） | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

</div>

<a href="https://insight-demo.ravelloh.com/"><img src="/.github/screenshot/001.webp" alt="InsightFlare analytics dashboard" width="100%"></a>

## 為什麼選擇 InsightFlare？

不只統計瀏覽量，也不必把分析資料交給第三方平台。InsightFlare 運行在你自己的 Cloudflare 帳戶中，整合流量、訪客行為與運作觀測。

- **自己的基礎設施，自己的資料。** 基於 Cloudflare Workers、D1 與 Durable Objects 自行託管，不需註冊第三方分析 SaaS。
- **理解訪客行為。** 分析工作階段、訪問旅程、漏斗、自訂事件、UTM 活動與流量來源品質。
- **即時掌握網站動態。** 觀察即時訪問、效能指標、地理分布、瀏覽器與裝置。
- **辨識無效流量。** 透過機器人防護與異常請求觀測，區分訪問數量與真正有價值的流量。
- **讓 AI Agent 協助分析。** 使用 Skills 入口與具權限範圍的 API，以自然語言查詢網站資料。
- **從小規模開始，按需擴充。** 支援一鍵部署、多站點與團隊、可選的 R2 封存與靈活設定。

**隱私與費用說明：** 追蹤器採用無 Cookie 設計，且不儲存原始 IP。具體法規要求和 Cloudflare 費用取決於部署設定、流量及適用地區。

## 介面預覽

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" alt="即時訪問" width="100%"><br><strong>即時訪問</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" alt="訪客工作階段" width="100%"><br><strong>訪客工作階段</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" alt="事件漏斗" width="100%"><br><strong>事件漏斗</strong></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" alt="來源分析" width="100%"><br><strong>來源分析</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" alt="地理分布" width="100%"><br><strong>地理分布</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" alt="機器人觀測" width="100%"><br><strong>機器人觀測</strong></a></td>
  </tr>
</table>

## 完整功能預覽

### 流量概覽與來源分析

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/001.webp"><img src="/.github/screenshot/001.webp" width="100%" alt="完整的造訪維度追蹤" title="完整的造訪維度追蹤"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/002.webp"><img src="/.github/screenshot/002.webp" width="100%" alt="完整的造訪維度追蹤" title="完整的造訪維度追蹤"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/003.webp"><img src="/.github/screenshot/003.webp" width="100%" alt="完整的造訪維度追蹤" title="完整的造訪維度追蹤"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" width="100%" alt="即時檢視訪客情況" title="即時檢視訪客情況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/005.webp"><img src="/.github/screenshot/005.webp" width="100%" alt="即時檢視訪客情況" title="即時檢視訪客情況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/006.webp"><img src="/.github/screenshot/006.webp" width="100%" alt="分頁面檢視造訪情況" title="分頁面檢視造訪情況"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/007.webp"><img src="/.github/screenshot/007.webp" width="100%" alt="追蹤訪客的真實造訪效能" title="追蹤訪客的真實造訪效能"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/008.webp"><img src="/.github/screenshot/008.webp" width="100%" alt="追蹤訪客的真實造訪效能" title="追蹤訪客的真實造訪效能"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/009.webp"><img src="/.github/screenshot/009.webp" width="100%" alt="追蹤訪客的真實造訪效能" title="追蹤訪客的真實造訪效能"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" width="100%" alt="對比各個來源的造訪品質" title="對比各個來源的造訪品質"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/011.webp"><img src="/.github/screenshot/011.webp" width="100%" alt="對比各個來源的造訪品質" title="對比各個來源的造訪品質"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/012.webp"><img src="/.github/screenshot/012.webp" width="100%" alt="對比各個來源的造訪品質" title="對比各個來源的造訪品質"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/013.webp"><img src="/.github/screenshot/013.webp" width="100%" alt="追蹤 UTM 活動效果" title="追蹤 UTM 活動效果"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/014.webp"><img src="/.github/screenshot/014.webp" width="100%" alt="追蹤 UTM 活動效果" title="追蹤 UTM 活動效果"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 事件、工作階段與訪客旅程

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/015.webp"><img src="/.github/screenshot/015.webp" width="100%" alt="記錄並分析自訂事件" title="記錄並分析自訂事件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/016.webp"><img src="/.github/screenshot/016.webp" width="100%" alt="記錄並分析自訂事件" title="記錄並分析自訂事件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/017.webp"><img src="/.github/screenshot/017.webp" width="100%" alt="記錄並分析自訂事件" title="記錄並分析自訂事件"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" width="100%" alt="洞察每一次工作階段" title="洞察每一次工作階段"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/019.webp"><img src="/.github/screenshot/019.webp" width="100%" alt="洞察每一次工作階段" title="洞察每一次工作階段"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/020.webp"><img src="/.github/screenshot/020.webp" width="100%" alt="洞察每一次工作階段" title="洞察每一次工作階段"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/021.webp"><img src="/.github/screenshot/021.webp" width="100%" alt="洞察每一次工作階段" title="洞察每一次工作階段"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/022.webp"><img src="/.github/screenshot/022.webp" width="100%" alt="瞭解你的每一位訪客" title="瞭解你的每一位訪客"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/023.webp"><img src="/.github/screenshot/023.webp" width="100%" alt="瞭解你的每一位訪客" title="瞭解你的每一位訪客"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/024.webp"><img src="/.github/screenshot/024.webp" width="100%" alt="追蹤站點的回訪情況" title="追蹤站點的回訪情況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/025.webp"><img src="/.github/screenshot/025.webp" width="100%" alt="追蹤站點的回訪情況" title="追蹤站點的回訪情況"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 受眾、裝置與地理分析

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" width="100%" alt="瞭解訪客的地理分佈與市場情報" title="瞭解訪客的地理分佈與市場情報"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/027.webp"><img src="/.github/screenshot/027.webp" width="100%" alt="瞭解訪客的地理分佈與市場情報" title="瞭解訪客的地理分佈與市場情報"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/028.webp"><img src="/.github/screenshot/028.webp" width="100%" alt="瞭解訪客的地理分佈與市場情報" title="瞭解訪客的地理分佈與市場情報"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/029.webp"><img src="/.github/screenshot/029.webp" width="100%" alt="檢視訪客的裝置情況" title="檢視訪客的裝置情況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/030.webp"><img src="/.github/screenshot/030.webp" width="100%" alt="檢視訪客的裝置情況" title="檢視訪客的裝置情況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/031.webp"><img src="/.github/screenshot/031.webp" width="100%" alt="檢視訪客的裝置情況" title="檢視訪客的裝置情況"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/032.webp"><img src="/.github/screenshot/032.webp" width="100%" alt="瞭解使用者的瀏覽器及其能力" title="瞭解使用者的瀏覽器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/033.webp"><img src="/.github/screenshot/033.webp" width="100%" alt="瞭解使用者的瀏覽器及其能力" title="瞭解使用者的瀏覽器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/034.webp"><img src="/.github/screenshot/034.webp" width="100%" alt="瞭解使用者的瀏覽器及其能力" title="瞭解使用者的瀏覽器及其能力"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/035.webp"><img src="/.github/screenshot/035.webp" width="100%" alt="瞭解使用者的瀏覽器及其能力" title="瞭解使用者的瀏覽器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/036.webp"><img src="/.github/screenshot/036.webp" width="100%" alt="瞭解使用者的瀏覽器及其能力" title="瞭解使用者的瀏覽器及其能力"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 設定、團隊協作與分享

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/037.webp"><img src="/.github/screenshot/037.webp" width="100%" alt="隨時調整你的追蹤設定，無需修改前端 SDK" title="隨時調整你的追蹤設定，無需修改前端 SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/038.webp"><img src="/.github/screenshot/038.webp" width="100%" alt="隨時調整你的追蹤設定，無需修改前端 SDK" title="隨時調整你的追蹤設定，無需修改前端 SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/039.webp"><img src="/.github/screenshot/039.webp" width="100%" alt="為團隊協作而設計" title="為團隊協作而設計"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/040.webp"><img src="/.github/screenshot/040.webp" width="100%" alt="為團隊協作而設計" title="為團隊協作而設計"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/041.webp"><img src="/.github/screenshot/041.webp" width="100%" alt="輕鬆瞭解系統的執行狀況" title="輕鬆瞭解系統的執行狀況"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/042.webp"><img src="/.github/screenshot/042.webp" width="100%" alt="輕鬆瞭解系統的執行狀況" title="輕鬆瞭解系統的執行狀況"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/043.webp"><img src="/.github/screenshot/043.webp" width="100%" alt="完整的多語言翻譯" title="完整的多語言翻譯"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/044.webp"><img src="/.github/screenshot/044.webp" width="100%" alt="完整的多語言翻譯" title="完整的多語言翻譯"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/045.webp"><img src="/.github/screenshot/045.webp" width="100%" alt="公開分享系統" title="公開分享系統"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/046.webp"><img src="/.github/screenshot/046.webp" width="100%" alt="公開分享系統" title="公開分享系統"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/047.webp"><img src="/.github/screenshot/047.webp" width="100%" alt="作用域分明的 API 系統" title="作用域分明的 API 系統"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/048.webp"><img src="/.github/screenshot/048.webp" width="100%" alt="定時任務" title="定時任務"></a></td>
  </tr>
</table>

### 深度事件分析與轉換漏斗

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/049.webp"><img src="/.github/screenshot/049.webp" width="100%" alt="對 JSON 格式的自訂事件進行深度分析" title="對 JSON 格式的自訂事件進行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/050.webp"><img src="/.github/screenshot/050.webp" width="100%" alt="對 JSON 格式的自訂事件進行深度分析" title="對 JSON 格式的自訂事件進行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/051.webp"><img src="/.github/screenshot/051.webp" width="100%" alt="對 JSON 格式的自訂事件進行深度分析" title="對 JSON 格式的自訂事件進行深度分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/052.webp"><img src="/.github/screenshot/052.webp" width="100%" alt="對 JSON 格式的自訂事件進行深度分析" title="對 JSON 格式的自訂事件進行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/053.webp"><img src="/.github/screenshot/053.webp" width="100%" alt="對 JSON 格式的自訂事件進行深度分析" title="對 JSON 格式的自訂事件進行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" width="100%" alt="使用漏斗來分析造訪與事件" title="使用漏斗來分析造訪與事件"></a></td>
  </tr>
</table>

### 運作監控、通知與機器人防護

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/055.webp"><img src="/.github/screenshot/055.webp" width="100%" alt="定時 / 按條件接收通知郵件" title="定時 / 按條件接收通知郵件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/056.webp"><img src="/.github/screenshot/056.webp" width="100%" alt="定時 / 按條件接收通知郵件" title="定時 / 按條件接收通知郵件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/057.webp"><img src="/.github/screenshot/057.webp" width="100%" alt="定時 / 按條件接收通知郵件" title="定時 / 按條件接收通知郵件"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" width="100%" alt="多維度的機器人防護與觀測系統" title="多維度的機器人防護與觀測系統"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/059.webp"><img src="/.github/screenshot/059.webp" width="100%" alt="多維度的機器人防護與觀測系統" title="多維度的機器人防護與觀測系統"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/060.webp"><img src="/.github/screenshot/060.webp" width="100%" alt="多維度的機器人防護與觀測系統" title="多維度的機器人防護與觀測系統"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/061.webp"><img src="/.github/screenshot/061.webp" width="100%" alt="多維度的機器人防護與觀測系統" title="多維度的機器人防護與觀測系統"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/062.webp"><img src="/.github/screenshot/062.webp" width="100%" alt="多維度的機器人防護與觀測系統" title="多維度的機器人防護與觀測系統"></a></td>
    <td width="33%"></td>
  </tr>
</table>

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

如果無法登入現有的管理員帳號，修改 `BOOTSTRAP_ADMIN_PASSWORD` 不會重設該帳號。在已安裝儲存庫相依套件並設定 Cloudflare 身分驗證的互動式終端中執行 `pnpm run ops:admin:reset-password -- --user <username>`。包括 `cf` CLI 在內的更多參數可透過 `pnpm run ops:admin:reset-password -- --help` 查看。

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
