import jetBrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import { sha256 } from "@noble/hashes/sha2.js";

import type { Locale } from "@/lib/i18n/config";
import { BREAKDOWN_CLIENT_FRAGMENT } from "@/lib/widgets/breakdown-client-fragment";
import type { WidgetConfig, WidgetData } from "@/lib/widgets/contract";
import { GEO_CLIENT_FRAGMENT } from "@/lib/widgets/geo-client-fragment";
import { GEO_LAND_DOTS } from "@/lib/widgets/geo-data";
import { WIDGET_PALETTE_CSS } from "@/lib/widgets/palette";
import { REALTIME_CLIENT_FRAGMENT } from "@/lib/widgets/realtime-client-fragment";

interface RenderWidgetDocumentInput {
  uuid: string;
  config: WidgetConfig;
  themeOverride?: "light" | "dark";
  localeOverride?: Locale;
  /** Trusted, normalized origin of the selected site, for optional page links. */
  siteOrigin?: string | null;
  previewData?: WidgetData | null;
  preview?: boolean;
  /** Report the preview's actual rendered height to its parent iframe. */
  autoHeight?: boolean;
  revision?: number;
}

type WidgetPlaceholderStatus =
  "not-found" | "unpublished" | "domain-denied" | "unavailable";

interface EmbedMessages {
  loading: string;
  loadFailed: string;
  previewDataUnavailable: string;
  noData: string;
  retry: string;
  reload: string;
  configurationChanged: string;
  notFound: string;
  unpublished: string;
  domainDenied: string;
  updated: string;
  percentageChange: string;
  chartDescription: string;
  notFoundTitle: string;
  notFoundDescription: string;
  unpublishedTitle: string;
  unpublishedDescription: string;
  domainDeniedTitle: string;
  domainDeniedDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  visitors: string;
  views: string;
  sessions: string;
  bounces: string;
  bounceRate: string;
  avgDurationMs: string;
  viewsPerSession: string;
  events: string;
  conversionRate: string;
  conversions: string;
  categoryShare: string;
  geoMapLabel: string;
  liveOnline: string;
  last30m: string;
  now: string;
  noActivePages: string;
  pagePath: string;
  sourceDomain: string;
  country: string;
  period7d: string;
  period30d: string;
}

const MESSAGES: Readonly<Record<Locale, EmbedMessages>> = {
  en: {
    loading: "Loading analytics…",
    loadFailed: "This widget could not be loaded.",
    previewDataUnavailable: "Preview data is not available.",
    noData: "No data for this period",
    retry: "Try again",
    reload: "Reload widget",
    configurationChanged: "This widget was updated. Reload to continue.",
    notFound: "This widget is unavailable or may have been removed.",
    unpublished: "This widget has been taken down.",
    domainDenied: "This website is not allowed to embed this widget.",
    updated: "Updated",
    percentageChange: "Change from the previous period",
    chartDescription: "Analytics trend",
    notFoundTitle: "Widget not found",
    notFoundDescription: "This widget is unavailable or may have been removed.",
    unpublishedTitle: "Widget taken down",
    unpublishedDescription: "The publisher has taken this widget down.",
    domainDeniedTitle: "Embedding is restricted",
    domainDeniedDescription:
      "This website is not allowed to embed this widget.",
    unavailableTitle: "Widget unavailable",
    unavailableDescription: "Try again in a moment.",
    visitors: "Visitors",
    views: "Page views",
    sessions: "Sessions",
    bounces: "Bounces",
    bounceRate: "Bounce rate",
    avgDurationMs: "Avg. duration",
    viewsPerSession: "Views / session",
    events: "Events",
    conversionRate: "Conversion rate",
    conversions: "Conversions",
    categoryShare: "Share of displayed traffic",
    geoMapLabel: "Country and region distribution map",
    liveOnline: "visitors online",
    last30m: "Last 30 minutes",
    now: "Now",
    noActivePages: "No currently popular pages",
    pagePath: "Top pages",
    sourceDomain: "Top sources",
    country: "Top countries",
    period7d: "Last 7 days",
    period30d: "Last 30 days",
  },
  zh: {
    loading: "正在加载分析数据…",
    loadFailed: "无法加载此小组件。",
    previewDataUnavailable: "预览数据暂不可用。",
    noData: "此周期暂无数据",
    retry: "重试",
    reload: "重新加载小组件",
    configurationChanged: "此小组件已更新，请重新加载。",
    notFound: "此小组件不可用或已被删除。",
    unpublished: "此小组件已下架。",
    domainDenied: "此网站无权嵌入该小组件。",
    updated: "更新于",
    percentageChange: "与上一周期相比",
    chartDescription: "分析趋势",
    notFoundTitle: "找不到小组件",
    notFoundDescription: "此小组件不可用或已被删除。",
    unpublishedTitle: "小组件已下架",
    unpublishedDescription: "发布者已将此小组件下架。",
    domainDeniedTitle: "嵌入受限",
    domainDeniedDescription: "此网站无权嵌入该小组件。",
    unavailableTitle: "小组件暂不可用",
    unavailableDescription: "请稍后重试。",
    visitors: "访客数",
    views: "浏览量",
    sessions: "会话数",
    bounces: "跳出次数",
    bounceRate: "跳出率",
    avgDurationMs: "平均停留时长",
    viewsPerSession: "每次会话浏览量",
    events: "事件数",
    conversionRate: "转化率",
    conversions: "转化次数",
    categoryShare: "已显示流量的占比",
    geoMapLabel: "国家或地区的访客分布地图",
    liveOnline: "人在线",
    last30m: "近 30 分钟",
    now: "现在",
    noActivePages: "暂无活跃页面",
    pagePath: "热门页面",
    sourceDomain: "热门来源",
    country: "热门国家或地区",
    period7d: "最近 7 天",
    period30d: "最近 30 天",
  },
  "zh-tw": {
    loading: "正在載入分析資料…",
    loadFailed: "無法載入此小工具。",
    previewDataUnavailable: "預覽資料暫時無法使用。",
    noData: "此期間沒有資料",
    retry: "重試",
    reload: "重新載入小工具",
    configurationChanged: "此小工具已更新，請重新載入。",
    notFound: "此小工具無法使用或已遭移除。",
    unpublished: "此小工具已下架。",
    domainDenied: "此網站未獲准嵌入這個小工具。",
    updated: "更新於",
    percentageChange: "與上一期間相比",
    chartDescription: "分析趨勢",
    notFoundTitle: "找不到小工具",
    notFoundDescription: "此小工具無法使用或已遭移除。",
    unpublishedTitle: "小工具已下架",
    unpublishedDescription: "發布者已將此小工具下架。",
    domainDeniedTitle: "嵌入受到限制",
    domainDeniedDescription: "此網站未獲准嵌入這個小工具。",
    unavailableTitle: "小工具暫時無法使用",
    unavailableDescription: "請稍後再試。",
    visitors: "訪客數",
    views: "瀏覽量",
    sessions: "工作階段數",
    bounces: "跳出次數",
    bounceRate: "跳出率",
    avgDurationMs: "平均停留時間",
    viewsPerSession: "每次工作階段瀏覽量",
    events: "事件數",
    conversionRate: "轉換率",
    conversions: "轉換次數",
    categoryShare: "已顯示流量的佔比",
    geoMapLabel: "國家或地區的訪客分布地圖",
    liveOnline: "人在線",
    last30m: "最近 30 分鐘",
    now: "現在",
    noActivePages: "目前沒有活躍頁面",
    pagePath: "熱門頁面",
    sourceDomain: "熱門來源",
    country: "熱門國家或地區",
    period7d: "最近 7 天",
    period30d: "最近 30 天",
  },
  ja: {
    loading: "分析データを読み込み中…",
    loadFailed: "このウィジェットを読み込めませんでした。",
    previewDataUnavailable: "プレビュー用データがありません。",
    noData: "この期間のデータはありません",
    retry: "再試行",
    reload: "ウィジェットを再読み込み",
    configurationChanged:
      "ウィジェットが更新されました。再読み込みしてください。",
    notFound: "このウィジェットは利用できないか、削除されています。",
    unpublished: "このウィジェットは公開停止中です。",
    domainDenied: "このウェブサイトではこのウィジェットを埋め込めません。",
    updated: "更新",
    percentageChange: "前の期間との比較",
    chartDescription: "分析の推移",
    notFoundTitle: "ウィジェットが見つかりません",
    notFoundDescription: "このウィジェットは利用できないか、削除されています。",
    unpublishedTitle: "ウィジェットは公開停止中です",
    unpublishedDescription: "公開者がこのウィジェットを停止しました。",
    domainDeniedTitle: "埋め込みが制限されています",
    domainDeniedDescription:
      "このウェブサイトではこのウィジェットを埋め込めません。",
    unavailableTitle: "ウィジェットを利用できません",
    unavailableDescription: "しばらくしてからもう一度お試しください。",
    visitors: "訪問者数",
    views: "ページビュー",
    sessions: "セッション数",
    bounces: "直帰数",
    bounceRate: "直帰率",
    avgDurationMs: "平均滞在時間",
    viewsPerSession: "セッションあたりのPV",
    events: "イベント数",
    conversionRate: "コンバージョン率",
    conversions: "コンバージョン数",
    categoryShare: "表示されたトラフィックに占める割合",
    geoMapLabel: "国・地域別の分布マップ",
    liveOnline: "人がオンライン",
    last30m: "過去30分間",
    now: "現在",
    noActivePages: "閲覧中のページはありません",
    pagePath: "人気ページ",
    sourceDomain: "主な参照元",
    country: "主な国・地域",
    period7d: "過去7日間",
    period30d: "過去30日間",
  },
};

