# InsightFlare

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | 日本語 | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

> Cloudflare 上で完全に動作する、強力でプライバシーに配慮したオープンソースの Web アナリティクスツールです。

デモ: [http://insight-demo.ravelloh.com](http://insight-demo.ravelloh.com/)

![ScreenShot](/.github/screenshot/001.webp)

InsightFlare は Cookie を使用せず、GDPR に準拠した形でアクセスを計測します。独自のスマートトラッキング強度機構が、地域ごとのプライバシー規制に応じて訪問者識別子の保持期間を調整し、データの完全性とプライバシーを両立します。

フロントエンド SDK は gzip 圧縮後およそ 3 KB で、Cloudflare のグローバル CDN から配信されます。カスタムイベント（`data-insightflare-event`）とパフォーマンス指標の追跡を標準で備えています。

多言語ダッシュボードではトラフィックを視覚的に分析できます。地名の多言語翻訳により、世界各地からの訪問者分布を把握しやすくなります。

Cloudflare の無料枠でも、エッジコンピューティングを活用して 1 日あたり 100,000 訪問まで無料で追跡できます。InsightFlare は生の IP アドレスを保存せず、Cloudflare の位置情報解決を利用します。

---

## クイックスタート

以下のボタンをクリックしてください。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare)

Cloudflare がこのリポジトリを複製し、必要なリソースを作成・バインドします。次の 2 つのシークレットを設定してください。

| 名前 | 用途 |
| --- | --- |
| `MAIN_SECRET` | 訪問者ソルト、セッションキー、API キーハッシュの導出に使うルートシークレット |
| `BOOTSTRAP_ADMIN_PASSWORD` | 初期管理者パスワード |

