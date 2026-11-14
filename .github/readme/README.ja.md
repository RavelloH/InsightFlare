<div align="center">

# InsightFlare

### 分析データは自分のもの。Cloudflare 上でセルフホスト。

プライバシーに配慮したオープンソース Web アナリティクス。リアルタイム分析、訪問経路、ファネル、AI エージェント連携をひとつに。

[**ライブデモ**](https://insight-demo.ravelloh.com/) &nbsp;·&nbsp; [**Cloudflare にデプロイ**](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare) &nbsp;·&nbsp; [**ソースコード**](https://github.com/RavelloH/InsightFlare)

[![GitHub stars](https://img.shields.io/github/stars/RavelloH/InsightFlare?style=flat-square&logo=github)](https://github.com/RavelloH/InsightFlare/stargazers) [![Latest release](https://img.shields.io/github/v/release/RavelloH/InsightFlare?style=flat-square)](https://github.com/RavelloH/InsightFlare/releases) [![License: MIT](https://img.shields.io/github/license/RavelloH/InsightFlare?style=flat-square)](/LICENSE)

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | 日本語 | [中文（台灣）](/.github/readme/README.zh-tw.md) | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

</div>

<a href="https://insight-demo.ravelloh.com/"><img src="/.github/screenshot/001.webp" alt="InsightFlare analytics dashboard" width="100%"></a>

## InsightFlare を選ぶ理由

ページビュー数だけでは見えない訪問者の行動を把握。InsightFlare は自分の Cloudflare アカウント上で動作し、トラフィック分析、行動分析、運用状況をひとつのダッシュボードにまとめます。

- **インフラもデータも自分で管理。** Cloudflare Workers、D1、Durable Objects 上にセルフホスト。別の分析 SaaS アカウントは不要です。
- **訪問者の行動を理解。** セッション、訪問経路、ファネル、カスタムイベント、UTM、流入元の品質を分析します。
- **リアルタイムで状況を把握。** 現在のアクセス、パフォーマンス、地域、ブラウザー、デバイスを確認できます。
- **不要なトラフィックを見分ける。** ボット対策と異常リクエストの観測機能を備えています。
- **AI エージェントと連携。** Skills エンドポイントと権限付き API を通じて自然言語で分析できます。
- **小さく始めて拡張。** ワンクリックデプロイ、複数サイト・チーム、任意の R2 アーカイブに対応します。

**プライバシーと料金：** トラッカーは Cookie を使用しない設計で、生の IP アドレスを保存しません。法令への適合性と Cloudflare の利用料金は、設定・トラフィック・地域によって異なります。

## ダッシュボードのプレビュー

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" alt="リアルタイム" width="100%"><br><strong>リアルタイム</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" alt="訪問セッション" width="100%"><br><strong>訪問セッション</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" alt="イベントファネル" width="100%"><br><strong>イベントファネル</strong></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" alt="流入元分析" width="100%"><br><strong>流入元分析</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" alt="地域分布" width="100%"><br><strong>地域分布</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" alt="ボット観測" width="100%"><br><strong>ボット観測</strong></a></td>
  </tr>
</table>

## すべての機能をプレビュー

### トラフィック概要と流入元

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/001.webp"><img src="/.github/screenshot/001.webp" width="100%" alt="多面的なトラフィック分析" title="多面的なトラフィック分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/002.webp"><img src="/.github/screenshot/002.webp" width="100%" alt="多面的なトラフィック分析" title="多面的なトラフィック分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/003.webp"><img src="/.github/screenshot/003.webp" width="100%" alt="多面的なトラフィック分析" title="多面的なトラフィック分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" width="100%" alt="リアルタイム訪問者モニタリング" title="リアルタイム訪問者モニタリング"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/005.webp"><img src="/.github/screenshot/005.webp" width="100%" alt="リアルタイム訪問者モニタリング" title="リアルタイム訪問者モニタリング"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/006.webp"><img src="/.github/screenshot/006.webp" width="100%" alt="ページ別トラフィック分析" title="ページ別トラフィック分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/007.webp"><img src="/.github/screenshot/007.webp" width="100%" alt="実ユーザーのパフォーマンス追跡" title="実ユーザーのパフォーマンス追跡"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/008.webp"><img src="/.github/screenshot/008.webp" width="100%" alt="実ユーザーのパフォーマンス追跡" title="実ユーザーのパフォーマンス追跡"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/009.webp"><img src="/.github/screenshot/009.webp" width="100%" alt="実ユーザーのパフォーマンス追跡" title="実ユーザーのパフォーマンス追跡"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" width="100%" alt="流入元ごとのトラフィック品質比較" title="流入元ごとのトラフィック品質比較"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/011.webp"><img src="/.github/screenshot/011.webp" width="100%" alt="流入元ごとのトラフィック品質比較" title="流入元ごとのトラフィック品質比較"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/012.webp"><img src="/.github/screenshot/012.webp" width="100%" alt="流入元ごとのトラフィック品質比較" title="流入元ごとのトラフィック品質比較"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/013.webp"><img src="/.github/screenshot/013.webp" width="100%" alt="UTM キャンペーンの効果測定" title="UTM キャンペーンの効果測定"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/014.webp"><img src="/.github/screenshot/014.webp" width="100%" alt="UTM キャンペーンの効果測定" title="UTM キャンペーンの効果測定"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### イベント・セッション・訪問経路

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/015.webp"><img src="/.github/screenshot/015.webp" width="100%" alt="カスタムイベントの記録と分析" title="カスタムイベントの記録と分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/016.webp"><img src="/.github/screenshot/016.webp" width="100%" alt="カスタムイベントの記録と分析" title="カスタムイベントの記録と分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/017.webp"><img src="/.github/screenshot/017.webp" width="100%" alt="カスタムイベントの記録と分析" title="カスタムイベントの記録と分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" width="100%" alt="すべてのセッションを詳しく確認" title="すべてのセッションを詳しく確認"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/019.webp"><img src="/.github/screenshot/019.webp" width="100%" alt="すべてのセッションを詳しく確認" title="すべてのセッションを詳しく確認"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/020.webp"><img src="/.github/screenshot/020.webp" width="100%" alt="すべてのセッションを詳しく確認" title="すべてのセッションを詳しく確認"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/021.webp"><img src="/.github/screenshot/021.webp" width="100%" alt="すべてのセッションを詳しく確認" title="すべてのセッションを詳しく確認"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/022.webp"><img src="/.github/screenshot/022.webp" width="100%" alt="すべての訪問者を把握" title="すべての訪問者を把握"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/023.webp"><img src="/.github/screenshot/023.webp" width="100%" alt="すべての訪問者を把握" title="すべての訪問者を把握"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/024.webp"><img src="/.github/screenshot/024.webp" width="100%" alt="リピーターの追跡" title="リピーターの追跡"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/025.webp"><img src="/.github/screenshot/025.webp" width="100%" alt="リピーターの追跡" title="リピーターの追跡"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### ユーザー・端末・地域分析

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" width="100%" alt="地理的分布と市場インテリジェンス" title="地理的分布と市場インテリジェンス"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/027.webp"><img src="/.github/screenshot/027.webp" width="100%" alt="地理的分布と市場インテリジェンス" title="地理的分布と市場インテリジェンス"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/028.webp"><img src="/.github/screenshot/028.webp" width="100%" alt="地理的分布と市場インテリジェンス" title="地理的分布と市場インテリジェンス"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/029.webp"><img src="/.github/screenshot/029.webp" width="100%" alt="訪問者デバイスの詳細" title="訪問者デバイスの詳細"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/030.webp"><img src="/.github/screenshot/030.webp" width="100%" alt="訪問者デバイスの詳細" title="訪問者デバイスの詳細"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/031.webp"><img src="/.github/screenshot/031.webp" width="100%" alt="訪問者デバイスの詳細" title="訪問者デバイスの詳細"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/032.webp"><img src="/.github/screenshot/032.webp" width="100%" alt="ブラウザーとその機能の把握" title="ブラウザーとその機能の把握"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/033.webp"><img src="/.github/screenshot/033.webp" width="100%" alt="ブラウザーとその機能の把握" title="ブラウザーとその機能の把握"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/034.webp"><img src="/.github/screenshot/034.webp" width="100%" alt="ブラウザーとその機能の把握" title="ブラウザーとその機能の把握"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/035.webp"><img src="/.github/screenshot/035.webp" width="100%" alt="ブラウザーとその機能の把握" title="ブラウザーとその機能の把握"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/036.webp"><img src="/.github/screenshot/036.webp" width="100%" alt="ブラウザーとその機能の把握" title="ブラウザーとその機能の把握"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 設定・チーム・共有

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/037.webp"><img src="/.github/screenshot/037.webp" width="100%" alt="フロントエンド SDK を変更せずに追跡設定を調整" title="フロントエンド SDK を変更せずに追跡設定を調整"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/038.webp"><img src="/.github/screenshot/038.webp" width="100%" alt="フロントエンド SDK を変更せずに追跡設定を調整" title="フロントエンド SDK を変更せずに追跡設定を調整"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/039.webp"><img src="/.github/screenshot/039.webp" width="100%" alt="チームコラボレーションのための設計" title="チームコラボレーションのための設計"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/040.webp"><img src="/.github/screenshot/040.webp" width="100%" alt="チームコラボレーションのための設計" title="チームコラボレーションのための設計"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/041.webp"><img src="/.github/screenshot/041.webp" width="100%" alt="システムの健全性をひと目で確認" title="システムの健全性をひと目で確認"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/042.webp"><img src="/.github/screenshot/042.webp" width="100%" alt="システムの健全性をひと目で確認" title="システムの健全性をひと目で確認"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/043.webp"><img src="/.github/screenshot/043.webp" width="100%" alt="完全な多言語対応" title="完全な多言語対応"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/044.webp"><img src="/.github/screenshot/044.webp" width="100%" alt="完全な多言語対応" title="完全な多言語対応"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/045.webp"><img src="/.github/screenshot/045.webp" width="100%" alt="公開共有システム" title="公開共有システム"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/046.webp"><img src="/.github/screenshot/046.webp" width="100%" alt="公開共有システム" title="公開共有システム"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/047.webp"><img src="/.github/screenshot/047.webp" width="100%" alt="明確にスコープされた API システム" title="明確にスコープされた API システム"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/048.webp"><img src="/.github/screenshot/048.webp" width="100%" alt="定時タスク" title="定時タスク"></a></td>
  </tr>
</table>

### イベントの詳細分析とファネル

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/049.webp"><img src="/.github/screenshot/049.webp" width="100%" alt="JSON 形式のカスタムイベントを深く分析" title="JSON 形式のカスタムイベントを深く分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/050.webp"><img src="/.github/screenshot/050.webp" width="100%" alt="JSON 形式のカスタムイベントを深く分析" title="JSON 形式のカスタムイベントを深く分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/051.webp"><img src="/.github/screenshot/051.webp" width="100%" alt="JSON 形式のカスタムイベントを深く分析" title="JSON 形式のカスタムイベントを深く分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/052.webp"><img src="/.github/screenshot/052.webp" width="100%" alt="JSON 形式のカスタムイベントを深く分析" title="JSON 形式のカスタムイベントを深く分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/053.webp"><img src="/.github/screenshot/053.webp" width="100%" alt="JSON 形式のカスタムイベントを深く分析" title="JSON 形式のカスタムイベントを深く分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" width="100%" alt="ファネルによる訪問・イベント分析" title="ファネルによる訪問・イベント分析"></a></td>
  </tr>
</table>

### 運用監視・通知・ボット対策

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/055.webp"><img src="/.github/screenshot/055.webp" width="100%" alt="定時または条件付きメール通知" title="定時または条件付きメール通知"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/056.webp"><img src="/.github/screenshot/056.webp" width="100%" alt="定時または条件付きメール通知" title="定時または条件付きメール通知"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/057.webp"><img src="/.github/screenshot/057.webp" width="100%" alt="定時または条件付きメール通知" title="定時または条件付きメール通知"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" width="100%" alt="多面的なボット対策とリクエスト観測" title="多面的なボット対策とリクエスト観測"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/059.webp"><img src="/.github/screenshot/059.webp" width="100%" alt="多面的なボット対策とリクエスト観測" title="多面的なボット対策とリクエスト観測"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/060.webp"><img src="/.github/screenshot/060.webp" width="100%" alt="多面的なボット対策とリクエスト観測" title="多面的なボット対策とリクエスト観測"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/061.webp"><img src="/.github/screenshot/061.webp" width="100%" alt="多面的なボット対策とリクエスト観測" title="多面的なボット対策とリクエスト観測"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/062.webp"><img src="/.github/screenshot/062.webp" width="100%" alt="多面的なボット対策とリクエスト観測" title="多面的なボット対策とリクエスト観測"></a></td>
    <td width="33%"></td>
  </tr>
</table>

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

既存の管理者アカウントにサインインできない場合、`BOOTSTRAP_ADMIN_PASSWORD` を変更してもそのアカウントのパスワードはリセットされません。[セルフホスト版の管理者パスワード復旧ガイド](../../docs/password-recovery.md)に従って、リモート D1 を使用して安全にリセットしてください。

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

#### ユーザー識別

`identify` を使うと、匿名の訪問者境界を変えずに現在の訪問をログインユーザーへ関連付けられます。

```html
<script>
  window.insightflare.identify("user-123", { name: "Alice" });
</script>
```

ログイン後に `identify` を呼び出すと、現在および以後の訪問をユーザー単位で分析できます。最初のページビューより前に呼び出すこともできます。ログアウト時は `reset()` を呼び出して現在の識別情報を終了し、新しい匿名訪問者境界を作成して、以後のイベントが以前のアカウントを引き継がないようにします。

```js
window.insightflare.reset();
window.insightflare.identify("user-456", { name: "Bob" });
```

アカウントを切り替える前に `reset()` を呼び出してください。`identify("user-456")` だけでは新しい訪問者境界は作成されません。

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
2. `pnpm install`
3. `pnpm run db:migrate:local`
4. `.dev.vars.example` を参照して環境変数を設定します。
5. `pnpm run dev`

`pnpm run dev:ui` はデモモードで Vite 開発サーバーを起動します。通常の `pnpm run dev` でデモモードを有効にするには、`DEMO_MODE=1` を設定してください。

## 主なコマンド

| コマンド | 説明 |
| --- | --- |
| `pnpm run dev` | Vite と Cloudflare Workers によるローカル開発 |
| `pnpm run dev:ui` | デモモードでダッシュボード開発サーバーを起動 |
| `pnpm run build` | Cloudflare 管理ビルドのエントリポイント |
| `pnpm run build:local` | ローカル事前確認、D1 マイグレーション、ビルド |
| `pnpm run build:demo` | リソースバインドなしのデモビルド |
| `pnpm run deploy` | Cloudflare 管理デプロイのエントリポイント |
| `pnpm run publish` | 許可された Cloudflare 環境からビルドして公開 |
| `pnpm run check` | format と lint を自動修正してから、build、型、i18n、テスト、仕様をチェック |
| `pnpm run check:verify` | 自動修正なしで完全なチェックを実行 |
| `pnpm run typecheck` | TypeScript の型チェック |
| `pnpm run lint` / `lint:fix` | ESLint |
| `pnpm run format` / `format:check` | Prettier |
| `pnpm run check:i18n` | 翻訳キーの完全性を検証 |

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