const STYLE = String.raw`
@font-face {
  font-family: "JetBrains Mono Variable";
  src: url("${jetBrainsMonoLatinUrl}") format("woff2");
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
}
:root {
  color-scheme: light dark;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --primary: oklch(0.6 0.13 163);
  --radius: 0;
  font-family:
    "JetBrains Mono Variable",
    "JetBrains Mono",
    "Cascadia Mono",
    Consolas,
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    ui-monospace,
    monospace;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:root[data-theme="light"] {
  color-scheme: light;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --border: oklch(1 0 0 / 10%);
  --primary: oklch(0.7 0.15 162);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --border: oklch(1 0 0 / 10%);
    --primary: oklch(0.7 0.15 162);
  }
}
* {
  box-sizing: border-box;
}
html,
body {
  width: 100%;
  min-width: 0;
  min-height: 100%;
  margin: 0;
}
body {
  color: var(--foreground);
  background: transparent;
}
button {
  color: inherit;
  font: inherit;
}
.widget {
  width: 100%;
  min-height: 100%;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--background);
  color: var(--foreground);
}
.widget__inner {
  min-height: 100%;
  padding: 0.875rem 1rem 1rem;
}
.widget__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.widget__title {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 0.8125rem;
  font-weight: 620;
  line-height: 1.45;
  letter-spacing: -0.01em;
}
.widget__period {
  flex: none;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  line-height: 1.4;
  text-align: right;
}
.widget__content {
  min-height: 3.5rem;
  margin-top: 0.75rem;
}
.widget__content:empty,
.widget__status[hidden] {
  display: none;
}
.widget__value-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
}
.widget__value {
  font-size: clamp(2rem, 11vw, 2.5rem);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  letter-spacing: -0.055em;
  line-height: 1.08;
}
.widget__unit {
  color: var(--muted-foreground);
  font-size: 0.6875rem;
}
.widget__change {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.widget__change[data-direction="up"] {
  color: var(--primary);
}
.widget__change[data-direction="down"] {
  color: oklch(0.58 0.22 27);
}
.widget__chart {
  display: block;
  width: 100%;
  height: 7.625rem;
  overflow: visible;
}
.widget__chart-grid {
  stroke: var(--border);
  stroke-width: 1;
}
.widget__chart-line {
  fill: none;
  stroke: var(--primary);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.5;
}
.widget__chart-area {
  fill: var(--primary);
  opacity: 0.1;
}
.widget__chart-labels {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
}
.widget__trend-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: stretch;
  gap: 0.5rem;
}
.widget__axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  color: var(--muted-foreground);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}
.widget__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.widget__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  min-width: 0;
}
.widget__ranked-label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.625rem;
}
.widget__rank {
  display: grid;
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  place-items: center;
  border-radius: 0;
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}
.widget__label.widget__path-link { color:var(--primary);text-decoration:none;text-underline-offset:3px; }
.widget__path-link:hover { text-decoration:underline; }
.widget__path-link:focus-visible { outline:2px solid var(--primary);outline-offset:2px; }
.widget__label {
  overflow: hidden;
  color: var(--foreground);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.widget__count {
  color: var(--muted-foreground);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.widget__bar-list,.widget__distribution-list { display:grid;gap:.65rem;margin:0;padding:0;list-style:none; }
.widget__bar-labels { display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-width:0;margin-bottom:.25rem; }
.widget__bar-track { width:100%;height:.375rem;background:var(--muted); }
.widget__bar-fill { height:100%;background:var(--primary);transition:width .22s ease; }
.widget__bar-number,.widget__bar-percentage { flex:none;color:var(--muted-foreground);font-size:.7rem;font-variant-numeric:tabular-nums; }
.widget__legend { display:flex;flex-wrap:wrap;gap:.5rem .85rem;margin:0 0 .625rem; }
.widget__legend-item { display:flex;align-items:center;gap:.375rem;color:var(--muted-foreground);font-size:.6875rem; }
.widget__legend-swatch { width:.875rem;height:.1875rem;background:var(--primary); }
.widget__secondary { color:var(--muted-foreground);font-size:.75rem; }

.widget__donut-wrap { display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:1rem;min-width:0; }
.widget__donut-ring { display:block;flex:none;width:112px;height:112px;overflow:visible; }
.widget__donut-total { font-size:17px;font-weight:650;fill:var(--foreground);font-family:"JetBrains Mono Variable",monospace; }
.widget__donut-caption { font-size:9px;fill:var(--muted-foreground); }
.widget__breakdown-legend { display:grid;flex:1 1 120px;gap:.45rem;min-width:0;margin:0;padding:0;list-style:none; }
.widget__breakdown-row { display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-width:0;font-size:.6875rem; }
.widget__breakdown-name { display:inline-flex;align-items:center;gap:.4rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground); }
.widget__breakdown-name span:last-child { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.widget__breakdown-swatch { width:.5rem;height:.5rem;flex:none; }
.widget__breakdown-value { flex:none;color:var(--foreground);font-variant-numeric:tabular-nums;white-space:nowrap; }
.widget__ratio-track { display:flex;height:1rem;width:100%;overflow:hidden;background:var(--muted); }
.widget__ratio-segment { display:block;flex:none;height:100%;transition:width .25s ease-out; }
.widget__ratio-layout { display:grid;gap:.85rem;min-width:0; }
.widget__ratio-layout .widget__breakdown-legend { grid-template-columns:repeat(auto-fit,minmax(min(100%,125px),1fr));gap:.55rem 1rem; }
@media (prefers-reduced-motion:reduce) { .widget__ratio-segment { transition:none; } }

.widget__geo-map { position:relative;width:100%;height:182px;min-width:0;overflow:hidden; }
.widget[data-geo-projection="globe"] .widget__geo-map { height:208px; }
.widget__geo-canvas { display:block;width:100%;height:100%;touch-action:pan-y; }
.widget__geo-tooltip { position:absolute;z-index:2;pointer-events:none;transform:translate(-50%,-100%);max-width:85%;padding:.35rem .5rem;border:1px solid var(--border);background:var(--card);color:var(--foreground);font-size:.6875rem;white-space:nowrap; }
.widget__geo-tooltip[hidden] { display:none; }


.widget[data-widget-type="realtime"] .widget__content { min-height: 0; }
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] {
  display: flex; align-items: center; justify-content: center;
  border: none; min-height: 0; background: transparent;
  overflow: hidden;
}
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__inner {
  padding: 0; min-height: 0; width: 100%; display: flex; justify-content: center;
}
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__header { display: none; }
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__content {
  margin: 0; display: flex; justify-content: center; min-height: 0;
}
.widget__realtime-badge {
  display: inline-flex; align-items: center; justify-content: center;
  gap: .42rem; padding: .43rem .85rem;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--card); white-space: nowrap;
  font-size: .6875rem; font-weight: 500; line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.widget__realtime-badge .widget__realtime-number { font-size:1.125rem;font-weight:700;line-height:1.05;letter-spacing:-.04em; }
.widget__realtime-badge .widget__realtime-label { font-size:.625rem;color:var(--muted-foreground);font-weight:450; }
.widget__realtime-glyph { flex: none; width: 1rem; height: 1rem; margin-left: .1rem; color: var(--muted-foreground); }
.widget[data-stale="true"] .widget__realtime-dot { background: var(--muted-foreground); }
.widget__realtime-dot { flex: none; width: .45rem; height: .45rem; border-radius: 999px; background: var(--primary); }
.widget__realtime-number { font-family: "JetBrains Mono Variable", monospace; }
.widget__realtime-trend { min-width: 0; display: grid; gap: .65rem; }
.widget__realtime-trend-top { display: flex; flex-direction: column; gap: .25rem; }
.widget__realtime-caption { font-size: .6875rem; color: var(--muted-foreground); }
.widget__realtime-large { font-size: clamp(2rem, 11vw, 2.75rem); font-weight: 640; line-height: 1.1; letter-spacing: -.04em; }
.widget__realtime-bars {
  display: flex; align-items: end; gap: clamp(2px, .6vw, 5px);
  min-width: 0; height: 88px; overflow: hidden;
  border-bottom: 1px solid var(--border);
}
.widget__realtime-bar { flex: 1 1 0; min-width: 0; background: var(--primary); opacity: .86; transition: height .3s ease-out; }
.widget__realtime-axis { display: flex; align-items: center; justify-content: space-between; color: var(--muted-foreground); font-size: .625rem; }
.widget__realtime-map-counter {
  position: absolute; top: .25rem; left: .25rem; z-index: 1;
  display: flex; align-items: center; gap: .4rem; padding: .3rem .5rem;
  border: 1px solid var(--border); background: var(--card);
  font-size: .6875rem;
}
.widget__realtime-map-counter .widget__realtime-number { font-weight: 650; }
.widget__realtime-empty { margin: 0; padding: 1rem 0; text-align: center; color: var(--muted-foreground); font-size: .75rem; }
@media (prefers-reduced-motion: reduce) { .widget__realtime-bar { transition: none; } }

.widget__status {
  display: flex;
  min-height: 4rem;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  text-align: center;
}
.widget__status-content {
  display: grid;
  justify-items: center;
  gap: 0.625rem;
}
.widget__action {
  min-height: 2rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--card);
  cursor: pointer;
  font-size: 0.75rem;
}
.widget__action:hover {
  background: var(--muted);
}
.placeholder {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 1.5rem;
}
.placeholder__card {
  width: min(100%, 26rem);
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--background);
  text-align: center;
}
.placeholder__mark {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  margin: 0 auto 1rem;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 0;
  color: var(--muted-foreground);
  font-size: 1rem;
}
.placeholder__title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}
.placeholder__description {
  margin: 0.5rem 0 0;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  line-height: 1.6;
}
@media (max-width: 260px) {
  .widget__inner {
    padding: 0.75rem;
  }
  .widget__header {
    display: grid;
    gap: 0.25rem;
  }
  .widget__period {
    text-align: left;
  }
  .widget__row {
    gap: 0.5rem;
  }
}
`;

