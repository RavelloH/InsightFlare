import type { Locale } from "@/lib/i18n/config";

export interface EmbedMessages {
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

export const WIDGET_EMBED_MESSAGES: Readonly<Record<Locale, EmbedMessages>> = {
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
