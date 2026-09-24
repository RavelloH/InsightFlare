import type { RequestObservationTrendPoint } from "@/components/dashboard/charts/request-observation-trend-chart";
import { durationFormat, intlLocale } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

export interface RequestObservationClientProps {
  locale: Locale;
  messages: AppMessages;
}

type RequestObservationCategory =
  "normal" | "suspected_bot" | "bot" | "custom_block";

type RequestObservationDisposition = "included" | "blocked";

interface RequestObservationSampling {
  provider: "cloudflare_analytics_engine";
  mode: "automatic";
  observedSampled: boolean;
  aggregatesWeighted: boolean;
  detailsAreSampled: boolean;
  distinctAreApproximate: boolean;
}

export interface BotEvent {
  timestamp: string;
  receivedAt: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: RequestObservationCategory | "";
  disposition: RequestObservationDisposition | "";
  reasons: string[];
  ip: string;
  userAgent: string;
  origin: string;
  hostname: string;
  pathname: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  colo: string;
  asn: number;
  asOrganization: string;
  verifiedBotCategory: string;
  rayId: string;
  traceId: string;
  requestMethod: string;
  metadataJson?: string;
  latitude: number | null;
  longitude: number | null;
  botScore: number | null;
  userAgentLength: number;
}

export interface NormalRequestEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number | null;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: RequestObservationCategory | "";
  disposition: RequestObservationDisposition | "";
  reasons: string[];
  ip: string;
  userAgent: string;
  verifiedBotCategory: string;
  botScore: number | null;
  origin: string;
  hostname: string;
  pathname: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  colo: string;
  asn: number;
  asOrganization: string;
  rayId: string;
  traceId: string;
  requestMethod: string;
  metadataJson?: string;
  latitude: number | null;
  longitude: number | null;
  userAgentLength: number;
}

export const BOT_EVENT_DETAIL_SKELETON_DATA: BotEvent = {
  timestamp: "",
  receivedAt: 0,
  siteId: "",
  siteName: "",
  siteDomain: "",
  kind: "",
  category: "",
  disposition: "",
  reasons: [],
  ip: "",
  userAgent: "",
  origin: "",
  hostname: "",
  pathname: "",
  country: "",
  region: "",
  city: "",
  continent: "",
  colo: "",
  asn: 0,
  asOrganization: "",
  verifiedBotCategory: "",
  rayId: "",
  traceId: "",
  requestMethod: "",
  metadataJson: "",
  latitude: null,
  longitude: null,
  botScore: null,
  userAgentLength: 0,
};

export const NORMAL_REQUEST_DETAIL_SKELETON_DATA: NormalRequestEvent = {
  timestamp: "",
  receivedAt: 0,
  eventAt: 0,
  edgeLatencyMs: null,
  siteId: "",
  siteName: "",
  siteDomain: "",
  kind: "",
  category: "",
  disposition: "",
  reasons: [],
  ip: "",
  userAgent: "",
  verifiedBotCategory: "",
  botScore: null,
  origin: "",
  hostname: "",
  pathname: "",
  country: "",
  region: "",
  city: "",
  continent: "",
  colo: "",
  asn: 0,
  asOrganization: "",
  rayId: "",
  traceId: "",
  requestMethod: "",
  metadataJson: "",
  latitude: null,
  longitude: null,
  userAgentLength: 0,
};

export interface RequestMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  pointCount: number;
  source?: "included" | "blocked";
  color?: [number, number, number];
}

type RequestObservationTrendDataPoint = RequestObservationTrendPoint;

export interface RequestNetworkDimensionRow {
  key: string;
  label: string;
  count: number;
  botCount: number;
  country: string;
  region: string;
  iconLabel?: string;
}