// Only enabled for internal srcDoc previews, never for public embed pages.
const PREVIEW_AUTO_HEIGHT_STYLE = String.raw`
html, body, .widget, .widget__inner {
  min-height: 0;
}
`;

const PREVIEW_AUTO_HEIGHT_SCRIPT = String.raw`
(function () {
  "use strict";
  var widget = document.getElementById("widget");
  if (!widget || window.parent === window) return;
  var lastHeight = 0;
  function reportHeight() {
    var height = Math.ceil(widget.getBoundingClientRect().height);
    if (!Number.isFinite(height) || height < 1 || height === lastHeight) return;
    lastHeight = height;
    window.parent.postMessage(
      { type: "insightflare-widget-preview-height", height: height },
      "*"
    );
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(reportHeight).observe(widget);
  }
  window.addEventListener("resize", reportHeight);
  window.addEventListener("load", reportHeight);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(reportHeight);
  }
  requestAnimationFrame(reportHeight);
})();
`;

const CLIENT_SCRIPT = String.raw`
(function () {
  "use strict";
  var root = document.getElementById("widget");
  if (!root) return;
  var messageNode = document.getElementById("widget-messages");
  var messages = messageNode ? JSON.parse(messageNode.textContent || "{}") : {};
  var content = document.getElementById("widget-content");
  var status = document.getElementById("widget-status");
  var metricLabel = {
    visitors: messages.visitors,
    views: messages.views,
    sessions: messages.sessions,
    bounces: messages.bounces,
    bounceRate: messages.bounceRate,
    avgDurationMs: messages.avgDurationMs,
    viewsPerSession: messages.viewsPerSession,
    events: messages.events,
  };
  function localeTag() {
    return root.dataset.locale === "zh"
      ? "zh-CN"
      : root.dataset.locale === "zh-tw"
        ? "zh-TW"
        : root.dataset.locale || "en";
  }
  function paletteColor(index, count) {
    return "var(--widget-palette-" + Math.max(2,Math.min(10,count)) + "-" + (index+1) + ")";
  }
  function pathHref(rawPath) {
    if (root.dataset.pageLinksEnabled !== "true" || !root.dataset.siteOrigin) return null;
    if (typeof rawPath !== "string" || !/^\/(?!\/)/.test(rawPath) || /[\\\u0000-\u001f\u007f]/.test(rawPath)) return null;
    try {
      var url = new URL(rawPath,root.dataset.siteOrigin);
      return url.origin === root.dataset.siteOrigin ? url.href : null;
    } catch (_) { return null; }
  }
  function makePathLabel(rawPath, labelText) {
    var href = root.dataset.dimension === "page.path" || (root.dataset.widgetType === "realtime" && root.dataset.realtimeLayout === "pages")
      ? pathHref(rawPath) : null;
    var el = document.createElement(href ? "a" : "span");
    el.className = href ? "widget__label widget__path-link" : "widget__label";
    el.textContent = labelText; el.title = labelText;
    if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
    return el;
  }
  function formatNumber(value) {
    return new Intl.NumberFormat(localeTag(), {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  function formatDuration(value) { var seconds = Math.round(Math.max(0, value)/1000); return Math.floor(seconds/60) + ":" + String(seconds%60).padStart(2, "0"); }
  function formatDate(value) {
    return new Intl.DateTimeFormat(localeTag(), {
      month: "short",
      day: "numeric",
      timeZone: root.dataset.timeZone || "UTC",
    }).format(new Date(value));
  }
  function formatRankingLabel(label) {
    if (root.dataset.dimension !== "geo.country" || !/^[A-Z]{2}$/i.test(label))
      return label;
    try {
      return (
        new Intl.DisplayNames([localeTag()], { type: "region" }).of(
          label.toUpperCase(),
        ) || label
      );
    } catch (e) {
      return label;
    }
  }
  function setStatus(message, actionLabel, action) {
    content.replaceChildren();
    status.textContent = "";
    status.hidden = false;
    var wrap = document.createElement("div");
    wrap.className = "widget__status-content";
    var text = document.createElement("span");
    text.textContent = message;
    wrap.appendChild(text);
    if (actionLabel) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "widget__action";
      button.textContent = actionLabel;
      button.addEventListener("click", action);
      wrap.appendChild(button);
    }
    status.appendChild(wrap);
  }
  function renderMetric(data) {
    var line = document.createElement("div");
    line.className = "widget__value-line";
    var value = document.createElement("strong");
    value.className = "widget__value";
    value.textContent = data.metric === "bounceRate"
      ? new Intl.NumberFormat(localeTag(), { style: "percent", maximumFractionDigits: 1 }).format(data.value)
      : data.metric === "avgDurationMs"
        ? formatDuration(data.value)
        : data.metric === "viewsPerSession"
          ? new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 2 }).format(data.value)
          : formatNumber(data.value);
    line.appendChild(value);
    var unit = document.createElement("span");
    unit.className = "widget__unit";
    unit.textContent = metricLabel[data.metric];
    line.appendChild(unit);
    if (root.dataset.comparison === "true") {
      var change = document.createElement("span");
      change.className = "widget__change";
      change.setAttribute("aria-label", messages.change);
      if (typeof data.change === "number" && Number.isFinite(data.change)) {
        change.dataset.direction =
          data.change > 0 ? "up" : data.change < 0 ? "down" : "flat";
        change.textContent = new Intl.NumberFormat(localeTag(), {
          style: "percent",
          signDisplay: "always",
          maximumFractionDigits: 1,
        }).format(data.change);
      } else change.textContent = "—";
      line.appendChild(change);
    }
    content.appendChild(line);
  }
  function renderTrend(data) {
    if (Array.isArray(data.series) && data.series.length > 1) { renderMultiTrend(data); return; }
    var points = Array.isArray(data.points)
      ? data.points.filter(function (point) {
          return (
            point &&
            Number.isFinite(point.timestampMs) &&
            Number.isFinite(point.value)
          );
        })
      : [];
    if (points.length === 0) {
      setStatus(messages.noData);
      return;
    }
    var width = 640,
      height = 176,
      pad = 6;
    var values = points.map(function (point) {
      return point.value;
    });
    var max = Math.max.apply(null, values);
    var step = Math.max(1, Math.ceil(max / 2)),
      high = step * 2;
    var coords = points.map(function (point, index) {
      return {
        x:
          pad +
          (points.length === 1
            ? width - 2 * pad
            : (index * (width - 2 * pad)) / (points.length - 1)),
        y: height - pad - (point.value * (height - 2 * pad)) / high,
      };
    });
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "widget__chart");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      messages.chart + ": " + metricLabel[data.metric],
    );
    [pad, height / 2, height - pad].forEach(function (position) {
      var grid = document.createElementNS(svg.namespaceURI, "line");
      grid.setAttribute("class", "widget__chart-grid");
      grid.setAttribute("x1", "0");
      grid.setAttribute("x2", String(width));
      grid.setAttribute("y1", String(position));
      grid.setAttribute("y2", String(position));
      svg.appendChild(grid);
    });
    var polyline = document.createElementNS(svg.namespaceURI, "polyline");
    polyline.setAttribute("class", "widget__chart-line");
    polyline.setAttribute(
      "points",
      coords
        .map(function (point) {
          return point.x + "," + point.y;
        })
        .join(" "),
    );
    if (root.dataset.trendStyle === "area") {
      var defs = document.createElementNS(svg.namespaceURI,"defs");
      var gradient = document.createElementNS(svg.namespaceURI,"linearGradient");
      gradient.setAttribute("id","widget-trend-area-gradient");
      gradient.setAttribute("x1","0");gradient.setAttribute("y1","0");
      gradient.setAttribute("x2","0");gradient.setAttribute("y2","1");
      var upper = document.createElementNS(svg.namespaceURI,"stop");
      upper.setAttribute("offset","0%");upper.setAttribute("stop-color","var(--primary)");
      upper.setAttribute("stop-opacity",".28");
      var lower = document.createElementNS(svg.namespaceURI,"stop");
      lower.setAttribute("offset","100%");lower.setAttribute("stop-color","var(--primary)");
      lower.setAttribute("stop-opacity",".025");
      gradient.append(upper,lower);defs.appendChild(gradient);svg.appendChild(defs);
      var area = document.createElementNS(svg.namespaceURI,"path");
      area.classList.add("widget__chart-area");
      area.setAttribute("d","M"+coords.map(function(pt){return pt.x+" "+pt.y;}).join(" L")+
        " L"+coords[coords.length-1].x+" "+(height-pad)+
        " L"+coords[0].x+" "+(height-pad)+" Z");
      // CSS fill has higher priority than SVG presentation attributes.
      area.style.fill="url(#widget-trend-area-gradient)";
      area.style.opacity="1";
      svg.appendChild(area);
    }
    svg.appendChild(polyline);
    var unit = document.createElement("div");
    unit.className = "widget__unit";
    unit.textContent = metricLabel[data.metric];
    content.appendChild(unit);
    var chart = document.createElement("div");
    chart.className = "widget__trend-grid";
    var axis = document.createElement("div");
    axis.className = "widget__axis";
    [high, step, 0].forEach(function (tick) {
      var label = document.createElement("span");
      label.textContent = formatNumber(tick);
      axis.appendChild(label);
    });
    chart.append(axis, svg);
    content.appendChild(chart);
    var labels = document.createElement("div");
    labels.className = "widget__chart-labels";
    var start = document.createElement("span"),
      end = document.createElement("span");
    start.textContent = formatDate(points[0].timestampMs);
    end.textContent = formatDate(points[points.length - 1].timestampMs);
    labels.append(start, end);
    content.appendChild(labels);
  }
  function chartSvg(points, accessor, lineColor, maxValue) {
    var width = 640, height = 176, pad = 6;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "widget__chart");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", messages.chartDescription);
    var high = Math.max(1, maxValue);
    [pad, height / 2, height - pad].forEach(function (position) {
      var grid = document.createElementNS(svg.namespaceURI, "line");
      grid.setAttribute("class", "widget__chart-grid");
      grid.setAttribute("x1", "0"); grid.setAttribute("x2", String(width));
      grid.setAttribute("y1", String(position)); grid.setAttribute("y2", String(position));
      svg.appendChild(grid);
    });
    var path = document.createElementNS(svg.namespaceURI, "polyline");
    path.setAttribute("class", "widget__chart-line");
    // The CSS .widget__chart-line stroke declaration overrides SVG presentation
    // attributes; an inline style keeps each line in sync with its legend.
    path.style.stroke = lineColor;
    path.setAttribute("points", points.map(function (point, index) {
      var x = pad + (points.length === 1 ? width - 2 * pad : index * (width - 2 * pad) / (points.length - 1));
      var y = height - pad - Math.max(0, accessor(point)) * (height - 2 * pad) / high;
      return x + "," + y;
    }).join(" "));
    svg.appendChild(path);
    return svg;
  }
  function renderMultiTrend(data) {
    var series = data.series.filter(function (item) {
      return item && Array.isArray(item.points) && item.points.length > 0 &&
        item.points.every(function (p) { return Number.isFinite(p.timestampMs) && Number.isFinite(p.value); });
    }).slice(0, 3);
    if (!series.length) { setStatus(messages.noData); return; }
    var colors = series.map(function(_, i) { return paletteColor(i, series.length); });
    var max = Math.max(1, ...series.flatMap(function (s) { return s.points.map(function (p) { return p.value; }); }));
    var legend = document.createElement("div"); legend.className = "widget__legend";
    series.forEach(function (item, index) {
      var label = document.createElement("span"); label.className = "widget__legend-item";
      var mark = document.createElement("span"); mark.className = "widget__legend-swatch";
      mark.style.background = colors[index];
      var name = document.createElement("span");
      name.textContent = metricLabel[item.metric] || item.metric;
      label.append(mark, name); legend.appendChild(label);
    });
    content.appendChild(legend);
    var svg = chartSvg(series[0].points, function (p) { return p.value; }, colors[0], max);
    series.slice(1).forEach(function (item, index) {
      var second = chartSvg(item.points, function (p) { return p.value; }, colors[index + 1], max);
      var path = second.querySelector("polyline");
      if (path) svg.appendChild(path);
    });
    content.appendChild(svg);
    var dates = document.createElement("div"); dates.className = "widget__chart-labels";
    var first = document.createElement("span"), last = document.createElement("span");
    first.textContent = formatDate(series[0].points[0].timestampMs);
    last.textContent = formatDate(series[0].points[series[0].points.length - 1].timestampMs);
    dates.append(first, last); content.appendChild(dates);
  }
  function renderBars(dataRows, distribution) {
    var rows = Array.isArray(dataRows) ? dataRows.filter(function (row) {
      return row && typeof row.label === "string" && Number.isFinite(row.value);
    }).slice(0, Number(root.dataset.limit) || 10) : [];
    if (!rows.length) { setStatus(messages.noData); return; }
    var max = Math.max(1, ...rows.map(function (row) { return row.value; }));
    var list = document.createElement("ol");
    list.className = distribution ? "widget__distribution-list" : "widget__bar-list";
    rows.forEach(function (row, index) {
      var li = document.createElement("li");
      var labels = document.createElement("div"); labels.className = "widget__bar-labels";
      var name = distribution ? makePathLabel("",row.label) : makePathLabel(row.label,formatRankingLabel(row.label));
      var number = document.createElement("span"); number.className = "widget__bar-number";
      number.textContent = formatNumber(row.value);
      if (distribution && Number.isFinite(row.percent)) {
        number.textContent += " · " + new Intl.NumberFormat(localeTag(), {
          style: "percent", maximumFractionDigits: 1
        }).format(Math.max(0, Math.min(1, row.percent)));
      }
      labels.append(name, number);
      var track = document.createElement("div"); track.className = "widget__bar-track";
      var fill = document.createElement("div"); fill.className = "widget__bar-fill";
      fill.style.width = Math.max(0, Math.min(100, row.value / max * 100)) + "%";
      if (distribution) fill.style.background = paletteColor(index,rows.length);
      track.appendChild(fill); li.append(labels, track); list.appendChild(li);
    });
    content.appendChild(list);
    if (distribution) {
      var note = document.createElement("p"); note.className = "widget__secondary";
      note.textContent = messages.categoryShare;
      content.appendChild(note);
    }
  }
  function renderConversion(data) {
    if (!Number.isFinite(data.value)) { setStatus(messages.noData); return; }
    var line = document.createElement("div"); line.className = "widget__value-line";
    var value = document.createElement("strong"); value.className = "widget__value";
    value.textContent = formatNumber(data.value);
    var unit = document.createElement("span"); unit.className = "widget__unit";
    unit.textContent = data.kind === "goal" ? messages.conversions : messages.events;
    line.append(value, unit); content.appendChild(line);
    if (data.kind === "goal" && typeof data.rate === "number" && Number.isFinite(data.rate)) {
      var rate = document.createElement("div"); rate.className = "widget__secondary";
      rate.textContent = messages.conversionRate + ": " +
        new Intl.NumberFormat(localeTag(), { style: "percent", maximumFractionDigits: 1 }).format(data.rate);
      content.appendChild(rate);
    }
    var points = Array.isArray(data.points) ? data.points.filter(function (point) {
      return point && Number.isFinite(point.timestampMs) && Number.isFinite(point.value);
    }) : [];
    if (!points.length) return;
    var rates = data.kind === "goal";
    var values = points.map(function (p) {
      return rates ? (Number.isFinite(p.rate) ? p.rate : 0) : p.value;
    });
    var max = Math.max(0.01, ...values);
    content.appendChild(chartSvg(points, function (p) {
      return rates ? (Number.isFinite(p.rate) ? p.rate : 0) : p.value;
    }, "var(--primary)", max));
    var dates = document.createElement("div"); dates.className = "widget__chart-labels";
    var first = document.createElement("span"), last = document.createElement("span");
    first.textContent = formatDate(points[0].timestampMs);
    last.textContent = formatDate(points[points.length - 1].timestampMs);
    dates.append(first, last); content.appendChild(dates);
  }
  function renderRanking(data) {
    var rows = Array.isArray(data.rows)
      ? data.rows.filter(function (row) {
          return (
            row && typeof row.label === "string" && Number.isFinite(row.value)
          );
        })
      : [];
    if (rows.length === 0) { setStatus(messages.noData); return; }
    if (root.dataset.rankingStyle === "bars") { renderBars(rows, false); return; }
    var list = document.createElement("ol");
    list.className = "widget__list";
    rows
      .slice(0, Number(root.dataset.limit) || 10)
      .forEach(function (row, index) {
        var item = document.createElement("li");
        item.className = "widget__row";
        var ranked = document.createElement("span");
        ranked.className = "widget__ranked-label";
        var rank = document.createElement("span");
        rank.className = "widget__rank";
        rank.setAttribute("aria-hidden", "true");
        rank.textContent = String(index + 1);
        ranked.appendChild(rank);
        var displayLabel = formatRankingLabel(row.label);
        var label = makePathLabel(row.label,displayLabel);
        ranked.appendChild(label);
        var count = document.createElement("span");
        count.className = "widget__count";
        count.textContent = formatNumber(row.value);
        item.append(ranked, count);
        list.appendChild(item);
      });
    content.appendChild(list);
  }
  function mount(data) {
    if (
      !data ||
      data.type !== root.dataset.widgetType ||
      data.metric !== root.dataset.metric
    )
      throw new Error("Widget response did not match its configuration");
    if (root.dataset.widgetType === "metric" && !Number.isFinite(data.value))
      throw new Error("Invalid metric response");
    content.replaceChildren();
    status.hidden = true;
    if (data.type === "metric") renderMetric(data);
    else if (data.type === "trend") renderTrend(data);
    else if (data.type === "ranking") renderRanking(data);
    else if (data.type === "distribution") renderBars(data.rows, true);
    else if (data.type === "conversion") renderConversion(data);
    else throw new Error("Unknown widget type");
  }
  var preview = document.getElementById("widget-preview-data");
  if (root.dataset.preview === "true") {
    if (preview) {
      try {
        mount(JSON.parse(preview.textContent || "null"));
      } catch (e) {
        setStatus(messages.previewMissing);
      }
    } else setStatus(messages.previewMissing);
    return;
  }
  var apiUrl =
    "/api/public/widgets/" + encodeURIComponent(root.dataset.uuid) + "/data";
  if (root.dataset.revision) {
    apiUrl += "?revision=" + encodeURIComponent(root.dataset.revision);
  }
  function load() {
    setStatus(messages.loading);
    fetch(apiUrl, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    })
      .then(function (response) {
        if (response.status === 409) {
          setStatus(messages.changed, messages.reload, function () {
            window.location.reload();
          });
          return null;
        }
        if (response.status === 404) {
          setStatus(messages.notFound);
          return null;
        }
        if (response.status === 410) {
          setStatus(messages.unpublished);
          return null;
        }
        if (response.status === 403) {
          setStatus(messages.domainDenied);
          return null;
        }
        if (!response.ok) throw new Error("Widget request failed");
        return response.json();
      })
      .then(function (payload) {
        if (payload) {
          mount(payload.data);
        }
      })
      .catch(function () {
        setStatus(messages.failed, messages.retry, load);
      });
  }
  load();
})();
`;