`MAIN_SECRET` には 16 文字を超えるランダム文字列が必要です。[https://random.ravelloh.com/str/32](https://random.ravelloh.com/str/32) で生成できます。

`BOOTSTRAP_ADMIN_PASSWORD` はデフォルトの管理者アカウント（`admin`）のパスワードです。デプロイ完了後にダッシュボードへサインインし、個人設定からユーザー名とパスワードを変更できます。

変数を設定してから約 3 分待つとデプロイが完了します。デフォルト URL は `https://insightflare.<your-cloudflare-username>.workers.dev` です。

## 主な機能

### 多面的なトラフィック分析

![001](/.github/screenshot/001.webp)
![002](/.github/screenshot/002.webp)
![003](/.github/screenshot/003.webp)

### リアルタイム訪問者モニタリング

![004](/.github/screenshot/004.webp)
![005](/.github/screenshot/005.webp)

### ページ別トラフィック分析

![006](/.github/screenshot/006.webp)

### 実ユーザーのパフォーマンス追跡

![007](/.github/screenshot/007.webp)
![008](/.github/screenshot/008.webp)
![009](/.github/screenshot/009.webp)

### 流入元ごとのトラフィック品質比較

![010](/.github/screenshot/010.webp)
![011](/.github/screenshot/011.webp)
![012](/.github/screenshot/012.webp)

### UTM キャンペーンの効果測定

![013](/.github/screenshot/013.webp)
![014](/.github/screenshot/014.webp)

### カスタムイベントの記録と分析

![015](/.github/screenshot/015.webp)
![016](/.github/screenshot/016.webp)
![017](/.github/screenshot/017.webp)

### すべてのセッションを詳しく確認

![018](/.github/screenshot/018.webp)
![019](/.github/screenshot/019.webp)
![020](/.github/screenshot/020.webp)
![021](/.github/screenshot/021.webp)

### すべての訪問者を把握

![022](/.github/screenshot/022.webp)
![023](/.github/screenshot/023.webp)

### リピーターの追跡

![024](/.github/screenshot/024.webp)
![025](/.github/screenshot/025.webp)

### 地理的分布と市場インテリジェンス

![026](/.github/screenshot/026.webp)
![027](/.github/screenshot/027.webp)
![028](/.github/screenshot/028.webp)

### 訪問者デバイスの詳細

![029](/.github/screenshot/029.webp)
![030](/.github/screenshot/030.webp)
![031](/.github/screenshot/031.webp)

### ブラウザーとその機能の把握

![032](/.github/screenshot/032.webp)
![033](/.github/screenshot/033.webp)
![034](/.github/screenshot/034.webp)
![035](/.github/screenshot/035.webp)
![036](/.github/screenshot/036.webp)

### フロントエンド SDK を変更せずに追跡設定を調整

![037](/.github/screenshot/037.webp)
![038](/.github/screenshot/038.webp)

### チームコラボレーションのための設計

![039](/.github/screenshot/039.webp)
![040](/.github/screenshot/040.webp)

### システムの健全性をひと目で確認

![041](/.github/screenshot/041.webp)
![042](/.github/screenshot/042.webp)

### 完全な多言語対応

![043](/.github/screenshot/043.webp)
![044](/.github/screenshot/044.webp)

### 公開共有システム

![045](/.github/screenshot/045.webp)
![046](/.github/screenshot/046.webp)

### 明確にスコープされた API システム

![047](/.github/screenshot/047.webp)

### 定時タスク

![048](/.github/screenshot/048.webp)

### JSON 形式のカスタムイベントを深く分析

![049](/.github/screenshot/049.webp)
![050](/.github/screenshot/050.webp)
![051](/.github/screenshot/051.webp)
![052](/.github/screenshot/052.webp)
![053](/.github/screenshot/053.webp)

### ファネルによる訪問・イベント分析

![054](/.github/screenshot/054.webp)

### 定時または条件付きメール通知

![055](/.github/screenshot/055.webp)
![056](/.github/screenshot/056.webp)
![057](/.github/screenshot/057.webp)

### 多面的なボット対策とリクエスト観測

![058](/.github/screenshot/058.webp)
![059](/.github/screenshot/059.webp)
![060](/.github/screenshot/060.webp)
![061](/.github/screenshot/061.webp)
![062](/.github/screenshot/062.webp)

---

## 高度な設定

### Analytics Engine を有効にして詳細分析を行う

Analytics Engine は InsightFlare のオプションの高スループット分析層です。リクエスト監視と、将来のトラフィック・イベント分析の投影を主データベースから分離します。

- `REQUEST_ANALYTICS` → リクエスト監視と異常トラフィック
- `TRAFFIC_ANALYTICS` → サンプリングされたトラフィック事実
- `EVENT_ANALYTICS` → サンプリングされたカスタムイベント事実

使用するには Analytics Engine を手動で有効にしてください。[Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/workers/analytics-engine) を開き、右側の「Enable」ボタンをクリックします。その後のデプロイ時に、InsightFlare が Analytics Engine を Cloudflare アカウントへ自動的にバインドします。

有効化後、InsightFlare は上記 3 データセットへ書き込みます。現在のバージョンでは「リクエスト監視」ページが新しい `REQUEST_ANALYTICS` データセットを読み取ります。`TRAFFIC_ANALYTICS` と `EVENT_ANALYTICS` は将来の Analytics Engine Provider 用に蓄積されます。データセットの読み取りには API トークンが必要です。システム設定で Cloudflare Account ID と「Account Analytics」の読み取り権限を持つ API トークンを入力してください。Reader 設定は引き続き主データベースの D1 に保存されます。詳細はダッシュボード設定ページの「Guide」ボタンをご覧ください。

### AI エージェントを接続して分析する

InsightFlare は AI エージェント向けの Skills を公開しています。InsightFlare のデプロイを OpenClaw、Codex、Claude Code などのエージェントに接続すると、データへの直接アクセス、分析、レポート作成を行えます。次の指示をエージェントに送り、ドメインを実際の InsightFlare インスタンスに置き換えてください。エージェントが、データアクセス用の専用 API キーをダッシュボードで作成する手順を案内します。

```txt
Read https://<your InsightFlare domain>/.well-known/skills.json, connect to this web analytics system, and guide me through authorization.
```

その後は、たとえば次のように自然言語で質問できます。

```txt
「先月のサイトのパフォーマンスはどうでしたか。アクセス数の多い流入元のうち、訪問者が最も多かったのはどこですか。最も人気のあったページはどれですか。」
```

### Cloudflare 変数で Wrangler 設定を上書きする

Cloudflare のビルド環境では、プロジェクト変数とシークレットで `wrangler.toml` 内のデプロイ環境固有の値を上書きできます。`build:pre` はデプロイ前にこれらの値を読み取り、使用中の Wrangler 設定へ書き込みます。続く `wrangler deploy` は解決済み設定を使用します。

主な変数:

| 名前 | 上書き対象 |
| --- | --- |
| `INSIGHTFLARE_WORKER_NAME` | Worker 名 |
| `INSIGHTFLARE_D1_DATABASE` | D1 データベース名 |
| `INSIGHTFLARE_D1_DATABASE_ID` | `DB` バインディングの D1 データベース ID |
| `INSIGHTFLARE_SITE_SETTINGS_KV_ID` | `SITE_SETTINGS_KV` の KV 名前空間 ID |
| `INSIGHTFLARE_ARCHIVE_BUCKET_NAME` | `ARCHIVE_BUCKET` の R2 バケット |
| `INSIGHTFLARE_ARCHIVE_PREVIEW_BUCKET_NAME` | R2 プレビュー用バケット |
| `SESSION_WINDOW_MINUTES` | セッションウィンドウ（分） |
| `SCRIPT_CACHE_TTL_SECONDS` | `/script.js` の CDN キャッシュ TTL |
| `PARQUET_WASM_URL` | Parquet WASM の URL |
| `INSIGHTFLARE_EDGE_URL` | InsightFlare サービスのベース URL |

`INSIGHTFLARE_VAR_<NAME>` により、任意の `[vars]` エントリも設定できます。たとえば `INSIGHTFLARE_VAR_FEATURE_FLAG=1` は `FEATURE_FLAG = "1"` になります。`--env production` でデプロイする場合、`INSIGHTFLARE_PRODUCTION_D1_DATABASE_ID` や `INSIGHTFLARE_PRODUCTION_VAR_INSIGHTFLARE_EDGE_URL` のような環境固有の名前は `[env.production]` を対象にします。

### コールドアーカイブ用の R2 バケットを設定する

R2 へのコールドアーカイブを有効にする場合にのみ、R2 バケットを手動で作成する必要があります。既定ではトラフィックデータを 1 年間保持します。期限切れのデータは圧縮して保存されるため傾向やデータを表示できますが、フィルタリングはできません。R2 は任意であり、Deploy Button では既定で R2 バインディングを必要としません。R2 を有効にすると、1 年より古いデータに対して詳細なクエリを実行できます。

Cloudflare で `insightflare-archive` という名前のバケットを作成し、次のように `wrangler.toml` の `[[r2_buckets]]` を有効化してください。

```toml
[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "insightflare-archive"
preview_bucket_name = "insightflare-archive-preview"
```

### 最新の状態を保つ

InsightFlare には GitHub App を利用した自動更新システムが組み込まれており、簡単に最新バージョンへ更新できます。

デプロイを最新に保つ手順は 2 つだけです。

1. リポジトリ用の GitHub App をインストールします。必要なのは一度だけです。**InsightFlare をデプロイしたリポジトリだけを選択してください**: [Install InsightFlare Sync](https://github.com/apps/insightflare-sync/installations/new)
2. アップストリームに更新があると、リポジトリに PR が自動作成されます。その PR をマージするだけです。

_自分のプロジェクトにも同期しやすい仕組みを導入したい場合: [RavelloH/upstream-sync-bot](https://github.com/RavelloH/upstream-sync-bot)（オープンソーステンプレート）+ [RavelloH/InsightFlare-Bot](https://github.com/RavelloH/InsightFlare-Bot)（本プロジェクトの Bot インスタンス）を参照してください。_

### カスタムイベントの送信

InsightFlare のフロントエンド SDK は、手動呼び出しと DOM 属性による自動送信の両方をサポートします。

#### 手動呼び出し

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

利用できるメソッド:

- `track(eventName, eventData?)`: カスタムイベントを送信します。
- `trackOnce(eventName, eventData?)`: 現在のページライフサイクルで、同じイベント名を一度だけ送信します。
- `setGlobalProperties(props)`: 以降のイベントに共通プロパティを追加します。
- `clearGlobalProperties()`: 共通プロパティをクリアします。

#### DOM 属性による自動送信

```html
<!-- 1. 既定のクリックトリガー -->
<button data-insightflare-event="signup_click">今すぐ登録</button>
<!-- 送信内容: { eventName: "signup_click" } -->

<!-- 2. data-insightflare-event-* で追加フィールドを渡すクリックトリガー -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-plan="pro"
  data-insightflare-event-source="pricing"
>
  今すぐ登録
</button>
<!-- 送信内容: { eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 3. JSON の追加フィールドを持つクリックトリガー -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-data='{"plan":"pro","source":"pricing"}'
>
  今すぐ登録
</button>
<!-- 送信内容: { eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 4. フォーム送信トリガー -->
<form
  data-insightflare-event="contact_submit"
  data-insightflare-event-trigger="submit"
  data-insightflare-event-data='{"plan":"pro","source":"landing"}'
>
  ...
</form>

<!-- 5. 要素がビューポートに入ったとき一度だけ発火 -->
<section
  data-insightflare-event="pricing_viewed"
  data-insightflare-event-trigger="enterviewport"
  data-insightflare-event-plan="pro"
>
  ...
</section>
```

## 技術スタック

| レイヤー | 技術 |
| --- | --- |
| フロントエンド | TanStack Start 1、TanStack Router、Vite 8、React 19、Tailwind CSS 4、Radix UI、shadcn、Recharts、deck.gl、maplibre-gl、Motion |
| バックエンド | Cloudflare Workers、Durable Objects、D1、R2、KV |
| ビルド | Cloudflare Vite Plugin、Wrangler 4、TypeScript 5 |

---

## 手動デプロイ

デプロイボタンを使用しない場合は、次の手順でデプロイします。

1. このリポジトリを GitHub アカウントへ fork または clone します。
2. Cloudflare で D1 データベース、KV 名前空間、必要に応じて R2 バケットを作成します。
3. `wrangler.toml` を編集し、D1 と KV を Worker にバインドします。
4. `.dev.vars.example` を参照して環境変数を設定します。
5. Worker の画面からこのリポジトリをインポートします。

### ローカル開発

1. `git clone https://github.com/RavelloH/InsightFlare`
2. `npm install`
3. `npm run db:migrate:local`
4. `.dev.vars.example` を参照して環境変数を設定します。
5. `npm run dev`

`npm run dev:ui` はデモモードで Vite 開発サーバーを起動します。通常の `npm run dev` でデモモードを有効にするには、`DEMO_MODE=1` を設定してください。

## 主なコマンド

| コマンド | 説明 |
| --- | --- |
| `npm run dev` | Vite と Cloudflare Workers によるローカル開発 |
| `npm run dev:ui` | デモモードでダッシュボード開発サーバーを起動 |
| `npm run build` | Cloudflare 管理ビルドのエントリポイント |
| `npm run build:local` | ローカル事前確認、D1 マイグレーション、ビルド |
| `npm run build:demo` | リソースバインドなしのデモビルド |
| `npm run deploy` | Cloudflare 管理デプロイのエントリポイント |
| `npm run publish` | 許可された Cloudflare 環境からビルドして公開 |
| `npm run check` | format と lint を自動修正してから、build、型、i18n、テスト、仕様をチェック |
| `npm run check:verify` | 自動修正なしで完全なチェックを実行 |
| `npm run typecheck` | TypeScript の型チェック |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm run check:i18n` | 翻訳キーの完全性を検証 |

---

## 主要設定

| 名前 | 意味 |
| --- | --- |
| `SESSION_WINDOW_MINUTES` | セッションウィンドウ（既定値 `30` 分） |
| `SCRIPT_CACHE_TTL_SECONDS` | `/script.js` の CDN キャッシュ TTL |
| `PARQUET_WASM_URL` | Parquet WASM のダウンロード URL |
| `INSIGHTFLARE_EDGE_URL` | InsightFlare サービスのベース URL |
| `MAIN_SECRET`（Secret） | ルートシークレット |
| `BOOTSTRAP_ADMIN_PASSWORD`（Secret） | 初期管理者パスワード |
| `DAILY_SALT_SECRET`（Secret） | `MAIN_SECRET` の旧来フォールバック |
| `DASHBOARD_SESSION_SECRET`（Secret） | 任意のセッション署名オーバーライド |

---

## ライセンス

[MIT](/LICENSE) Copyright 2026 RavelloH