interface RequestObservationPagination {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RequestObservationPageData {
  items: BotEvent[] | NormalRequestEvent[];
  pagination: RequestObservationPagination;
}

export interface RequestObservationDimensionData {
  ok: true;
  sampling?: RequestObservationSampling;
  dimension: { rows: RequestNetworkDimensionRow[] };
}

interface LegacyRequestObservationPartition {
  summary: Record<string, number | null>;
  mapPoints: RequestMapPoint[];
  events: Array<BotEvent | NormalRequestEvent>;
  reasons?: Array<{ reason: string; count: number }>;
  countries?: Array<{ country: string; count: number }>;
  asns?: Array<{ asn: number; asOrganization: string; count: number }>;
  pagination?: RequestObservationPagination;
}

export interface RequestObservationData {
  ok: true;
  configured: boolean;
  config?: {
    analyticsEngineDisabled?: boolean;
    analyticsEngineEnableUrl?: string;
  };
  generatedAt: number;
  sampling?: RequestObservationSampling;
  window?: {
    minutes: number;
    from: number;
    to: number;
    interval?: string;
  };
  error?: string;
  summary: {
    totalRequests?: number;
    includedRequests?: number;
    blockedRequests?: number;
    normalRequests?: number;
    suspectedBotRequests?: number;
    botRequests?: number;
    customBlockedRequests?: number;
    botRequestRatio?: number;
    blockedRequestRatio?: number;
    normalRequestRatio?: number;
    total?: number;
    baselineRequests?: number;
    highThreat?: number;
    mediumThreat?: number;
    customBlocked?: number;
    affectedSites: number;
    uniqueAsns: number;
    uniqueCountries: number;
  };
  mapPoints: RequestMapPoint[];
  trend: RequestObservationTrendDataPoint[];
  reasons: Array<{ reason: string; count: number }>;
  countries?: Array<{ country: string; count: number }>;
  asns: Array<{ asn: number; asOrganization: string; count: number }>;
  events: BotEvent[];
  normalEvents?: NormalRequestEvent[];
  overview?: {
    totalRequests: number;
    includedRequests?: number;
    blockedRequests?: number;
    normalRequests: number;
    suspectedBotRequests?: number;
    botRequests?: number;
    customBlockedRequests?: number;
    botRequestRatio?: number;
    blockedRequestRatio?: number;
    normalRequestRatio: number;
    pageviews: number;
    customEvents: number;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p75LatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs: number | null;
  };
  blocked?: {
    summary: {
      total: number;
      ratio: number;
      totalRequests?: number;
      includedRequests?: number;
      blockedRequests?: number;
      normalRequests?: number;
      suspectedBotRequests?: number;
      botRequests?: number;
      customBlockedRequests?: number;
      botRequestRatio?: number;
      blockedRequestRatio?: number;
      normalRequestRatio?: number;
      highThreat?: number;
      mediumThreat?: number;
      customBlocked?: number;
      affectedSites: number;
      uniqueAsns: number;
      uniqueCountries: number;
    };
    mapPoints: RequestMapPoint[];
    events: BotEvent[];
    reasons?: Array<{ reason: string; count: number }>;
    countries?: Array<{ country: string; count: number }>;
    asns?: Array<{ asn: number; asOrganization: string; count: number }>;
    pagination?: RequestObservationPagination;
    dimensions?: {
      network?: Partial<
        Record<NetworkDimensionTab, RequestNetworkDimensionRow[]>
      >;
    };
  };
  included?: {
    summary: {
      total: number;
      ratio: number;
      totalRequests?: number;
      includedRequests?: number;
      blockedRequests?: number;
      normalRequests?: number;
      suspectedBotRequests?: number;
      botRequests?: number;
      customBlockedRequests?: number;
      botRequestRatio?: number;
      blockedRequestRatio?: number;
      normalRequestRatio?: number;
      pageviews: number;
      customEvents: number;
      affectedSites: number;
      uniqueAsns: number;
      uniqueCountries: number;
      avgLatencyMs: number | null;
      p50LatencyMs: number | null;
      p75LatencyMs: number | null;
      p95LatencyMs: number | null;
      p99LatencyMs: number | null;
    };
    mapPoints: RequestMapPoint[];
    events: NormalRequestEvent[];
    pagination?: RequestObservationPagination;
    dimensions?: {
      network?: Partial<
        Record<NetworkDimensionTab, RequestNetworkDimensionRow[]>
      >;
    };
  };
  // Read-only compatibility for links and cached responses from the old API.
  abnormal?: LegacyRequestObservationPartition;
  normal?: LegacyRequestObservationPartition;
}

export interface RequestObservationDetailData {
  ok: true;
  configured: boolean;
  generatedAt: number;
  sampling?: RequestObservationSampling;
  detail: BotEvent | NormalRequestEvent | null;
}

export const DIMENSION_ROW_LIMIT = 30;

export const BOT_EVENT_FETCH_LIMIT = 50;

export type BlockedRequestTableColumnId =
  | "id"
  | "time"
  | "site"
  | "kind"
  | "reason"
  | "category"
  | "botScore"
  | "verifiedBotCategory"
  | "network"
  | "ip"
  | "location"
  | "pathname"
  | "userAgent";

export type NormalRequestTableColumnId =
  | "id"
  | "time"
  | "site"
  | "kind"
  | "category"
  | "requestMethod"
  | "hostname"
  | "network"
  | "location"
  | "colo"
  | "pathname"
  | "edgeLatency";

export const BOT_EVENT_SKELETON_WIDTHS: Record<
  BlockedRequestTableColumnId,
  string
> = {
  id: "w-24",
  time: "w-28",
  site: "w-24",
  kind: "w-20",
  reason: "w-28",
  category: "w-32",
  botScore: "w-24",
  verifiedBotCategory: "w-36",
  network: "w-40",
  ip: "w-28",
  location: "w-24",
  pathname: "w-24",
  userAgent: "w-20",
};

export const NORMAL_REQUEST_SKELETON_WIDTHS: Record<
  NormalRequestTableColumnId,
  string
> = {
  id: "w-24",
  time: "w-28",
  site: "w-24",
  kind: "w-16",
  category: "w-32",
  requestMethod: "w-24",
  hostname: "w-36",
  network: "w-40",
  location: "w-28",
  colo: "w-24",
  pathname: "w-24",
  edgeLatency: "w-20",
};

export type RequestObservationColumnAlignment = "left" | "center" | "right";

export const BOT_EVENT_COLUMN_ALIGNMENTS: Record<
  BlockedRequestTableColumnId,
  RequestObservationColumnAlignment
> = {
  id: "left",
  time: "center",
  site: "left",
  kind: "left",
  reason: "left",
  category: "center",
  botScore: "right",
  verifiedBotCategory: "left",
  network: "left",
  ip: "left",
  location: "left",
  pathname: "left",
  userAgent: "left",
};

export const NORMAL_REQUEST_COLUMN_ALIGNMENTS: Record<
  NormalRequestTableColumnId,
  RequestObservationColumnAlignment
> = {
  id: "left",
  time: "center",
  site: "left",
  kind: "left",
  category: "center",
  requestMethod: "center",
  hostname: "left",
  network: "left",
  location: "left",
  colo: "left",
  pathname: "left",
  edgeLatency: "right",
};

export const BLOCKED_POINT_COLOR: [number, number, number] = [239, 68, 68];

export const INCLUDED_POINT_COLOR: [number, number, number] = [34, 197, 154];

const PERFORMANCE_WARNING_COLOR = "oklch(0.75 0.16 80)";

export const NORMAL_TRAFFIC_SHARE_COLOR = "var(--color-chart-4)";

export const SUSPECTED_BOT_TRAFFIC_COLOR = PERFORMANCE_WARNING_COLOR;

export const BOT_TRAFFIC_COLOR = "var(--color-destructive)";

export const CUSTOM_BLOCKED_TRAFFIC_COLOR = "var(--muted-foreground)";

type RequestObservationTab = "overview" | "blocked" | "included";

export interface RequestObservationMapConfig {
  key: RequestObservationTab;
  points: RequestMapPoint[];
  pointColor: [number, number, number];
  collapseOverlappingPointColors: boolean;
}

export const REQUEST_OBSERVATION_TAB_INDEX = {
  overview: 0,
  blocked: 1,
  included: 2,
} as const satisfies Record<RequestObservationTab, number>;

export const REQUEST_MAP_SLIDE_TRANSITION = {
  duration: 2,
  ease: [0.22, 1, 0.36, 1],
} as const;

export function normalizeRequestObservationTab(
  value: string | null | undefined,
): RequestObservationTab {
  if (value === "blocked" || value === "abnormal") return "blocked";
  if (value === "included" || value === "normal") return "included";
  return "overview";
}

export function normalizeRequestObservationCategory(
  value: unknown,
): RequestObservationCategory | "" {
  const category = String(value || "")
    .trim()
    .toLowerCase();
  if (category === "medium_threat") return "suspected_bot";
  if (category === "high_threat") return "bot";
  if (
    category === "normal" ||
    category === "suspected_bot" ||
    category === "bot" ||
    category === "custom_block"
  ) {
    return category;
  }
  return "";
}

function normalizeRequestObservationDisposition(
  value: unknown,
  fallback: RequestObservationDisposition,
): RequestObservationDisposition {
  return value === "blocked" || value === "included" ? value : fallback;
}

export function normalizeRequestObservationEvent<
  T extends BotEvent | NormalRequestEvent,
>(event: T, fallbackDisposition: RequestObservationDisposition): T {
  const raw = event as unknown as Record<string, unknown>;
  return {
    ...event,
    category: normalizeRequestObservationCategory(raw.category),
    disposition: normalizeRequestObservationDisposition(
      raw.disposition,
      fallbackDisposition,
    ),
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [],
    ip: typeof raw.ip === "string" ? raw.ip : "",
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
    verifiedBotCategory:
      typeof raw.verifiedBotCategory === "string"
        ? raw.verifiedBotCategory
        : "",
    botScore:
      raw.botScore == null || !Number.isFinite(Number(raw.botScore))
        ? null
        : Number(raw.botScore),
  } as T;
}

export function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 9)}...`;
}

export function requestObservationDetailId(event: {
  traceId: string;
  rayId: string;
}): string {
  return event.traceId || event.rayId || "";
}

export function latencyFormat(
  locale: Locale,
  copy: AppMessages["requestObservation"],
  valueMs: number | null | undefined,
) {
  if (valueMs === null || valueMs === undefined || !Number.isFinite(valueMs)) {
    return "--";
  }
  const value = Math.max(0, valueMs);
  if (value < 1000) {
    const formatter = new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: value < 100 ? 1 : 0,
    });
    return formatI18nTemplate(copy.overviewLabels.latencyMilliseconds, {
      value: formatter.format(value),
    });
  }
  return durationFormat(locale, value);
}

interface RequestObservationUiLabels {
  pageSubtitle: string;
  blocked: string;
  included: string;
  disposition: string;
  normalRequests: string;
  suspectedBotRequests: string;
  botRequests: string;
  customBlockedRequests: string;
  includedRequests: string;
  blockedRequests: string;
  totalRequests: string;
  botRequestRatio: string;
  blockedRequestRatio: string;
  normalRequestRatio: string;
  normalTrafficShare: string;
  suspectedBotTraffic: string;
  botTraffic: string;
  customBlockedTraffic: string;
  requests: string;
  blockedSubtitle: string;
  includedSubtitle: string;
  blockedTrendDescription: string;
  includedTrendDescription: string;
  recentBlockedTitle: string;
  recentBlockedDescription: string;
  recentIncludedTitle: string;
  recentIncludedDescription: string;
  detailTitle: string;
  detailSubtitle: string;
}

export function nestedMessage(
  source: unknown,
  path: string[],
  fallback: string,
): string {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return fallback;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current : fallback;
}

export function requestObservationUiLabels(
  locale: Locale,
  copy: AppMessages["requestObservation"],
): RequestObservationUiLabels {
  const fallback =
    locale === "zh"
      ? {
          pageSubtitle:
            "基于 Analytics Engine 观察请求分类、实际处置与统计链路。",
          blocked: "拦截请求",
          included: "统计请求",
          disposition: "处置",
          normalRequests: "正常请求",
          suspectedBotRequests: "疑似机器人",
          botRequests: "机器人请求",
          customBlockedRequests: "自定义拦截",
          includedRequests: "统计请求数",
          blockedRequests: "拦截请求数",
          totalRequests: "总请求数",
          botRequestRatio: "机器人请求比例",
          blockedRequestRatio: "拦截请求比例",
          normalRequestRatio: "正常请求比例",
          normalTrafficShare: "正常请求",
          suspectedBotTraffic: "疑似机器人",
          botTraffic: "机器人请求",
          customBlockedTraffic: "自定义拦截",
          requests: "请求数",
          blockedSubtitle: "聚焦实际被拦截的请求；分类仍表示请求的检测结果。",
          includedSubtitle:
            "聚焦进入统计链路的请求，包括正常请求和未被拦截的机器人信号。",
          blockedTrendDescription: "按时间显示实际拦截请求数与拦截比例。",
          includedTrendDescription: "按时间显示进入统计链路的请求数。",
          recentBlockedTitle: "最近拦截请求",
          recentBlockedDescription:
            "这些记录来自统一的 Request Analytics Engine 数据集。",
          recentIncludedTitle: "最近统计请求",
          recentIncludedDescription:
            "这些记录来自统一的 Request Analytics Engine 数据集。",
          detailTitle: "请求详情",
          detailSubtitle: "查看请求的分类、处置结果、网络和客户端上下文。",
        }
      : locale === "ja"
        ? {
            pageSubtitle:
              "Analytics Engine でリクエストの分類、処置、集計経路を確認します。",
            blocked: "ブロック済みリクエスト",
            included: "集計対象リクエスト",
            disposition: "処置",
            normalRequests: "通常リクエスト",
            suspectedBotRequests: "ボット疑い",
            botRequests: "ボットリクエスト",
            customBlockedRequests: "カスタムブロック",
            includedRequests: "集計対象リクエスト数",
            blockedRequests: "ブロック済みリクエスト数",
            totalRequests: "総リクエスト数",
            botRequestRatio: "ボットリクエスト比率",
            blockedRequestRatio: "ブロック率",
            normalRequestRatio: "通常リクエスト比率",
            normalTrafficShare: "通常リクエスト",
            suspectedBotTraffic: "ボット疑い",
            botTraffic: "ボットリクエスト",
            customBlockedTraffic: "カスタムブロック",
            requests: "リクエスト数",
            blockedSubtitle: "実際にブロックされたリクエストを表示します。",
            includedSubtitle: "統計に含まれるリクエストを表示します。",
            blockedTrendDescription: "時間帯ごとのブロック数とブロック率。",
            includedTrendDescription: "時間帯ごとの集計対象リクエスト数。",
            recentBlockedTitle: "最近のブロック済みリクエスト",
            recentBlockedDescription:
              "統合された Request Analytics Engine データセットの記録です。",
            recentIncludedTitle: "最近の集計対象リクエスト",
            recentIncludedDescription:
              "統合された Request Analytics Engine データセットの記録です。",
            detailTitle: "リクエスト詳細",
            detailSubtitle:
              "分類、処置、ネットワーク、クライアントの情報を確認します。",
          }
        : {
            pageSubtitle:
              "Monitor request categories, dispositions, and the statistics pipeline from Analytics Engine.",
            blocked: "Blocked requests",
            included: "Included requests",
            disposition: "Disposition",
            normalRequests: "Normal requests",
            suspectedBotRequests: "Suspected bots",
            botRequests: "Bot requests",
            customBlockedRequests: "Custom blocks",
            includedRequests: "Included requests",
            blockedRequests: "Blocked requests",
            totalRequests: "Total requests",
            botRequestRatio: "Bot request ratio",
            blockedRequestRatio: "Blocked request ratio",
            normalRequestRatio: "Normal request ratio",
            normalTrafficShare: "Normal requests",
            suspectedBotTraffic: "Suspected bots",
            botTraffic: "Bot requests",
            customBlockedTraffic: "Custom blocks",
            requests: "Requests",
            blockedSubtitle:
              "Requests that were actually blocked; category remains the detection result.",
            includedSubtitle:
              "Requests included in statistics, including requests with signals that were not blocked.",
            blockedTrendDescription:
              "Actual blocked requests and blocked ratio by interval.",
            includedTrendDescription:
              "Requests included in statistics by interval.",
            recentBlockedTitle: "Recent blocked requests",
            recentBlockedDescription:
              "Records read from the unified Request Analytics Engine dataset.",
            recentIncludedTitle: "Recent included requests",
            recentIncludedDescription:
              "Records read from the unified Request Analytics Engine dataset.",
            detailTitle: "Request details",
            detailSubtitle:
              "Inspect the request category, disposition, network, and client context.",
          };
  const read = (paths: string[][], value: string) => {
    for (const path of paths) {
      const candidate = nestedMessage(copy, path, "");
      if (candidate) return candidate;
    }
    return value;
  };
  return {
    pageSubtitle: read([["subtitle"]], fallback.pageSubtitle),
    blocked: read([["tabs", "blocked"]], fallback.blocked),
    included: read([["tabs", "included"]], fallback.included),
    disposition: read([["disposition"]], fallback.disposition),
    normalRequests: read(
      [["normalRequests"], ["overviewLabels", "normalRequests"]],
      fallback.normalRequests,
    ),
    suspectedBotRequests: read(
      [["suspectedBotRequests"], ["overviewLabels", "suspectedBotRequests"]],
      fallback.suspectedBotRequests,
    ),
    botRequests: read(
      [["botRequests"], ["overviewLabels", "botRequests"]],
      fallback.botRequests,
    ),
    customBlockedRequests: read(
      [["customBlockedRequests"], ["overviewLabels", "customBlockedRequests"]],
      fallback.customBlockedRequests,
    ),
    includedRequests: read(
      [["includedRequests"], ["overviewLabels", "includedRequests"]],
      fallback.includedRequests,
    ),
    blockedRequests: read(
      [["blockedRequests"], ["overviewLabels", "blockedRequests"]],
      fallback.blockedRequests,
    ),
    totalRequests: read(
      [["totalRequests"], ["overviewLabels", "totalRequests"]],
      fallback.totalRequests,
    ),
    botRequestRatio: read(
      [["botRequestRatio"], ["overviewLabels", "botRequestRatio"]],
      fallback.botRequestRatio,
    ),
    blockedRequestRatio: read(
      [["blockedRequestRatio"], ["overviewLabels", "blockedRequestRatio"]],
      fallback.blockedRequestRatio,
    ),
    normalRequestRatio: read(
      [["normalRequestRatio"], ["overviewLabels", "normalRequestRatio"]],
      fallback.normalRequestRatio,
    ),
    normalTrafficShare: read(
      [["normalRequests"], ["overviewLabels", "normalTrafficShare"]],
      fallback.normalTrafficShare,
    ),
    suspectedBotTraffic: read(
      [["suspectedBotRequests"], ["overviewLabels", "suspectedBotTraffic"]],
      fallback.suspectedBotTraffic,
    ),
    botTraffic: read(
      [["botRequests"], ["overviewLabels", "botTraffic"]],
      fallback.botTraffic,
    ),
    customBlockedTraffic: read(
      [["customBlockedRequests"], ["overviewLabels", "customBlockedTraffic"]],
      fallback.customBlockedTraffic,
    ),
    requests: read([["overviewLabels", "requests"]], fallback.requests),
    blockedSubtitle: read([["blockedSubtitle"]], fallback.blockedSubtitle),
    includedSubtitle: read([["includedSubtitle"]], fallback.includedSubtitle),
    blockedTrendDescription: read(
      [["blockedTrendDescription"]],
      fallback.blockedTrendDescription,
    ),
    includedTrendDescription: read(
      [["includedTrendDescription"]],
      fallback.includedTrendDescription,
    ),
    recentBlockedTitle: read(
      [["recentBlockedTitle"]],
      fallback.recentBlockedTitle,
    ),
    recentBlockedDescription: read(
      [["recentBlockedDescription"]],
      fallback.recentBlockedDescription,
    ),
    recentIncludedTitle: read(
      [["recentIncludedTitle"]],
      fallback.recentIncludedTitle,
    ),
    recentIncludedDescription: read(
      [["recentIncludedDescription"]],
      fallback.recentIncludedDescription,
    ),
    detailTitle: read([["requestDetailTitle"]], fallback.detailTitle),
    detailSubtitle: read([["requestDetailSubtitle"]], fallback.detailSubtitle),
  };
}

export type DetectionDimensionTab =
  "reason" | "category" | "kind" | "botScoreBucket" | "verifiedBotCategory";

export type TargetDimensionTab = "site" | "hostname" | "pathname" | "origin";

export type IncludedTargetDimensionTab = "category" | TargetDimensionTab;

export type NetworkDimensionTab =
  "asOrganization" | "asn" | "country" | "region" | "city" | "colo";

export type ClientDimensionTab =
  "ip" | "userAgent" | "userAgentLengthBucket" | "ipPrefix";

export interface BotDimensionRow {
  label: string;
  count: number;
  botCount: number;
  sampleEvent: BotEvent | null;
}

export function withRequestObservabilityDefaults(
  data: RequestObservationData,
): RequestObservationData {
  const legacyData = data as RequestObservationData & {
    abnormal?: LegacyRequestObservationPartition;
    normal?: LegacyRequestObservationPartition;
  };
  const numeric = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const firstNumeric = (...values: unknown[]) => {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };
  const rawTrend = data.trend ?? [];
  const trend = rawTrend.map((point) => {
    const raw = point as unknown as Record<string, unknown>;
    const legacyAbnormalCount = firstNumeric(raw.abnormalCount, raw.count);
    const normalCount = firstNumeric(raw.normalCount, raw.baselineCount);
    const customBlockedCount = firstNumeric(
      raw.customBlockedCount,
      raw.customBlocked,
    );
    const botCount = firstNumeric(raw.botCount, raw.highThreat);
    const suspectedBotCount = firstNumeric(
      raw.suspectedBotCount,
      raw.mediumThreat,
      Math.max(0, legacyAbnormalCount - botCount - customBlockedCount),
    );
    const includedCount = firstNumeric(raw.includedCount, normalCount);
    const blockedCount = firstNumeric(raw.blockedCount, legacyAbnormalCount);
    const categoryTotal =
      normalCount + suspectedBotCount + botCount + customBlockedCount;
    const totalCount = firstNumeric(
      raw.totalCount,
      categoryTotal,
      includedCount + blockedCount,
    );
    const botRatio = firstNumeric(
      raw.botRatio,
      totalCount > 0 ? botCount / totalCount : 0,
    );
    const blockedRatio = firstNumeric(
      raw.blockedRatio,
      totalCount > 0 ? blockedCount / totalCount : 0,
    );
    return {
      timestampMs: numeric(point.timestampMs),
      count: totalCount,
      baselineCount: includedCount,
      normalCount,
      suspectedBotCount,
      botCount,
      customBlockedCount,
      includedCount,
      blockedCount,
      totalCount,
      botRatio,
      blockedRatio,
      normalRatio: firstNumeric(
        raw.normalRatio,
        totalCount > 0 ? normalCount / totalCount : 0,
      ),
      pageviews: firstNumeric(raw.pageviews, normalCount),
      customEvents: numeric(raw.customEvents),
      pageviewCount: firstNumeric(raw.pageviewCount, raw.pageviews),
      leaveCount: numeric(raw.leaveCount),
      visibilityCount: numeric(raw.visibilityCount),
      customEventCount: firstNumeric(raw.customEventCount, raw.customEvents),
      identifyCount: numeric(raw.identifyCount),
      weightedRequestCount: firstNumeric(raw.weightedRequestCount, totalCount),
      latencyWeightedSumMs: firstNumeric(
        raw.latencyWeightedSumMs,
        raw.avgLatencyMs == null
          ? 0
          : numeric(raw.avgLatencyMs) * includedCount,
      ),
      latencySampleWeight: firstNumeric(
        raw.latencySampleWeight,
        raw.avgLatencyMs == null ? 0 : includedCount,
      ),
      avgLatencyMs: raw.avgLatencyMs == null ? null : numeric(raw.avgLatencyMs),
      p50LatencyMs:
        raw.p50LatencyMs == null
          ? raw.avgLatencyMs == null
            ? null
            : numeric(raw.avgLatencyMs)
          : numeric(raw.p50LatencyMs),
      p75LatencyMs:
        raw.p75LatencyMs == null
          ? raw.p95LatencyMs == null
            ? null
            : numeric(raw.p95LatencyMs)
          : numeric(raw.p75LatencyMs),
      p95LatencyMs: raw.p95LatencyMs == null ? null : numeric(raw.p95LatencyMs),
      p99LatencyMs:
        raw.p99LatencyMs == null
          ? raw.p95LatencyMs == null
            ? null
            : numeric(raw.p95LatencyMs)
          : numeric(raw.p99LatencyMs),
    };
  });
  const legacyBlockedEvents = legacyData.abnormal?.events ?? data.events ?? [];
  const legacyIncludedEvents =
    legacyData.normal?.events ?? data.normalEvents ?? [];
  const blockedEvents =
    data.blocked?.events ?? (legacyBlockedEvents as BotEvent[]);
  const includedEvents =
    data.included?.events ?? (legacyIncludedEvents as NormalRequestEvent[]);
  const normalizedBlockedEvents = blockedEvents.map((event) =>
    normalizeRequestObservationEvent(event, "blocked"),
  );
  const normalizedIncludedEvents = includedEvents.map((event) =>
    normalizeRequestObservationEvent(event, "included"),
  );
  const blockedMapPoints =
    data.blocked?.mapPoints ??
    legacyData.abnormal?.mapPoints ??
    data.mapPoints ??
    [];
  const includedMapPoints =
    data.included?.mapPoints ?? legacyData.normal?.mapPoints ?? [];
  const trendTotals = trend.reduce(
    (totals, point) => ({
      total: totals.total + point.totalCount,
      included: totals.included + point.includedCount,
      blocked: totals.blocked + point.blockedCount,
      normal: totals.normal + point.normalCount,
      suspected: totals.suspected + point.suspectedBotCount,
      bot: totals.bot + point.botCount,
      custom: totals.custom + point.customBlockedCount,
    }),
    {
      total: 0,
      included: 0,
      blocked: 0,
      normal: 0,
      suspected: 0,
      bot: 0,
      custom: 0,
    },
  );
  const summary = data.summary;
  const overviewSource = data.overview;
  const normalRequests = firstNumeric(
    overviewSource?.normalRequests,
    summary.normalRequests,
    trendTotals.normal,
    summary.baselineRequests,
  );
  const suspectedBotRequests = firstNumeric(
    overviewSource?.suspectedBotRequests,
    summary.suspectedBotRequests,
    trendTotals.suspected,
  );
  const botRequests = firstNumeric(
    overviewSource?.botRequests,
    summary.botRequests,
    trendTotals.bot,
    summary.highThreat,
  );
  const customBlockedRequests = firstNumeric(
    overviewSource?.customBlockedRequests,
    summary.customBlockedRequests,
    trendTotals.custom,
    summary.customBlocked,
  );
  const includedRequests = firstNumeric(
    overviewSource?.includedRequests,
    summary.includedRequests,
    trendTotals.included,
    summary.baselineRequests,
    legacyIncludedEvents.length,
  );
  const blockedRequests = firstNumeric(
    overviewSource?.blockedRequests,
    summary.blockedRequests,
    trendTotals.blocked,
    summary.total,
    legacyBlockedEvents.length,
  );
  const totalRequests = firstNumeric(
    overviewSource?.totalRequests,
    summary.totalRequests,
    trendTotals.total,
    summary.baselineRequests != null && summary.total != null
      ? summary.baselineRequests + summary.total
      : undefined,
    includedRequests + blockedRequests,
  );
  const botRequestRatio = firstNumeric(
    overviewSource?.botRequestRatio,
    summary.botRequestRatio,
    totalRequests > 0 ? botRequests / totalRequests : 0,
  );
  const blockedRequestRatio = firstNumeric(
    overviewSource?.blockedRequestRatio,
    summary.blockedRequestRatio,
    totalRequests > 0 ? blockedRequests / totalRequests : 0,
  );
  const normalRequestRatio = firstNumeric(
    overviewSource?.normalRequestRatio,
    summary.normalRequestRatio,
    totalRequests > 0 ? normalRequests / totalRequests : 0,
  );
  const blockedSummary = data.blocked?.summary;
  const includedSummary = data.included?.summary;

  return {
    ...data,
    trend,
    events: normalizedBlockedEvents,
    normalEvents: normalizedIncludedEvents,
    mapPoints: blockedMapPoints,
    overview: {
      totalRequests,
      includedRequests,
      blockedRequests,
      normalRequests,
      suspectedBotRequests,
      botRequests,
      customBlockedRequests,
      botRequestRatio,
      blockedRequestRatio,
      normalRequestRatio,
      pageviews:
        overviewSource?.pageviews ??
        trend.reduce((sum, point) => sum + point.pageviews, 0),
      customEvents:
        overviewSource?.customEvents ??
        trend.reduce((sum, point) => sum + point.customEvents, 0),
      avgLatencyMs: overviewSource?.avgLatencyMs ?? null,
      p50LatencyMs:
        overviewSource?.p50LatencyMs ?? overviewSource?.avgLatencyMs ?? null,
      p75LatencyMs:
        overviewSource?.p75LatencyMs ?? overviewSource?.p95LatencyMs ?? null,
      p95LatencyMs: overviewSource?.p95LatencyMs ?? null,
      p99LatencyMs:
        overviewSource?.p99LatencyMs ?? overviewSource?.p95LatencyMs ?? null,
    },
    blocked: {
      summary: {
        total: blockedRequests,
        ratio: blockedRequestRatio,
        totalRequests,
        includedRequests,
        blockedRequests,
        normalRequests,
        suspectedBotRequests,
        botRequests,
        customBlockedRequests,
        botRequestRatio,
        blockedRequestRatio,
        normalRequestRatio,
        affectedSites: data.summary.affectedSites,
        uniqueAsns: data.summary.uniqueAsns,
        uniqueCountries: data.summary.uniqueCountries,
        ...(blockedSummary ?? {}),
      },
      mapPoints: blockedMapPoints,
      events: normalizedBlockedEvents,
      reasons:
        data.blocked?.reasons ?? legacyData.abnormal?.reasons ?? data.reasons,
      countries:
        data.blocked?.countries ??
        legacyData.abnormal?.countries ??
        data.countries,
      asns: data.blocked?.asns ?? legacyData.abnormal?.asns ?? data.asns,
      pagination: data.blocked?.pagination ??
        legacyData.abnormal?.pagination ?? {
          limit: BOT_EVENT_FETCH_LIMIT,
          returned: normalizedBlockedEvents.length,
          hasMore: false,
          nextCursor: null,
        },
    },
    included: {
      summary: {
        total: includedRequests,
        ratio: normalRequestRatio,
        totalRequests,
        includedRequests,
        blockedRequests,
        normalRequests,
        suspectedBotRequests,
        botRequests,
        customBlockedRequests,
        botRequestRatio,
        blockedRequestRatio,
        normalRequestRatio,
        pageviews: overviewSource?.pageviews ?? includedRequests,
        customEvents: overviewSource?.customEvents ?? 0,
        affectedSites: includedSummary?.affectedSites ?? 0,
        uniqueAsns: includedSummary?.uniqueAsns ?? 0,
        uniqueCountries: includedSummary?.uniqueCountries ?? 0,
        avgLatencyMs: overviewSource?.avgLatencyMs ?? null,
        p50LatencyMs:
          overviewSource?.p50LatencyMs ?? overviewSource?.avgLatencyMs ?? null,
        p75LatencyMs:
          overviewSource?.p75LatencyMs ?? overviewSource?.p95LatencyMs ?? null,
        p95LatencyMs: overviewSource?.p95LatencyMs ?? null,
        p99LatencyMs:
          overviewSource?.p99LatencyMs ?? overviewSource?.p95LatencyMs ?? null,
        ...(includedSummary ?? {}),
      },
      mapPoints: includedMapPoints,
      events: normalizedIncludedEvents,
      pagination: data.included?.pagination ??
        legacyData.normal?.pagination ?? {
          limit: BOT_EVENT_FETCH_LIMIT,
          returned: normalizedIncludedEvents.length,
          hasMore: false,
          nextCursor: null,
        },
    },
  };
}

export function isInvalidRequestObservationCursorError(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("request_observation_invalid_cursor") ||
    error.message.includes("Invalid request observation page cursor")
  );
}