const BREAKDOWN_CLIENT_SCRIPT = CLIENT_SCRIPT.replace(
  "  function renderBars(dataRows, distribution) {",
  BREAKDOWN_CLIENT_FRAGMENT +
    "\n  function renderBars(dataRows, distribution) {",
).replace(
  '    else if (data.type === "distribution") renderBars(data.rows, true);',
  '    else if (data.type === "distribution") {' +
    '\n      if (root.dataset.distributionStyle === "donut") renderDonut(data);' +
    '\n      else if (root.dataset.distributionStyle === "ratio") renderRatio(data);' +
    "\n      else renderBars(data.rows, true);" +
    "\n    }",
);

const BREAKDOWN_CLIENT_SCRIPT_CSP_HASH = `sha256-${btoa(
  String.fromCharCode(
    ...sha256(new TextEncoder().encode(BREAKDOWN_CLIENT_SCRIPT)),
  ),
)}`;

const GEO_CLIENT_SCRIPT = CLIENT_SCRIPT.replace(
  "  function renderRanking(data) {",
  GEO_CLIENT_FRAGMENT + "\n  function renderRanking(data) {",
).replace(
  '    else if (data.type === "conversion") renderConversion(data);',
  '    else if (data.type === "conversion") renderConversion(data);\n    else if (data.type === "geo") renderGeo(data);',
);

const GEO_CLIENT_SCRIPT_CSP_HASH = `sha256-${btoa(
  String.fromCharCode(...sha256(new TextEncoder().encode(GEO_CLIENT_SCRIPT))),
)}`;

const REALTIME_CLIENT_SCRIPT = CLIENT_SCRIPT.replace(
  "  function renderRanking(data) {",
  GEO_CLIENT_FRAGMENT +
    "\n" +
    REALTIME_CLIENT_FRAGMENT +
    "\n  function renderRanking(data) {",
)
  .replace(
    '    else if (data.type === "conversion") renderConversion(data);',
    '    else if (data.type === "conversion") renderConversion(data);\n    else if (data.type === "realtime") renderRealtime(data);',
  )
  .replace(
    "    content.replaceChildren();\n    status.hidden = true;",
    '    if (data.type === "realtime") { status.hidden = true; renderRealtime(data); return; }\n    content.replaceChildren();\n    status.hidden = true;',
  )
  .replace(
    "  function load() {\n    setStatus(messages.loading);",
    "  var realtimeLoading = false, lastRealtimeFetch = 0;\n  function load(silent) {\n    if (realtimeLoading) return;\n    realtimeLoading = true; lastRealtimeFetch = Date.now();\n    if (!silent) setStatus(messages.loading);",
  )
  .replace("    fetch(apiUrl, {", "    fetch(apiUrl, {")
  .replace(
    "          mount(payload.data);",
    '          mount(payload.data); root.dataset.stale = "false";',
  )
  .replace(
    "      .catch(function () {\n        setStatus(messages.failed, messages.retry, load);\n      });",
    '      .catch(function () {\n        root.dataset.stale = "true";\n        if (!content.childElementCount) setStatus(messages.failed, messages.retry, function() { load(false); });\n      })\n      .finally(function () { realtimeLoading = false; });',
  )
  .replace(
    "  load();\n})();",
    `  var realtimeInViewport = false, refreshTimer = 0;
  function shouldRefresh() { return document.visibilityState === "visible" && realtimeInViewport; }
  function manageRefresh() {
    if (!shouldRefresh()) {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = 0; }
      return;
    }
    if (!refreshTimer) refreshTimer = setInterval(function () {
      if (shouldRefresh()) load(true);
    }, 30000);
    if (Date.now() - lastRealtimeFetch > 8000) load(Boolean(content.childElementCount));
  }
  if (typeof IntersectionObserver !== "undefined") {
    var observer = new IntersectionObserver(function (entries) {
      realtimeInViewport = entries.some(function (entry) { return entry.isIntersecting; });
      manageRefresh();
    });
    observer.observe(root);
  } else { realtimeInViewport = true; manageRefresh(); }
  document.addEventListener("visibilitychange", manageRefresh);
})();`,
  );

const REALTIME_CLIENT_SCRIPT_CSP_HASH = `sha256-${btoa(
  String.fromCharCode(
    ...sha256(new TextEncoder().encode(REALTIME_CLIENT_SCRIPT)),
  ),
)}`;

const CLIENT_SCRIPT_CSP_HASH = `sha256-${btoa(
  String.fromCharCode(...sha256(new TextEncoder().encode(CLIENT_SCRIPT))),
)}`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function htmlDocument(
  content: string,
  lang: string,
  theme = "auto",
  autoHeight = false,
  preview = false,
): string {
  // Sandboxed srcDoc previews have an opaque origin and cannot fetch this
  // font from the dev server. Keep the webfont on public widgets only.
  const baseStyle = preview
    ? STYLE.replace(/^\s*@font-face\s*\{[^}]*\}\s*/, "")
    : STYLE;
  const style =
    baseStyle +
    WIDGET_PALETTE_CSS +
    (autoHeight ? PREVIEW_AUTO_HEIGHT_STYLE : "");
  const script = autoHeight
    ? `<script>${PREVIEW_AUTO_HEIGHT_SCRIPT}</script>`
    : "";
  return `<!doctype html><html lang="${escapeHtml(lang)}" data-theme="${escapeHtml(theme)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>InsightFlare</title><style>${style}</style></head><body>${content}${script}</body></html>`;
}

function localeForConfig(config: WidgetConfig): Locale {
  return config.locale;
}

function themeForDocument(
  config: WidgetConfig,
  override?: "light" | "dark",
): string {
  return escapeHtml(
    override ?? (config.theme === "auto" ? "auto" : config.theme),
  );
}

function periodLabel(config: WidgetConfig, messages: EmbedMessages): string {
  if (config.type === "realtime")
    return config.realtimeLayout === "trend" ? messages.last30m : messages.now;
  return config.range === "7d" ? messages.period7d : messages.period30d;
}

function initialWidgetMarkup(
  input: RenderWidgetDocumentInput,
  locale: Locale,
  messages: EmbedMessages,
): string {
  const { config, uuid } = input;
  const title = config.title.trim();
  const preview = input.preview === true;
  const attributes = [
    `id="widget"`,
    `class="widget"`,
    `data-widget-type="${escapeHtml(config.type)}"`,
    `data-metric="${escapeHtml(config.metric)}"`,
    `data-dimension="${escapeHtml(config.dimension)}"`,
    `data-distribution-dimension="${escapeHtml(config.distributionDimension)}"`,
    `data-distribution-style="${escapeHtml(config.distributionStyle)}"`,
    `data-trend-style="${escapeHtml(config.trendStyle)}"`,
    `data-ranking-style="${escapeHtml(config.rankingStyle)}"`,
    `data-page-links-enabled="${config.pageLinksEnabled}"`,
    `data-site-origin="${escapeHtml(config.pageLinksEnabled ? (input.siteOrigin ?? "") : "")}"`,
    `data-geo-projection="${escapeHtml(config.geoProjection)}"`,
    `data-realtime-layout="${escapeHtml(config.realtimeLayout)}"`,
    `data-locale="${escapeHtml(locale)}"`,
    `data-time-zone="${escapeHtml(config.timeZone)}"`,
    `data-uuid="${escapeHtml(uuid)}"`,
    `data-limit="${config.limit}"`,
    `data-comparison="${config.comparison}"`,
    `data-preview="${preview ? "true" : "false"}"`,
  ];
  if (!preview && typeof input.revision === "number") {
    attributes.push(`data-revision="${input.revision}"`);
  }

  const previewData =
    preview && input.previewData != null
      ? `<script type="application/json" id="widget-preview-data">${jsonForHtml(input.previewData)}</script>`
      : "";
  const messagesData = `<script type="application/json" id="widget-messages">${jsonForHtml(messages)}</script>`;

  const geoLandData =
    config.type === "geo" ||
    (config.type === "realtime" && config.realtimeLayout === "map")
      ? `<script type="application/json" id="widget-geo-land">${jsonForHtml(GEO_LAND_DOTS)}</script>`
      : "";
  const clientScript =
    config.type === "distribution"
      ? BREAKDOWN_CLIENT_SCRIPT
      : config.type === "geo"
        ? GEO_CLIENT_SCRIPT
        : config.type === "realtime"
          ? REALTIME_CLIENT_SCRIPT
          : CLIENT_SCRIPT;
  return `<main ${attributes.join(" ")}><div class="widget__inner"><header class="widget__header">${title ? `<h1 class="widget__title">${escapeHtml(title)}</h1>` : ""}<span class="widget__period">${escapeHtml(periodLabel(config, messages))}</span></header><section class="widget__content" id="widget-content" aria-live="polite"></section><div class="widget__status" id="widget-status" role="status">${escapeHtml(preview ? messages.previewDataUnavailable : messages.loading)}</div></div></main>${messagesData}${previewData}${geoLandData}<script>${clientScript}</script>`;
}

export function renderWidgetDocument(input: RenderWidgetDocumentInput): string {
  const locale = input.localeOverride ?? localeForConfig(input.config);
  const content = initialWidgetMarkup(input, locale, MESSAGES[locale]);
  return htmlDocument(
    content,
    locale,
    themeForDocument(input.config, input.themeOverride),
    input.preview === true && input.autoHeight === true,
    input.preview === true,
  );
}

export function renderWidgetPlaceholder(
  status: WidgetPlaceholderStatus,
  localeInput: Locale = "en",
): string {
  const locale = localeInput;
  const messages = MESSAGES[locale];
  const heading =
    status === "domain-denied"
      ? messages.domainDeniedTitle
      : status === "unavailable"
        ? messages.unavailableTitle
        : status === "unpublished"
          ? messages.unpublishedTitle
          : messages.notFoundTitle;
  const description =
    status === "domain-denied"
      ? messages.domainDeniedDescription
      : status === "unavailable"
        ? messages.unavailableDescription
        : status === "unpublished"
          ? messages.unpublishedDescription
          : messages.notFoundDescription;
  const content = `<main class="placeholder"><section class="placeholder__card" role="status"><span class="placeholder__mark" aria-hidden="true">${status === "domain-denied" ? "↗" : "·"}</span><h1 class="placeholder__title">${escapeHtml(heading)}</h1><p class="placeholder__description">${escapeHtml(description)}</p></section></main>`;
  return htmlDocument(content, locale);
}

function normalizeFrameAncestor(source: string): string | null {
  if (source === "*") return "*";
  if (source === "'self'" || source === "'none'") return source;
  try {
    const url = new URL(source);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== source ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function widgetDocumentCsp(
  frameAncestors: string,
  type?: WidgetConfig["type"],
): string {
  const sources = frameAncestors
    .trim()
    .split(/\s+/)
    .map(normalizeFrameAncestor)
    .filter((source): source is string => source !== null);
  const ancestors = sources.includes("*")
    ? "*"
    : sources.includes("'none'")
      ? "'none'"
      : Array.from(
          new Set(sources.filter((source) => source !== "'none'")),
        ).join(" ") || "'none'";
  return [
    "default-src 'none'",
    `script-src '${type === "distribution" ? BREAKDOWN_CLIENT_SCRIPT_CSP_HASH : type === "geo" ? GEO_CLIENT_SCRIPT_CSP_HASH : type === "realtime" ? REALTIME_CLIENT_SCRIPT_CSP_HASH : CLIENT_SCRIPT_CSP_HASH}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}
