import {
  Fragment,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiFileList3Line,
  RiGlobalLine,
  RiRadarLine,
  RiRefreshLine,
  RiRobot2Line,
  RiShieldCheckLine,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useAnimationControls } from "motion/react";
import { toast } from "sonner";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/analytics-table-column-settings";
import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLabelAppearance,
  type AsyncDimensionBreakdownRow,
  type AsyncDimensionBreakdownTab,
} from "@/components/dashboard/async-dimension-breakdown-card";
import { RequestObservationTrendChart } from "@/components/dashboard/charts/request-observation-trend-chart";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { GeoPointsMapIsland } from "@/components/dashboard/geo-points-map-island";
import {
  CountryRegionMeta,
  formatRelativeTime,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import { ShareRadialCard } from "@/components/dashboard/share-radial-card";
import { EVENT_RECORD_DRAWER_Z_INDEX } from "@/components/dashboard/site-pages/floating-layer";
import { AppOverlay, overlayZIndexFor } from "@/components/ui/app-overlay";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { requestAdminService } from "@/lib/admin-service-client";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTimeWithSeconds,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import Link from "@/lib/router";
import { usePathname, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

import type { RequestObservationTrendPoint } from "./charts/request-observation-trend-chart";

interface RequestObservationClientProps {
  locale: Locale;
  messages: AppMessages;
}

type RequestObservationCategory =
  | "medium_threat"
  | "high_threat"
  | "custom_block";

interface BotEvent {
  timestamp: string;
  receivedAt: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: RequestObservationCategory | "";
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
  metadataJson?: string;
  latitude: number | null;
  longitude: number | null;
  botScore: number | null;
  userAgentLength: number;
}

interface NormalRequestEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
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

const BOT_EVENT_DETAIL_SKELETON_DATA: BotEvent = {
  timestamp: "",
  receivedAt: 0,
  siteId: "",
  siteName: "",
  siteDomain: "",
  kind: "",
  category: "",
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
  metadataJson: "",
  latitude: null,
  longitude: null,
  botScore: null,
  userAgentLength: 0,
};

interface RequestMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  pointCount: number;
  source?: "normal" | "abnormal";
  color?: [number, number, number];
}

interface RequestObservationTrendDataPoint extends RequestObservationTrendPoint {
  mediumThreatCount: number;
  highThreatCount: number;
  customBlockedCount: number;
}

interface RequestNetworkDimensionRow {
  key: string;
  label: string;
  count: number;
  highThreat: number;
  country: string;
  region: string;
  iconLabel?: string;
}

interface RequestDetailCursor {
  timestamp: string;
  receivedAt: number;
}

interface RequestObservationPageData {
  ok: true;
  configured: boolean;
  generatedAt: number;
  page: {
    source: "abnormal" | "normal";
    events: BotEvent[] | NormalRequestEvent[];
    hasMore: boolean;
    nextCursor: RequestDetailCursor | null;
  };
}

interface RequestObservationDimensionData {
  ok: true;
  dimension: { rows: RequestNetworkDimensionRow[] };
}

interface RequestObservationData {
  ok: true;
  configured: boolean;
  config?: {
    analyticsEngineDisabled?: boolean;
    analyticsEngineEnableUrl?: string;
  };
  generatedAt: number;
  window?: {
    minutes: number;
    from: number;
    to: number;
    interval?: string;
  };
  error?: string;
  summary: {
    total: number;
    baselineRequests: number;
    botRequestRatio: number;
    highThreat: number;
    mediumThreat: number;
    customBlocked: number;
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
    normalRequests: number;
    abnormalRequests: number;
    abnormalRequestRatio: number;
    normalRequestRatio: number;
    pageviews: number;
    customEvents: number;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p75LatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs: number | null;
  };
  abnormal?: {
    summary: {
      total: number;
      ratio: number;
      highThreat: number;
      mediumThreat: number;
      customBlocked: number;
      affectedSites: number;
      uniqueAsns: number;
      uniqueCountries: number;
    };
    mapPoints: RequestMapPoint[];
    events: BotEvent[];
    reasons?: Array<{ reason: string; count: number }>;
    countries?: Array<{ country: string; count: number }>;
    asns?: Array<{ asn: number; asOrganization: string; count: number }>;
    hasMore?: boolean;
    nextCursor?: RequestDetailCursor | null;
    dimensions?: {
      network?: Partial<
        Record<NetworkDimensionTab, RequestNetworkDimensionRow[]>
      >;
    };
  };
  normal?: {
    summary: {
      total: number;
      ratio: number;
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
    hasMore?: boolean;
    nextCursor?: RequestDetailCursor | null;
    dimensions?: {
      network?: Partial<
        Record<NetworkDimensionTab, RequestNetworkDimensionRow[]>
      >;
    };
  };
}

interface RequestObservationDetailData {
  ok: true;
  configured: boolean;
  generatedAt: number;
  detail: BotEvent | null;
}

const DIMENSION_ROW_LIMIT = 30;
const BOT_EVENT_FETCH_LIMIT = 50;
type AbnormalRequestTableColumnId =
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

type NormalRequestTableColumnId =
  | "id"
  | "time"
  | "site"
  | "kind"
  | "requestMethod"
  | "hostname"
  | "network"
  | "location"
  | "colo"
  | "pathname"
  | "edgeLatency";

const BOT_EVENT_SKELETON_WIDTHS: Record<AbnormalRequestTableColumnId, string> =
  {
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
const NORMAL_REQUEST_SKELETON_WIDTHS: Record<
  NormalRequestTableColumnId,
  string
> = {
  id: "w-24",
  time: "w-28",
  site: "w-24",
  kind: "w-16",
  requestMethod: "w-24",
  hostname: "w-36",
  network: "w-40",
  location: "w-28",
  colo: "w-24",
  pathname: "w-24",
  edgeLatency: "w-20",
};
type RequestObservationColumnAlignment = "left" | "center" | "right";
const BOT_EVENT_COLUMN_ALIGNMENTS: Record<
  AbnormalRequestTableColumnId,
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
const NORMAL_REQUEST_COLUMN_ALIGNMENTS: Record<
  NormalRequestTableColumnId,
  RequestObservationColumnAlignment
> = {
  id: "left",
  time: "center",
  site: "left",
  kind: "left",
  requestMethod: "center",
  hostname: "left",
  network: "left",
  location: "left",
  colo: "left",
  pathname: "left",
  edgeLatency: "right",
};
const ABNORMAL_POINT_COLOR: [number, number, number] = [239, 68, 68];
const NORMAL_POINT_COLOR: [number, number, number] = [34, 197, 154];
const PERFORMANCE_WARNING_COLOR = "oklch(0.75 0.16 80)";
const NORMAL_TRAFFIC_SHARE_COLOR = "var(--color-chart-4)";
const MEDIUM_THREAT_TRAFFIC_COLOR = PERFORMANCE_WARNING_COLOR;
const HIGH_THREAT_TRAFFIC_COLOR = "var(--color-destructive)";
const CUSTOM_BLOCKED_TRAFFIC_COLOR = "var(--muted-foreground)";

type RequestObservationTab = "overview" | "abnormal" | "normal";
interface RequestObservationMapConfig {
  key: RequestObservationTab;
  points: RequestMapPoint[];
  pointColor: [number, number, number];
  collapseOverlappingPointColors: boolean;
}

const REQUEST_OBSERVATION_TAB_INDEX = {
  overview: 0,
  abnormal: 1,
  normal: 2,
} as const satisfies Record<RequestObservationTab, number>;
const REQUEST_MAP_SLIDE_TRANSITION = {
  duration: 2,
  ease: [0.22, 1, 0.36, 1],
} as const;

function normalizeRequestObservationTab(
  value: string | null | undefined,
): RequestObservationTab {
  if (value === "abnormal" || value === "normal") return value;
  return "overview";
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 9)}...`;
}

function botEventDetailId(event: BotEvent): string {
  return event.traceId || event.rayId || "";
}

function latencyFormat(
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

type DetectionDimensionTab =
  | "reason"
  | "category"
  | "kind"
  | "botScoreBucket"
  | "verifiedBotCategory";
type TargetDimensionTab = "site" | "hostname" | "pathname" | "origin";
type NetworkDimensionTab =
  | "asOrganization"
  | "asn"
  | "country"
  | "region"
  | "city"
  | "colo";
type ClientDimensionTab =
  | "ip"
  | "userAgent"
  | "userAgentLengthBucket"
  | "ipPrefix";

interface BotDimensionRow {
  label: string;
  count: number;
  highThreat: number;
  sampleEvent: BotEvent | null;
}

function withRequestObservabilityDefaults(
  data: RequestObservationData,
): RequestObservationData {
  const rawTrend = data.trend ?? [];
  const trend = rawTrend.map((point) => {
    const abnormalCount = Number(point.abnormalCount ?? point.count ?? 0);
    const normalCount = Number(point.normalCount ?? point.baselineCount ?? 0);
    const totalCount = Number(point.totalCount ?? abnormalCount + normalCount);
    return {
      timestampMs: Number(point.timestampMs ?? 0),
      count: abnormalCount,
      baselineCount: normalCount,
      normalCount,
      abnormalCount,
      totalCount,
      botRatio:
        totalCount > 0
          ? Number(point.botRatio ?? abnormalCount / totalCount)
          : 0,
      abnormalRatio:
        totalCount > 0
          ? Number(point.abnormalRatio ?? abnormalCount / totalCount)
          : 0,
      normalRatio:
        totalCount > 0
          ? Number(point.normalRatio ?? normalCount / totalCount)
          : 0,
      pageviews: Number(point.pageviews ?? normalCount),
      customEvents: Number(point.customEvents ?? 0),
      mediumThreatCount: Number(point.mediumThreatCount ?? 0),
      highThreatCount: Number(point.highThreatCount ?? 0),
      customBlockedCount: Number(point.customBlockedCount ?? 0),
      avgLatencyMs: point.avgLatencyMs ?? null,
      p50LatencyMs: point.p50LatencyMs ?? point.avgLatencyMs ?? null,
      p75LatencyMs: point.p75LatencyMs ?? point.p95LatencyMs ?? null,
      p95LatencyMs: point.p95LatencyMs ?? null,
      p99LatencyMs: point.p99LatencyMs ?? point.p95LatencyMs ?? null,
    };
  });
  const abnormalEvents = data.abnormal?.events ?? data.events ?? [];
  const normalEvents = data.normal?.events ?? data.normalEvents ?? [];
  const abnormalMapPoints = data.abnormal?.mapPoints ?? data.mapPoints ?? [];
  const normalMapPoints = data.normal?.mapPoints ?? [];
  const normalRequests =
    data.overview?.normalRequests ??
    trend.reduce((sum, point) => sum + point.normalCount, 0) ??
    data.summary.baselineRequests;
  const abnormalRequests =
    data.overview?.abnormalRequests ??
    trend.reduce((sum, point) => sum + point.abnormalCount, 0) ??
    data.summary.total;
  const totalRequests =
    data.overview?.totalRequests ?? normalRequests + abnormalRequests;
  const abnormalRequestRatio =
    data.overview?.abnormalRequestRatio ??
    (totalRequests > 0 ? abnormalRequests / totalRequests : 0);
  const normalRequestRatio =
    data.overview?.normalRequestRatio ??
    (totalRequests > 0 ? normalRequests / totalRequests : 0);

  return {
    ...data,
    trend,
    events: abnormalEvents,
    normalEvents,
    mapPoints: abnormalMapPoints,
    overview: {
      totalRequests,
      normalRequests,
      abnormalRequests,
      abnormalRequestRatio,
      normalRequestRatio,
      pageviews:
        data.overview?.pageviews ??
        trend.reduce((sum, point) => sum + point.pageviews, 0),
      customEvents:
        data.overview?.customEvents ??
        trend.reduce((sum, point) => sum + point.customEvents, 0),
      avgLatencyMs: data.overview?.avgLatencyMs ?? null,
      p50LatencyMs:
        data.overview?.p50LatencyMs ?? data.overview?.avgLatencyMs ?? null,
      p75LatencyMs:
        data.overview?.p75LatencyMs ?? data.overview?.p95LatencyMs ?? null,
      p95LatencyMs: data.overview?.p95LatencyMs ?? null,
      p99LatencyMs:
        data.overview?.p99LatencyMs ?? data.overview?.p95LatencyMs ?? null,
    },
    abnormal: {
      summary: {
        total: abnormalRequests,
        ratio: abnormalRequestRatio,
        highThreat: data.summary.highThreat,
        mediumThreat: data.summary.mediumThreat,
        customBlocked: data.summary.customBlocked,
        affectedSites: data.summary.affectedSites,
        uniqueAsns: data.summary.uniqueAsns,
        uniqueCountries: data.summary.uniqueCountries,
        ...(data.abnormal?.summary ?? {}),
      },
      mapPoints: abnormalMapPoints,
      events: abnormalEvents,
      reasons: data.abnormal?.reasons ?? data.reasons,
      countries: data.abnormal?.countries ?? data.countries,
      asns: data.abnormal?.asns ?? data.asns,
      hasMore: data.abnormal?.hasMore ?? false,
      nextCursor: data.abnormal?.nextCursor ?? null,
    },
    normal: {
      summary: {
        total: normalRequests,
        ratio: normalRequestRatio,
        pageviews: data.overview?.pageviews ?? normalRequests,
        customEvents: data.overview?.customEvents ?? 0,
        affectedSites: data.normal?.summary.affectedSites ?? 0,
        uniqueAsns: data.normal?.summary.uniqueAsns ?? 0,
        uniqueCountries: data.normal?.summary.uniqueCountries ?? 0,
        avgLatencyMs: data.overview?.avgLatencyMs ?? null,
        p50LatencyMs:
          data.overview?.p50LatencyMs ?? data.overview?.avgLatencyMs ?? null,
        p75LatencyMs:
          data.overview?.p75LatencyMs ?? data.overview?.p95LatencyMs ?? null,
        p95LatencyMs: data.overview?.p95LatencyMs ?? null,
        p99LatencyMs:
          data.overview?.p99LatencyMs ?? data.overview?.p95LatencyMs ?? null,
        ...(data.normal?.summary ?? {}),
      },
      mapPoints: normalMapPoints,
      events: normalEvents,
      hasMore: data.normal?.hasMore ?? false,
      nextCursor: data.normal?.nextCursor ?? null,
    },
  };
}

export function RequestObservationClient({
  locale,
  messages,
}: RequestObservationClientProps) {
  const copy = messages.requestObservation;
  const queryClient = useQueryClient();
  const { window: timeWindow } = useDashboardQuery();
  const searchParams = useSearchParams();
  const activeTab = normalizeRequestObservationTab(
    searchParams.get("requestTab"),
  );
  const [loadingMore, setLoadingMore] = useState<"abnormal" | "normal" | null>(
    null,
  );
  const mapAnimationControls = useAnimationControls();
  const observationQueryKey = [
    "dashboard",
    "request-observation",
    timeWindow.from,
    timeWindow.to,
    timeWindow.interval,
    timeWindow.timeZone,
  ] as const;
  const observationQuery = useQuery({
    queryKey: observationQueryKey,
    queryFn: ({ signal }) => fetchRequestObservation(timeWindow, signal),
    enabled: typeof window !== "undefined",
  });
  const data = observationQuery.data ?? null;
  const loading = observationQuery.isPending;
  const refreshing = observationQuery.isFetching && !observationQuery.isPending;
  const setData = (
    updater:
      | RequestObservationData
      | null
      | ((
          current: RequestObservationData | null,
        ) => RequestObservationData | null),
  ) => {
    queryClient.setQueryData<RequestObservationData | null>(
      observationQueryKey,
      (current = null) =>
        typeof updater === "function" ? updater(current) : updater,
    );
  };

  const spanMs = Math.max(1, timeWindow.to - timeWindow.from);
  const windowDetail = formatI18nTemplate(copy.overviewLabels.windowDays, {
    days: Math.max(1, Math.ceil(spanMs / 86400000)),
  });
  const labels = copy.overviewLabels;

  useEffect(() => {
    if (!observationQuery.isError) return;
    const message =
      observationQuery.error instanceof Error
        ? observationQuery.error.message
        : copy.loadFailed;
    toast.error(message || copy.loadFailed);
  }, [
    copy.loadFailed,
    observationQuery.error,
    observationQuery.errorUpdatedAt,
    observationQuery.isError,
  ]);

  const loadMoreEvents = useMemo(
    () => async (source: "abnormal" | "normal") => {
      const section = data?.[source];
      if (!section?.hasMore || !section.nextCursor || loadingMore !== null) {
        return;
      }
      setLoadingMore(source);
      try {
        const page = await fetchRequestObservationPage(
          timeWindow,
          source,
          section.nextCursor,
        );
        setData((current) => {
          if (!current || page.page.source !== source) return current;
          if (source === "abnormal") {
            return {
              ...current,
              events: [...current.events, ...(page.page.events as BotEvent[])],
              abnormal: {
                ...current.abnormal!,
                events: [
                  ...current.abnormal!.events,
                  ...(page.page.events as BotEvent[]),
                ],
                hasMore: page.page.hasMore,
                nextCursor: page.page.nextCursor,
              },
            };
          }
          return {
            ...current,
            normalEvents: [
              ...(current.normalEvents ?? []),
              ...(page.page.events as NormalRequestEvent[]),
            ],
            normal: {
              ...current.normal!,
              events: [
                ...current.normal!.events,
                ...(page.page.events as NormalRequestEvent[]),
              ],
              hasMore: page.page.hasMore,
              nextCursor: page.page.nextCursor,
            },
          };
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy.loadFailed);
      } finally {
        setLoadingMore(null);
      }
    },
    [copy.loadFailed, data, loadingMore, timeWindow],
  );
  const loadMoreAbnormalEvents = useCallback(() => {
    void loadMoreEvents("abnormal");
  }, [loadMoreEvents]);
  const loadMoreNormalEvents = useCallback(() => {
    void loadMoreEvents("normal");
  }, [loadMoreEvents]);

  const trend = data?.trend ?? [];
  const abnormalEvents = data?.abnormal?.events ?? data?.events ?? [];
  const normalEvents = data?.normal?.events ?? data?.normalEvents ?? [];
  const abnormalMapPoints = useMemo(
    () =>
      (data?.abnormal?.mapPoints ?? data?.mapPoints ?? []).map((point) => ({
        ...point,
        source: "abnormal" as const,
        color: ABNORMAL_POINT_COLOR,
      })),
    [data],
  );
  const normalMapPoints = useMemo(
    () =>
      (data?.normal?.mapPoints ?? []).map((point) => ({
        ...point,
        source: "normal" as const,
        color: NORMAL_POINT_COLOR,
      })),
    [data],
  );
  const overviewMapPoints = useMemo(
    () => [...normalMapPoints, ...abnormalMapPoints],
    [abnormalMapPoints, normalMapPoints],
  );
  const activeMap = useMemo<RequestObservationMapConfig>(() => {
    if (activeTab === "abnormal") {
      return {
        key: "abnormal",
        points: abnormalMapPoints,
        pointColor: ABNORMAL_POINT_COLOR,
        collapseOverlappingPointColors: false,
      };
    }
    if (activeTab === "normal") {
      return {
        key: "normal",
        points: normalMapPoints,
        pointColor: NORMAL_POINT_COLOR,
        collapseOverlappingPointColors: false,
      };
    }
    return {
      key: "overview",
      points: overviewMapPoints,
      pointColor: NORMAL_POINT_COLOR,
      collapseOverlappingPointColors: true,
    };
  }, [abnormalMapPoints, activeTab, normalMapPoints, overviewMapPoints]);
  const [renderedMap, setRenderedMap] =
    useState<RequestObservationMapConfig>(activeMap);
  const renderedMapRef = useRef(activeMap);

  useEffect(() => {
    renderedMapRef.current = renderedMap;
  }, [renderedMap]);

  useEffect(() => {
    const currentMap = renderedMapRef.current;
    if (currentMap.key === activeMap.key) {
      setRenderedMap(activeMap);
      return;
    }

    let cancelled = false;
    const direction =
      REQUEST_OBSERVATION_TAB_INDEX[activeMap.key] >
      REQUEST_OBSERVATION_TAB_INDEX[currentMap.key]
        ? 1
        : -1;
    const exitX = direction > 0 ? "-100%" : "100%";
    const enterX = direction > 0 ? "100%" : "-100%";

    void (async () => {
      await mapAnimationControls.start({
        x: exitX,
        transition: REQUEST_MAP_SLIDE_TRANSITION,
      });
      if (cancelled) return;

      mapAnimationControls.set({ x: enterX });
      setRenderedMap(activeMap);

      requestAnimationFrame(() => {
        if (!cancelled) {
          void mapAnimationControls.start({
            x: 0,
            transition: REQUEST_MAP_SLIDE_TRANSITION,
          });
        }
      });
    })();

    return () => {
      cancelled = true;
      mapAnimationControls.stop();
    };
  }, [activeMap, mapAnimationControls]);
  const categoryCounts = useMemo(() => {
    let mediumThreat = 0;
    let highThreat = 0;
    let customBlocked = 0;
    for (const event of abnormalEvents) {
      if (event.category === "high_threat") highThreat += 1;
      else if (event.category === "custom_block") customBlocked += 1;
      else if (event.category === "medium_threat") mediumThreat += 1;
    }
    return { mediumThreat, highThreat, customBlocked };
  }, [abnormalEvents]);

  const analyticsEngineDisabled =
    data?.config?.analyticsEngineDisabled === true;
  const configured = !analyticsEngineDisabled && data?.configured !== false;
  const showDemoOverlay =
    Boolean(data) && !loading && (analyticsEngineDisabled || !configured);
  const overlayTitle = analyticsEngineDisabled
    ? copy.analyticsEngineDisabledTitle
    : copy.notConfiguredTitle;
  const overlayDescription = analyticsEngineDisabled
    ? copy.analyticsEngineDisabledDescription
    : copy.notConfiguredDescription;
  const overlayAction = analyticsEngineDisabled ? (
    <Button asChild>
      <a
        href={data?.config?.analyticsEngineEnableUrl || "#"}
        target="_blank"
        rel="noreferrer"
      >
        {copy.openAnalyticsEngine}
      </a>
    </Button>
  ) : (
    <Button asChild>
      <Link href={`/${locale}/app/manage/system-settings`}>
        {copy.openSettings}
      </Link>
    </Button>
  );

  const detectionTabs = useMemo(
    () =>
      [
        {
          value: "reason",
          label: copy.reason,
          columnLabel: copy.reason,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "category",
          label: copy.category,
          columnLabel: copy.category,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "kind",
          label: copy.kind,
          columnLabel: copy.kind,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "botScoreBucket",
          label: copy.botScoreBucket,
          columnLabel: copy.botScoreBucket,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "verifiedBotCategory",
          label: copy.verifiedBotCategory,
          columnLabel: copy.verifiedBotCategory,
          primaryMetricLabel: copy.blocked,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<DetectionDimensionTab>,
        ...AsyncDimensionBreakdownTab<DetectionDimensionTab>[],
      ],
    [copy],
  );
  const targetTabs = useMemo(
    () =>
      [
        {
          value: "site",
          label: copy.site,
          columnLabel: copy.site,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "hostname",
          label: copy.hostname,
          columnLabel: copy.hostname,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "pathname",
          label: copy.pathname,
          columnLabel: copy.pathname,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "origin",
          label: copy.origin,
          columnLabel: copy.origin,
          primaryMetricLabel: labels.requests,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<TargetDimensionTab>,
        ...AsyncDimensionBreakdownTab<TargetDimensionTab>[],
      ],
    [copy, labels.requests],
  );
  const networkTabs = useMemo(
    () =>
      [
        {
          value: "asOrganization",
          label: copy.asOrganization,
          columnLabel: copy.asOrganization,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "asn",
          label: copy.asn,
          columnLabel: copy.asn,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "country",
          label: copy.country,
          columnLabel: copy.country,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "region",
          label: copy.region,
          columnLabel: copy.region,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "city",
          label: copy.city,
          columnLabel: copy.city,
          primaryMetricLabel: labels.requests,
        },
        {
          value: "colo",
          label: copy.colo,
          columnLabel: copy.colo,
          primaryMetricLabel: labels.requests,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<NetworkDimensionTab>,
        ...AsyncDimensionBreakdownTab<NetworkDimensionTab>[],
      ],
    [copy, labels.requests],
  );
  const clientTabs = useMemo(
    () =>
      [
        {
          value: "ip",
          label: copy.ip,
          columnLabel: copy.ip,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "userAgent",
          label: copy.userAgent,
          columnLabel: copy.userAgent,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "userAgentLengthBucket",
          label: copy.userAgentLengthBucket,
          columnLabel: copy.userAgentLengthBucket,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "ipPrefix",
          label: copy.ipPrefix,
          columnLabel: copy.ipPrefix,
          primaryMetricLabel: copy.blocked,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<ClientDimensionTab>,
        ...AsyncDimensionBreakdownTab<ClientDimensionTab>[],
      ],
    [copy],
  );

  const loadAbnormalDimensionRows = useMemo(
    () =>
      async (
        group: "detection" | "target" | "network" | "client",
        tab: string,
      ) =>
        toAsyncAggregatedDimensionRows(
          await fetchRequestObservationDimension(
            timeWindow,
            "abnormal",
            group,
            tab,
          ),
          group === "network"
            ? {
                networkTab: tab as NetworkDimensionTab,
                locale,
                unknownLabel: copy.emptyValue,
              }
            : group === "target"
              ? { targetTab: tab as TargetDimensionTab }
              : group === "detection"
                ? {
                    detectionTab: tab as DetectionDimensionTab,
                    copy,
                  }
                : undefined,
        ),
    [copy.emptyValue, locale, timeWindow],
  );
  const loadNormalDimensionRows = useMemo(
    () => async (group: "target" | "network", tab: string) =>
      toAsyncAggregatedDimensionRows(
        await fetchRequestObservationDimension(
          timeWindow,
          "normal",
          group,
          tab,
        ),
        group === "network"
          ? {
              networkTab: tab as NetworkDimensionTab,
              locale,
              unknownLabel: copy.emptyValue,
            }
          : group === "target"
            ? { targetTab: tab as TargetDimensionTab }
            : undefined,
      ),
    [copy.emptyValue, locale, timeWindow],
  );
  const loadAbnormalDetectionRows = useCallback(
    (tab: DetectionDimensionTab, _signal?: AbortSignal) =>
      loadAbnormalDimensionRows("detection", tab),
    [loadAbnormalDimensionRows],
  );
  const loadAbnormalTargetRows = useCallback(
    (tab: TargetDimensionTab, _signal?: AbortSignal) =>
      loadAbnormalDimensionRows("target", tab),
    [loadAbnormalDimensionRows],
  );
  const loadAbnormalNetworkRows = useCallback(
    (tab: NetworkDimensionTab, _signal?: AbortSignal) =>
      loadAbnormalDimensionRows("network", tab),
    [loadAbnormalDimensionRows],
  );
  const loadAbnormalClientRows = useCallback(
    (tab: ClientDimensionTab, _signal?: AbortSignal) =>
      loadAbnormalDimensionRows("client", tab),
    [loadAbnormalDimensionRows],
  );
  const loadNormalTargetRows = useCallback(
    (tab: TargetDimensionTab, _signal?: AbortSignal) =>
      loadNormalDimensionRows("target", tab),
    [loadNormalDimensionRows],
  );
  const loadNormalNetworkRows = useCallback(
    (tab: NetworkDimensionTab, _signal?: AbortSignal) =>
      loadNormalDimensionRows("network", tab),
    [loadNormalDimensionRows],
  );

  const requestKey = `${timeWindow.interval}:${data?.generatedAt ?? 0}`;
  const overview = data?.overview;
  const abnormalSummary = data?.abnormal?.summary;
  const normalSummary = data?.normal?.summary;
  const categoryShareItems = useMemo(
    () => [
      {
        key: "normal",
        label: labels.normalTrafficShare,
        value: overview?.normalRequests ?? 0,
        color: NORMAL_TRAFFIC_SHARE_COLOR,
      },
      {
        key: "medium_threat",
        label: labels.mediumThreatTraffic,
        value: abnormalSummary?.mediumThreat ?? categoryCounts.mediumThreat,
        color: MEDIUM_THREAT_TRAFFIC_COLOR,
      },
      {
        key: "high_threat",
        label: labels.highThreatTraffic,
        value: abnormalSummary?.highThreat ?? categoryCounts.highThreat,
        color: HIGH_THREAT_TRAFFIC_COLOR,
      },
      {
        key: "custom_block",
        label: labels.customBlockedTraffic,
        value: abnormalSummary?.customBlocked ?? categoryCounts.customBlocked,
        color: CUSTOM_BLOCKED_TRAFFIC_COLOR,
      },
    ],
    [
      abnormalSummary?.customBlocked,
      abnormalSummary?.highThreat,
      abnormalSummary?.mediumThreat,
      categoryCounts.customBlocked,
      categoryCounts.highThreat,
      categoryCounts.mediumThreat,
      labels.customBlockedTraffic,
      labels.highThreatTraffic,
      labels.mediumThreatTraffic,
      labels.normalTrafficShare,
      overview?.normalRequests,
    ],
  );

  const renderMap = (
    points: RequestMapPoint[],
    pointColor: [number, number, number],
    options?: { collapseOverlappingPointColors?: boolean },
  ) => (
    <div className="relative h-[min(72svh,calc(100svh-10.5rem))] min-h-[18rem] overflow-hidden bg-background sm:min-h-[22rem]">
      <motion.div
        animate={mapAnimationControls}
        initial={false}
        className="h-full"
      >
        <GeoPointsMapIsland
          locale={locale}
          messages={messages}
          points={points}
          loading={loading}
          emptyLabel={copy.noData}
          heightClassName="h-full"
          countryHoverEnabled={false}
          pointColor={pointColor}
          projectionMode="globe"
          autoRotate
          collapseOverlappingPointColors={
            options?.collapseOverlappingPointColors
          }
          pointCrossfadeEnabled={false}
        />
      </motion.div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-background via-background/65 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/70 to-transparent" />
      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-2xl md:left-6 md:top-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {copy.title}
        </h1>
        <p className="mt-1 max-w-prose text-sm text-foreground/75">
          {copy.subtitle}
        </p>
      </div>
      <div className="absolute right-4 top-4 z-10 md:right-6 md:top-6">
        <Button
          type="button"
          variant="outline"
          className="bg-background/90 backdrop-blur"
          onClick={() => void observationQuery.refetch()}
          disabled={loading || refreshing}
        >
          {refreshing ? (
            <Spinner className="size-4" />
          ) : (
            <RiRefreshLine className="size-4" />
          )}
          {copy.refresh}
        </Button>
      </div>
    </div>
  );

  const renderOverviewCharts = () => (
    <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
      <div className="space-y-6">
        <Card className="py-0">
          <CardContent className="p-0">
            <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                icon={RiRadarLine}
                label={labels.totalRequests}
                value={numberFormat(locale, overview?.totalRequests ?? 0)}
                detail={windowDetail}
                loading={loading}
              />
              <MetricTile
                icon={RiShieldCheckLine}
                label={labels.normalRequests}
                value={numberFormat(locale, overview?.normalRequests ?? 0)}
                detail={percentFormat(
                  locale,
                  overview?.normalRequestRatio ?? 0,
                )}
                loading={loading}
              />
              <MetricTile
                icon={RiRobot2Line}
                label={labels.abnormalRatio}
                value={percentFormat(
                  locale,
                  overview?.abnormalRequestRatio ?? 0,
                )}
                detail={numberFormat(locale, overview?.abnormalRequests ?? 0)}
                loading={loading}
              />
              <MetricTile
                icon={RiGlobalLine}
                label={labels.p95Latency}
                value={
                  overview?.p95LatencyMs === null ||
                  overview?.p95LatencyMs === undefined
                    ? "--"
                    : latencyFormat(locale, copy, overview.p95LatencyMs)
                }
                detail={labels.avgLatency}
                loading={loading}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.overviewTrendTitle}</CardTitle>
            <CardDescription>{labels.overviewTrendDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <RequestObservationTrendChart
              data={trend}
              labels={labels}
              locale={locale}
              spanMs={spanMs}
              variant="overview"
              className="h-[320px]"
            />
          </CardContent>
        </Card>

        <section className="grid gap-4 xl:grid-cols-2">
          <ShareRadialCard
            className="xl:col-span-2"
            title={labels.categoryShareTitle}
            items={categoryShareItems}
            maxItems={4}
            locale={locale}
            valueLabel={labels.requests}
            loading={loading}
            emptyLabel={copy.noData}
          />

          <Card>
            <CardHeader>
              <CardTitle>{labels.trafficCompositionTitle}</CardTitle>
              <CardDescription>
                {labels.trafficCompositionDescription}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RequestObservationTrendChart
                data={trend}
                labels={labels}
                locale={locale}
                spanMs={spanMs}
                variant="traffic-composition"
                className="h-[280px]"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{labels.latencyTitle}</CardTitle>
              <CardDescription>{labels.latencyDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <RequestObservationTrendChart
                data={trend}
                labels={labels}
                locale={locale}
                spanMs={spanMs}
                variant="latency"
                latencyFormatter={(valueMs) =>
                  latencyFormat(locale, copy, valueMs)
                }
                className="h-[280px]"
              />
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 pb-6">
      <div className="relative">
        <div
          aria-hidden={showDemoOverlay}
          className={cn(
            "space-y-6 transition duration-200",
            showDemoOverlay && "pointer-events-none select-none blur-sm",
          )}
        >
          {renderMap(renderedMap.points, renderedMap.pointColor, {
            collapseOverlappingPointColors:
              renderedMap.collapseOverlappingPointColors,
          })}

          <AutoResizer initial className="mt-0" duration={0.3}>
            <AutoTransition
              initial={false}
              type="fade"
              transitionKey={activeTab}
            >
              {activeTab === "overview" ? (
                <div className="space-y-6">{renderOverviewCharts()}</div>
              ) : activeTab === "abnormal" ? (
                <div className="space-y-6">
                  <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
                    <div className="space-y-6">
                      <div className="text-sm text-muted-foreground">
                        {labels.abnormalSubtitle}
                      </div>
                      <Card className="py-0">
                        <CardContent className="p-0">
                          <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
                            <MetricTile
                              icon={RiRobot2Line}
                              label={labels.abnormalRequests}
                              value={numberFormat(
                                locale,
                                abnormalSummary?.total ??
                                  overview?.abnormalRequests ??
                                  0,
                              )}
                              detail={windowDetail}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={labels.abnormalRatio}
                              value={percentFormat(
                                locale,
                                abnormalSummary?.ratio ??
                                  overview?.abnormalRequestRatio ??
                                  0,
                              )}
                              detail={labels.totalRequests}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiShieldCheckLine}
                              label={copy.highThreatBots}
                              value={numberFormat(
                                locale,
                                abnormalSummary?.highThreat ?? 0,
                              )}
                              detail={copy.category}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiGlobalLine}
                              label={copy.affectedSites}
                              value={numberFormat(
                                locale,
                                abnormalSummary?.affectedSites ?? 0,
                              )}
                              detail={copy.site}
                              loading={loading}
                            />
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>{copy.trendTitle}</CardTitle>
                          <CardDescription>
                            {copy.trendDescription}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <RequestObservationTrendChart
                            data={trend}
                            labels={labels}
                            locale={locale}
                            spanMs={spanMs}
                            variant="abnormal"
                            className="h-[320px]"
                          />
                        </CardContent>
                      </Card>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={detectionTabs}
                          loadRows={loadAbnormalDetectionRows}
                          requestKey={`${requestKey}:detection`}
                          className="h-full"
                          secondaryMetricLabel={copy.highThreatRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={targetTabs}
                          loadRows={loadAbnormalTargetRows}
                          requestKey={`${requestKey}:target`}
                          className="h-full"
                          secondaryMetricLabel={copy.highThreatRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loadRows={loadAbnormalNetworkRows}
                          requestKey={`${requestKey}:network`}
                          className="h-full"
                          secondaryMetricLabel={copy.highThreatRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={clientTabs}
                          loadRows={loadAbnormalClientRows}
                          requestKey={`${requestKey}:client`}
                          className="h-full"
                          secondaryMetricLabel={copy.highThreatRequests}
                          emptyLabel={copy.noData}
                        />
                      </section>

                      <BotEventsTable
                        locale={locale}
                        messages={messages}
                        copy={copy}
                        events={abnormalEvents}
                        loading={loading}
                        hasMore={data?.abnormal?.hasMore ?? false}
                        loadingMore={loadingMore === "abnormal"}
                        onLoadMore={loadMoreAbnormalEvents}
                        timeWindow={timeWindow}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
                    <div className="space-y-6">
                      <div className="text-sm text-muted-foreground">
                        {labels.normalSubtitle}
                      </div>
                      <Card className="py-0">
                        <CardContent className="p-0">
                          <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
                            <MetricTile
                              icon={RiShieldCheckLine}
                              label={labels.normalRequests}
                              value={numberFormat(
                                locale,
                                normalSummary?.total ??
                                  overview?.normalRequests ??
                                  0,
                              )}
                              detail={percentFormat(
                                locale,
                                normalSummary?.ratio ??
                                  overview?.normalRequestRatio ??
                                  0,
                              )}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={labels.pageviews}
                              value={numberFormat(
                                locale,
                                normalSummary?.pageviews ??
                                  overview?.pageviews ??
                                  0,
                              )}
                              detail={labels.customEvents}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiGlobalLine}
                              label={copy.uniqueCountries}
                              value={numberFormat(
                                locale,
                                normalSummary?.uniqueCountries ?? 0,
                              )}
                              detail={copy.country}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={labels.p95Latency}
                              value={
                                normalSummary?.p95LatencyMs === null ||
                                normalSummary?.p95LatencyMs === undefined
                                  ? "--"
                                  : latencyFormat(
                                      locale,
                                      copy,
                                      normalSummary.p95LatencyMs,
                                    )
                              }
                              detail={labels.avgLatency}
                              loading={loading}
                            />
                          </div>
                        </CardContent>
                      </Card>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={targetTabs}
                          loadRows={loadNormalTargetRows}
                          requestKey={`${requestKey}:normal-target`}
                          className="h-full"
                          showVisitors={false}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loadRows={loadNormalNetworkRows}
                          requestKey={`${requestKey}:normal-network`}
                          className="h-full"
                          showVisitors={false}
                          emptyLabel={copy.noData}
                        />
                      </section>

                      <NormalRequestsTable
                        locale={locale}
                        messages={messages}
                        copy={copy}
                        events={normalEvents}
                        loading={loading}
                        hasMore={data?.normal?.hasMore ?? false}
                        loadingMore={loadingMore === "normal"}
                        onLoadMore={loadMoreNormalEvents}
                      />
                    </div>
                  </div>
                </div>
              )}
            </AutoTransition>
          </AutoResizer>
        </div>

        {showDemoOverlay ? (
          <div className="absolute inset-0 z-30 bg-background/30 px-4">
            <div className="sticky top-[calc(50svh-8rem)] mx-auto flex w-full max-w-lg justify-center py-10">
              <Card
                role="dialog"
                aria-modal="true"
                aria-labelledby="request-observation-overlay-title"
                aria-describedby="request-observation-overlay-description"
                className="w-full border-border/80 bg-background/95 shadow-2xl backdrop-blur"
              >
                <CardHeader>
                  <CardTitle id="request-observation-overlay-title">
                    {overlayTitle}
                  </CardTitle>
                  <CardDescription id="request-observation-overlay-description">
                    {overlayDescription}
                  </CardDescription>
                </CardHeader>
                <CardContent>{overlayAction}</CardContent>
              </Card>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
async function fetchRequestObservation(
  timeWindow: TimeWindow,
  signal?: AbortSignal,
): Promise<RequestObservationData> {
  const payload = await requestAdminService<RequestObservationData>(
    "bot-analytics",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        limit: String(BOT_EVENT_FETCH_LIMIT),
      },
      signal,
    },
  );
  return withRequestObservabilityDefaults(payload);
}

async function fetchRequestObservationPage(
  timeWindow: TimeWindow,
  source: "abnormal" | "normal",
  cursor: RequestDetailCursor,
): Promise<RequestObservationPageData> {
  return requestAdminService<RequestObservationPageData>("bot-analytics", {
    params: {
      from: String(Math.floor(timeWindow.from)),
      to: String(Math.floor(timeWindow.to)),
      interval: timeWindow.interval,
      timeZone: timeWindow.timeZone,
      page: source,
      limit: String(BOT_EVENT_FETCH_LIMIT),
      cursor: JSON.stringify(cursor),
    },
  });
}

async function fetchRequestObservationDimension(
  timeWindow: TimeWindow,
  source: "abnormal" | "normal",
  group: "detection" | "target" | "network" | "client",
  tab: string,
): Promise<RequestNetworkDimensionRow[]> {
  const payload = await requestAdminService<RequestObservationDimensionData>(
    "bot-analytics",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        dimensionSource: source,
        dimensionGroup: group,
        dimensionTab: tab,
      },
    },
  );
  if (!payload.dimension) {
    throw new Error("load_bot_protection_failed");
  }
  return payload.dimension.rows;
}

async function fetchRequestObservationDetail(
  timeWindow: TimeWindow,
  event: BotEvent,
  signal?: AbortSignal,
): Promise<BotEvent | null> {
  const payload = await requestAdminService<RequestObservationDetailData>(
    "bot-analytics",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        detail: "1",
        ...(event.traceId ? { traceId: event.traceId } : {}),
        ...(event.rayId ? { rayId: event.rayId } : {}),
      },
      signal,
    },
  );
  return payload.detail;
}

function compactReason(reason: string): string {
  return reason.replace(/_/g, " ");
}

function botReasonLabel(
  copy: AppMessages["requestObservation"],
  reason: string,
): string {
  const labels: Readonly<Record<string, string>> = copy.botReasonLabels;
  return labels[reason] ?? compactReason(reason);
}

function requestCategoryLabel(
  copy: AppMessages["requestObservation"],
  category: string,
): string {
  const labels = copy.overviewLabels;
  if (category === "medium_threat") return labels.mediumThreatTraffic;
  if (category === "high_threat") return labels.highThreatTraffic;
  if (category === "custom_block") return labels.customBlockedTraffic;
  return compactReason(category);
}

function botReasonCombinationLabel(
  copy: AppMessages["requestObservation"],
  value: string,
): string {
  return value
    .split(",")
    .map((reason) => reason.trim())
    .filter(Boolean)
    .map((reason) => botReasonLabel(copy, reason))
    .join(", ");
}

function requestKindLabel(
  copy: AppMessages["requestObservation"],
  kind: string,
): string {
  const labels: Readonly<Record<string, string>> = copy.requestKindLabels;
  return labels[kind] ?? (compactReason(kind) || emptyValue(copy));
}

function emptyValue(copy: AppMessages["requestObservation"]): string {
  return copy.emptyValue;
}

function botScoreBucket(score: number | null): string {
  if (score === null) return "";
  if (score < 20) return "1-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-99";
}

function userAgentLengthBucket(length: number): string {
  if (!Number.isFinite(length) || length <= 0) return "";
  if (length < 80) return "1-79";
  if (length < 160) return "80-159";
  if (length < 256) return "160-255";
  if (length < 512) return "256-511";
  return "512+";
}

function ipPrefix(ip: string): string {
  const value = ip.trim();
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  if (value.includes(":")) {
    const parts = value.split(":").filter(Boolean);
    if (parts.length >= 4) return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return value;
}

function _valuesForDetectionTab(
  event: BotEvent,
  tab: DetectionDimensionTab,
  copy: AppMessages["requestObservation"],
): string[] {
  if (tab === "reason") {
    return event.reasons.map((reason) => botReasonLabel(copy, reason));
  }
  if (tab === "category") return [event.category];
  if (tab === "kind") return [event.kind];
  if (tab === "botScoreBucket") return [botScoreBucket(event.botScore)];
  return [event.verifiedBotCategory];
}

function _valuesForTargetTab(
  event: BotEvent,
  tab: TargetDimensionTab,
): string[] {
  if (tab === "site") {
    return [event.siteName || event.siteDomain || event.siteId];
  }
  if (tab === "hostname") return [event.hostname];
  if (tab === "pathname") return [event.pathname || "/"];
  return [event.origin];
}

function _valuesForNetworkTab(
  event: BotEvent,
  tab: NetworkDimensionTab,
): string[] {
  if (tab === "asOrganization") return [event.asOrganization];
  if (tab === "asn") return [event.asn ? `AS${event.asn}` : ""];
  if (tab === "country") return [event.country];
  if (tab === "region") return [event.region];
  if (tab === "city") return [event.city];
  return [event.colo];
}

function _valuesForClientTab(
  event: BotEvent,
  tab: ClientDimensionTab,
): string[] {
  if (tab === "ip") return [event.ip];
  if (tab === "userAgent") return [event.userAgent];
  if (tab === "userAgentLengthBucket") {
    return [userAgentLengthBucket(event.userAgentLength)];
  }
  return [ipPrefix(event.ip)];
}

function _aggregateDimensionRows(
  events: BotEvent[],
  copy: AppMessages["requestObservation"],
  resolveValues: (event: BotEvent) => string[],
): BotDimensionRow[] {
  const rowMap = new Map<
    string,
    { count: number; highThreat: number; sampleEvent: BotEvent | null }
  >();

  for (const event of events) {
    const values = resolveValues(event)
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedValues = values.length > 0 ? values : [emptyValue(copy)];
    for (const value of normalizedValues) {
      const current = rowMap.get(value) ?? {
        count: 0,
        highThreat: 0,
        sampleEvent: event,
      };
      current.count += 1;
      if (event.category === "high_threat") current.highThreat += 1;
      current.sampleEvent ??= event;
      rowMap.set(value, current);
    }
  }

  return Array.from(rowMap.entries())
    .map(([label, row]) => ({
      label,
      count: row.count,
      highThreat: row.highThreat,
      sampleEvent: row.sampleEvent,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.highThreat - left.highThreat ||
        left.label.localeCompare(right.label),
    )
    .slice(0, DIMENSION_ROW_LIMIT);
}

function formatAsn(event: BotEvent): string {
  if (!event.asn && !event.asOrganization) return "--";
  if (!event.asn) return event.asOrganization;
  if (!event.asOrganization) return `AS${event.asn}`;
  return `AS${event.asn} ${event.asOrganization}`;
}

function formatNormalAsn(event: NormalRequestEvent): string {
  if (!event.asn && !event.asOrganization) return "--";
  if (!event.asn) return event.asOrganization;
  if (!event.asOrganization) return `AS${event.asn}`;
  return `AS${event.asn} ${event.asOrganization}`;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  loading,
}: {
  icon: typeof RiRobot2Line;
  label: string;
  value: string;
  detail: string;
  loading: boolean;
}) {
  const contentKey = loading ? "loading" : value;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial className="mt-3">
        <AutoTransition
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <p
              key={value}
              className="min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums"
            >
              {value}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function faviconLabelForEvent(
  event: BotEvent | null,
  tab: TargetDimensionTab,
): string | undefined {
  if (!event) return undefined;
  if (tab === "site") return event.siteDomain || event.hostname || event.origin;
  if (tab === "hostname") return event.hostname || event.siteDomain;
  if (tab === "origin")
    return event.origin || event.hostname || event.siteDomain;
  return undefined;
}

function countryFlagAppearance(
  rawCountry: string,
  locale: Locale,
  unknownLabel: string,
): {
  label: string;
  appearance: AsyncDimensionBreakdownLabelAppearance | undefined;
} {
  const country = resolveCountryLabel(rawCountry, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  return {
    label: country.label,
    appearance: {
      type: "leadingIcon",
      iconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    },
  };
}

function regionAppearance(
  row: BotDimensionRow,
  locale: Locale,
  unknownLabel: string,
): AsyncDimensionBreakdownLabelAppearance | undefined {
  const event = row.sampleEvent;
  if (!event) return undefined;
  const country = resolveCountryLabel(event.country, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel = row.label.trim() || event.region.trim() || unknownLabel;
  const hasRegion = Boolean(event.region.trim());

  return {
    type: "geoRegion",
    countryLabel: country.label,
    countryIconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    regionLabel,
    countryCode: country.code ?? event.country,
    stateCode: event.region,
    hideRegion: !hasRegion,
  };
}

function cityAppearance(
  row: BotDimensionRow,
  locale: Locale,
  unknownLabel: string,
): AsyncDimensionBreakdownLabelAppearance | undefined {
  const event = row.sampleEvent;
  if (!event) return undefined;
  const country = resolveCountryLabel(event.country, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel = event.region.trim() || unknownLabel;
  const cityLabel = row.label.trim() || event.city.trim() || unknownLabel;
  const hasRegion = Boolean(event.region.trim());
  const hasCity = Boolean(event.city.trim());

  return {
    type: "geoCity",
    countryLabel: country.label,
    countryIconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    regionLabel,
    cityLabel,
    countryCode: country.code ?? event.country,
    stateCode: event.region,
    cityNameDefault: event.city,
    hideRegion: !hasRegion,
    hideCity: !hasCity,
  };
}

function toAsyncDimensionRows(
  rows: BotDimensionRow[],
  options?: {
    targetTab?: TargetDimensionTab;
    networkTab?: NetworkDimensionTab;
    locale?: Locale;
    unknownLabel?: string;
  },
): AsyncDimensionBreakdownRow[] {
  return rows.map((row) => ({
    key: row.label,
    label:
      options?.networkTab === "country" &&
      options.locale &&
      options.unknownLabel
        ? countryFlagAppearance(row.label, options.locale, options.unknownLabel)
            .label
        : row.label,
    views: row.count,
    visitors: row.highThreat,
    mono: row.label.includes("/") || row.label.includes(":"),
    labelAppearance:
      options?.targetTab && options.targetTab !== "pathname"
        ? {
            type: "favicon",
            iconLabel: faviconLabelForEvent(row.sampleEvent, options.targetTab),
          }
        : options?.networkTab === "country" &&
            options.locale &&
            options.unknownLabel
          ? countryFlagAppearance(
              row.label,
              options.locale,
              options.unknownLabel,
            ).appearance
          : options?.networkTab === "region" &&
              options.locale &&
              options.unknownLabel
            ? regionAppearance(row, options.locale, options.unknownLabel)
            : options?.networkTab === "city" &&
                options.locale &&
                options.unknownLabel
              ? cityAppearance(row, options.locale, options.unknownLabel)
              : undefined,
  }));
}

function _toAsyncNetworkDimensionRows(
  rows: RequestNetworkDimensionRow[] | undefined,
  fallbackRows: BotDimensionRow[],
  options: {
    networkTab: NetworkDimensionTab;
    locale: Locale;
    unknownLabel: string;
  },
): AsyncDimensionBreakdownRow[] {
  if (!rows) return toAsyncDimensionRows(fallbackRows, options);

  const dimensionRows = rows.map((row) => ({
    label:
      options.networkTab === "asn" && row.label
        ? `AS${row.label}`
        : row.label || options.unknownLabel,
    count: row.count,
    highThreat: row.highThreat,
    sampleEvent: {
      country: row.country,
      region: row.region,
      city: options.networkTab === "city" ? row.label : "",
    } as BotEvent,
  }));

  return toAsyncDimensionRows(dimensionRows, options).map((row, index) => ({
    ...row,
    key: rows[index]?.key || row.key,
  }));
}

function toAsyncAggregatedDimensionRows(
  rows: RequestNetworkDimensionRow[],
  options?: Parameters<typeof toAsyncDimensionRows>[1] & {
    detectionTab?: DetectionDimensionTab;
    copy?: AppMessages["requestObservation"];
  },
): AsyncDimensionBreakdownRow[] {
  return toAsyncDimensionRows(
    rows.map((row) => ({
      label:
        options?.detectionTab === "reason" && options.copy
          ? botReasonCombinationLabel(options.copy, row.label)
          : options?.detectionTab === "category" && options.copy
            ? requestCategoryLabel(options.copy, row.label)
            : options?.networkTab === "asn" && row.label
              ? `AS${row.label}`
              : row.label || options?.unknownLabel || "--",
      count: row.count,
      highThreat: row.highThreat,
      sampleEvent: {
        country: row.country,
        region: options?.networkTab === "region" ? row.label : row.region,
        city: row.label,
        siteDomain: row.iconLabel,
        hostname: options?.targetTab === "hostname" ? row.label : "",
        origin: options?.targetTab === "origin" ? row.label : "",
      } as BotEvent,
    })),
    options,
  ).map((row, index) => ({ ...row, key: rows[index]?.key || row.key }));
}

function displayValue(
  value: string | number | null | undefined,
  empty: string,
) {
  if (value === null || value === undefined || value === "") return empty;
  return String(value);
}

function metadataEntries(
  metadataJson: string | undefined,
): Array<[string, string]> {
  const raw = (metadataJson ?? "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [["metadata", raw]];
    }
    return Object.entries(parsed as Record<string, unknown>).map(
      ([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ],
    );
  } catch {
    return [["metadata", raw]];
  }
}

const RequestDetailLocationMap = memo(function RequestDetailLocationMap({
  locale,
  messages,
  country,
  latitude,
  longitude,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  country: string;
  latitude: number | null;
  longitude: number | null;
  loading: boolean;
}) {
  const hasLocation =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Number(latitude) >= -90 &&
    Number(latitude) <= 90 &&
    Number(longitude) >= -180 &&
    Number(longitude) <= 180;
  const points = useMemo(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(latitude),
              longitude: Number(longitude),
              country,
            },
          ]
        : [],
    [country, hasLocation, latitude, longitude],
  );

  return (
    <AutoResizer className="w-full" duration={0.24}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        {loading ? (
          <Skeleton key="loading" className="h-[11rem] w-full sm:h-[13rem]" />
        ) : (
          <div key="ready" className="w-full">
            <GeoPointsMapIsland
              locale={locale}
              messages={messages}
              points={points}
              emptyLabel={messages.realtime.visitorMapUnavailable}
              heightClassName="h-[11rem] sm:h-[13rem]"
              initialZoom={0.3}
              countryHoverEnabled={false}
              reuseMaps
            />
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});

const DetailItem = memo(function DetailItem({
  label,
  value,
  loading = false,
  wide = false,
  inline = false,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
  wide?: boolean;
  inline?: boolean;
}) {
  const skeletonClassName = wide
    ? "my-1 h-3 w-[min(20rem,88%)]"
    : "my-1 h-3 w-[min(11rem,78%)]";

  return (
    <div
      className={cn(
        "min-w-0 space-y-1",
        wide && "sm:col-span-2",
        inline &&
          "grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] items-baseline gap-x-3 space-y-0",
      )}
    >
      <dt className={cn("text-muted-foreground", inline && "min-w-0 truncate")}>
        {label}
      </dt>
      <dd className={cn("min-w-0", inline && "min-h-5")}>
        <AutoResizer className="min-w-0" duration={0.2}>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : "ready"}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="flex min-h-5 min-w-0 items-center"
          >
            {loading ? (
              <Skeleton key="loading" className={skeletonClassName} />
            ) : (
              <div key="ready" className="min-h-5 min-w-0 leading-5">
                {value}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </dd>
    </div>
  );
});

function CategoryBlocks({
  category,
  label,
}: {
  category: string;
  label?: string;
}) {
  const normalized = category.trim().toLowerCase();
  const activeCount =
    normalized === "medium_threat"
      ? 2
      : normalized === "high_threat" || normalized === "custom_block"
        ? 3
        : 0;
  const activeColor =
    normalized === "medium_threat"
      ? "bg-amber-500"
      : normalized === "high_threat"
        ? "bg-red-500"
        : normalized === "custom_block"
          ? "bg-muted-foreground"
          : "";

  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={label || category || undefined}
    >
      {Array.from({ length: 3 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 shrink-0",
            index < activeCount ? activeColor : "bg-muted-foreground/25",
          )}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function RequestObservationRowSkeletonContent({
  index,
  columns,
  widths,
  alignments,
}: {
  index: number;
  columns: readonly string[];
  widths: Readonly<Record<string, string>>;
  alignments: Readonly<Record<string, RequestObservationColumnAlignment>>;
}) {
  return (
    <>
      {columns.map((columnId) => (
        <TableCell
          key={`${index}:${columnId}`}
          className={cn(
            columnId === "id" && "pl-4",
            alignments[columnId] === "center" && "text-center",
            alignments[columnId] === "right" && "text-right",
          )}
        >
          {columnId === "id" ? (
            <div className="flex w-28 min-w-0 items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ) : (
            <Skeleton
              className={cn(
                "h-4",
                widths[columnId],
                alignments[columnId] === "center" && "mx-auto",
                alignments[columnId] === "right" && "ml-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
  );
}

function BotRequestDetailDrawer({
  locale,
  messages,
  copy,
  previewEvent,
  detailEvent,
  loading,
  error,
  open,
  onOpenChange,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  previewEvent: BotEvent | null;
  detailEvent: BotEvent | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const empty = copy.emptyValue;
  const preview = detailEvent ?? previewEvent;
  const event = preview ?? BOT_EVENT_DETAIL_SKELETON_DATA;
  const hasEvent = Boolean(preview);
  const metadata = event ? metadataEntries(event.metadataJson) : [];
  const eventId = event ? event.traceId || event.rayId : "";
  const subtitle = eventId || copy.detailSubtitle;

  const stopSideDrawerOverlayEvent = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  const closeSideDrawerFromOverlay = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    stopSideDrawerOverlayEvent(event);
    onOpenChange(false);
  };

  return (
    <>
      <AppOverlay
        layerId="request-observation-drawer"
        open={open}
        portal
        zIndex={overlayZIndexFor(EVENT_RECORD_DRAWER_Z_INDEX)}
        onPointerDown={stopSideDrawerOverlayEvent}
        onPointerUp={stopSideDrawerOverlayEvent}
        onClick={closeSideDrawerFromOverlay}
      />
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        modal={false}
      >
        <DrawerContent
          data-dashboard-floating-layer="request-observation-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          style={{ zIndex: EVENT_RECORD_DRAWER_Z_INDEX }}
          onFocusOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{copy.detailTitle}</DrawerTitle>
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : subtitle}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-44" />
              ) : (
                <DrawerDescription key="ready">{subtitle}</DrawerDescription>
              )}
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {error ? (
              <div className="flex h-64 items-center justify-center text-center text-sm text-muted-foreground">
                {error}
              </div>
            ) : !hasEvent && !loading ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {copy.noData}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.detailTitle}</h3>
                  <AutoResizer className="w-full" duration={0.2}>
                    <AutoTransition
                      initial={false}
                      transitionKey={loading ? "loading" : "ready"}
                      duration={0.18}
                      type="fade"
                      presenceMode="wait"
                      className="w-full"
                    >
                      {loading ? (
                        <div
                          key="loading"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Skeleton className="h-5 w-20" />
                          <Skeleton className="h-5 w-28" />
                          <Skeleton className="h-4 w-32" />
                        </div>
                      ) : (
                        <div
                          key="ready"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Badge variant="outline">
                            <CategoryBlocks
                              category={event.category}
                              label={
                                event.category
                                  ? requestCategoryLabel(copy, event.category)
                                  : empty
                              }
                            />
                          </Badge>
                          {event.reasons.map((reason) => (
                            <Badge key={reason} variant="outline">
                              {botReasonLabel(copy, reason)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </AutoTransition>
                  </AutoResizer>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.time}
                      value={shortDateTimeWithSeconds(locale, event.receivedAt)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.kind}
                      value={displayValue(event.kind, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.botScoreBucket}
                      value={botScoreBucket(event.botScore)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.botScore}
                      value={
                        event.botScore === null ||
                        !Number.isFinite(event.botScore)
                          ? empty
                          : numberFormat(locale, event.botScore)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.verifiedBotCategory}
                      value={displayValue(event.verifiedBotCategory, empty)}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.request}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.site}
                      value={
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {displayValue(event.siteName, empty)}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {displayValue(
                              event.siteDomain || event.siteId,
                              empty,
                            )}
                          </div>
                        </div>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.siteId}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.siteId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.normalDetail.requestMethod}
                      value={displayValue(
                        metadata.find(([key]) => key === "requestMethod")?.[1],
                        empty,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.origin}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.origin, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.hostname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.hostname, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.pathname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.pathname || "/", empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.edge}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.location}
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={event.country || ""}
                          region={event.region}
                          city={event.city}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.colo}
                      value={displayValue(event.colo, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.network}
                      value={displayValue(formatAsn(event), empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.continent}
                      value={displayValue(event.continent, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.latitude}
                      value={
                        event.latitude === null ||
                        !Number.isFinite(event.latitude)
                          ? empty
                          : numberFormat(locale, event.latitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.longitude}
                      value={
                        event.longitude === null ||
                        !Number.isFinite(event.longitude)
                          ? empty
                          : numberFormat(locale, event.longitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.ip}
                      value={
                        <span className="font-mono">
                          {displayValue(event.ip, empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <RequestDetailLocationMap
                  locale={locale}
                  messages={messages}
                  country={event.country || ""}
                  latitude={event.latitude}
                  longitude={event.longitude}
                  loading={loading}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.client}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLengthBucket}
                      value={
                        event.userAgentLength
                          ? userAgentLengthBucket(event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLength}
                      value={
                        event.userAgentLength > 0
                          ? numberFormat(locale, event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.ipPrefix}
                      value={ipPrefix(event.ip)}
                    />
                  </dl>
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      {copy.fullUserAgent}
                    </div>
                    <div className="break-all rounded-none border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
                      {displayValue(event.userAgent, empty)}
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.identifiers}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      wide
                      label="Trace ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.traceId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label="Ray ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.rayId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.country}
                      value={displayValue(event.country, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.asn}
                      value={displayValue(
                        event.asn ? `AS${event.asn}` : "",
                        empty,
                      )}
                    />
                  </dl>
                </section>

                {metadata.length > 0 ? (
                  <>
                    <Separator />
                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{copy.metadata}</h3>
                      <dl className="grid gap-3">
                        {metadata.map(([key, value]) => (
                          <DetailItem
                            key={key}
                            loading={loading}
                            inline
                            label={key}
                            value={
                              <span className="break-all font-mono text-xs text-muted-foreground">
                                {displayValue(value, empty)}
                              </span>
                            }
                          />
                        ))}
                      </dl>
                    </section>
                  </>
                ) : null}
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </>
  );
}

function NormalRequestDetailDrawer({
  locale,
  messages,
  copy,
  event,
  open,
  onOpenChange,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  event: NormalRequestEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const empty = copy.emptyValue;
  const eventId = event ? event.traceId || event.rayId : "";
  const title = copy.normalDetail.title;
  const subtitle = eventId || copy.normalDetail.subtitle;
  const requestMethodLabel = copy.normalDetail.requestMethod;
  const edgeLatencyLabel = copy.normalDetail.edgeLatency;
  const eventAtLabel = copy.normalDetail.eventAt;
  const receivedAtLabel = copy.normalDetail.receivedAt;
  const continentLabel = copy.normalDetail.continent;
  const metadata = event ? metadataEntries(event.metadataJson) : [];

  const stopSideDrawerOverlayEvent = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  const closeSideDrawerFromOverlay = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    stopSideDrawerOverlayEvent(event);
    onOpenChange(false);
  };

  return (
    <>
      <AppOverlay
        layerId="request-observation-normal-drawer"
        open={open}
        portal
        zIndex={overlayZIndexFor(EVENT_RECORD_DRAWER_Z_INDEX)}
        onPointerDown={stopSideDrawerOverlayEvent}
        onPointerUp={stopSideDrawerOverlayEvent}
        onClick={closeSideDrawerFromOverlay}
      />
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        modal={false}
      >
        <DrawerContent
          data-dashboard-floating-layer="request-observation-normal-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          style={{ zIndex: EVENT_RECORD_DRAWER_Z_INDEX }}
          onFocusOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{title}</DrawerTitle>
            <AutoTransition
              initial={false}
              transitionKey={eventId || "ready"}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              <DrawerDescription key="ready">{subtitle}</DrawerDescription>
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {!event ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {copy.noData}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{title}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={receivedAtLabel}
                      value={shortDateTimeWithSeconds(locale, event.receivedAt)}
                    />
                    <DetailItem
                      label={eventAtLabel}
                      value={shortDateTimeWithSeconds(locale, event.eventAt)}
                    />
                    <DetailItem
                      label={copy.kind}
                      value={requestKindLabel(copy, event.kind)}
                    />
                    <DetailItem
                      label={requestMethodLabel}
                      value={displayValue(event.requestMethod, empty)}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.request}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={copy.site}
                      value={
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {displayValue(event.siteName, empty)}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {displayValue(
                              event.siteDomain || event.siteId,
                              empty,
                            )}
                          </div>
                        </div>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.siteId}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.siteId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      wide
                      label={copy.origin}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.origin, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      wide
                      label={copy.hostname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.hostname, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      wide
                      label={copy.pathname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.pathname || "/", empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.edge}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={edgeLatencyLabel}
                      value={latencyFormat(locale, copy, event.edgeLatencyMs)}
                    />
                    <DetailItem
                      wide
                      label={copy.location}
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={event.country || ""}
                          region={event.region}
                          city={event.city}
                        />
                      }
                    />
                    <DetailItem
                      label={copy.colo}
                      value={displayValue(event.colo, empty)}
                    />
                    <DetailItem
                      label={copy.network}
                      value={displayValue(formatNormalAsn(event), empty)}
                    />
                    <DetailItem
                      label={messages.common.latitude}
                      value={
                        event.latitude === null ||
                        !Number.isFinite(event.latitude)
                          ? empty
                          : numberFormat(locale, event.latitude)
                      }
                    />
                    <DetailItem
                      label={messages.common.longitude}
                      value={
                        event.longitude === null ||
                        !Number.isFinite(event.longitude)
                          ? empty
                          : numberFormat(locale, event.longitude)
                      }
                    />
                    <DetailItem
                      label={continentLabel}
                      value={displayValue(event.continent, empty)}
                    />
                  </dl>
                </section>

                <RequestDetailLocationMap
                  locale={locale}
                  messages={messages}
                  country={event.country || ""}
                  latitude={event.latitude}
                  longitude={event.longitude}
                  loading={false}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.client}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={copy.userAgentLengthBucket}
                      value={
                        event.userAgentLength
                          ? userAgentLengthBucket(event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      label={copy.userAgentLength}
                      value={
                        event.userAgentLength > 0
                          ? numberFormat(locale, event.userAgentLength)
                          : empty
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.identifiers}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      wide
                      label={copy.id}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(eventId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      wide
                      label="Trace ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.traceId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      wide
                      label="Ray ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.rayId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      label={copy.country}
                      value={displayValue(event.country, empty)}
                    />
                    <DetailItem
                      label={copy.asn}
                      value={displayValue(
                        event.asn ? `AS${event.asn}` : "",
                        empty,
                      )}
                    />
                  </dl>
                </section>

                {metadata.length > 0 ? (
                  <>
                    <Separator />
                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{copy.metadata}</h3>
                      <dl className="grid gap-3">
                        {metadata.map(([key, value]) => (
                          <DetailItem
                            key={key}
                            inline
                            label={key}
                            value={
                              <span className="break-all font-mono text-xs text-muted-foreground">
                                {displayValue(value, empty)}
                              </span>
                            }
                          />
                        ))}
                      </dl>
                    </section>
                  </>
                ) : null}
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </>
  );
}

const BotEventsTable = memo(function BotEventsTable({
  locale,
  messages,
  copy,
  events,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  timeWindow,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  events: BotEvent[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  timeWindow: TimeWindow;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedEvent, setSelectedEvent] = useState<BotEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [detailParam, setDetailParam] = useState(
    () => searchParams.get("detail")?.trim() || "",
  );
  const selectedEventId = selectedEvent ? botEventDetailId(selectedEvent) : "";
  const selectedEventCacheKey = selectedEventId
    ? selectedEventId
    : selectedEvent
      ? `${selectedEvent.siteId}:${selectedEvent.pathname}:${selectedEvent.receivedAt}`
      : "";
  const detailQuery = useQuery({
    queryKey: [
      "dashboard",
      "request-observation-detail",
      selectedEventCacheKey,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
    ],
    queryFn: ({ signal }) =>
      selectedEvent
        ? fetchRequestObservationDetail(timeWindow, selectedEvent, signal)
        : null,
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedEvent),
    retry: false,
  });
  const detailEvent = detailQuery.data ?? null;
  const detailLoading = detailQuery.isPending;
  const detailError = detailQuery.isError
    ? detailQuery.error instanceof Error
      ? detailQuery.error.message
      : "load_bot_protection_detail_failed"
    : null;

  useEffect(() => {
    setDetailParam(searchParams.get("detail")?.trim() || "");
  }, [searchParams]);

  useEffect(() => {
    const handlePopState = () => {
      setDetailParam(
        new URLSearchParams(window.location.search).get("detail")?.trim() || "",
      );
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const updateDetailParam = useCallback(
    (detailId: string, mode: "push" | "replace") => {
      const nextParams = new URLSearchParams(window.location.search);
      if (detailId) nextParams.set("detail", detailId);
      else nextParams.delete("detail");

      const nextQuery = nextParams.toString();
      const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      if (`${window.location.pathname}${window.location.search}` === nextUrl) {
        setDetailParam(detailId);
        return;
      }
      if (mode === "push") window.history.pushState(null, "", nextUrl);
      else window.history.replaceState(null, "", nextUrl);
      setDetailParam(detailId);
    },
    [pathname],
  );

  const openEvent = useCallback(
    (event: BotEvent, options?: { syncUrl?: boolean }) => {
      setSelectedEvent(event);
      setDrawerOpen(true);

      if (options?.syncUrl !== false) {
        const detailId = botEventDetailId(event);
        if (detailId) updateDetailParam(detailId, "push");
      }
    },
    [updateDetailParam],
  );

  const handleDrawerOpenChange = useCallback(
    (nextOpen: boolean) => {
      setDrawerOpen(nextOpen);
      if (nextOpen || !detailParam) return;
      updateDetailParam("", "replace");
    },
    [detailParam, updateDetailParam],
  );

  useEffect(() => {
    if (!detailParam) {
      setDrawerOpen(false);
      return;
    }
    const matchingEvent = events.find(
      (event) => event.traceId === detailParam || event.rayId === detailParam,
    );
    if (!matchingEvent) return;
    if (selectedEvent && botEventDetailId(selectedEvent) === detailParam) {
      setDrawerOpen(true);
      return;
    }
    openEvent(matchingEvent, { syncUrl: false });
  }, [detailParam, events, openEvent, selectedEvent]);

  const handleKeyDown = useCallback(
    (keyboardEvent: KeyboardEvent<HTMLTableRowElement>, event: BotEvent) => {
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
      keyboardEvent.preventDefault();
      openEvent(event);
    },
    [openEvent],
  );

  const columnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<AbnormalRequestTableColumnId>[]
  >(
    () => [
      { id: "id", label: copy.id, required: true },
      { id: "time", label: copy.time, required: true },
      { id: "site", label: copy.site, required: true },
      { id: "kind", label: copy.kind },
      { id: "reason", label: copy.reason },
      { id: "category", label: copy.category },
      { id: "network", label: copy.network },
      { id: "ip", label: copy.ip },
      { id: "location", label: copy.location },
      { id: "pathname", label: copy.pathname },
      { id: "userAgent", label: copy.userAgent },
      { id: "botScore", label: copy.botScore },
      { id: "verifiedBotCategory", label: copy.verifiedBotCategory },
    ],
    [copy],
  );
  const tableColumns = useAnalyticsTableColumns({
    storageKey:
      "insightflare:analytics-table-columns:request-observation-abnormal",
    columns: columnDefinitions,
  });
  const headers = useMemo<Record<AbnormalRequestTableColumnId, ReactNode>>(
    () => ({
      id: <TableHead className="pl-4">{copy.id}</TableHead>,
      time: <TableHead className="text-center">{copy.time}</TableHead>,
      site: <TableHead>{copy.site}</TableHead>,
      kind: <TableHead>{copy.kind}</TableHead>,
      reason: <TableHead>{copy.reason}</TableHead>,
      category: <TableHead className="text-center">{copy.category}</TableHead>,
      botScore: <TableHead className="text-right">{copy.botScore}</TableHead>,
      verifiedBotCategory: <TableHead>{copy.verifiedBotCategory}</TableHead>,
      network: <TableHead>{copy.network}</TableHead>,
      ip: <TableHead>{copy.ip}</TableHead>,
      location: <TableHead>{copy.location}</TableHead>,
      pathname: <TableHead>{copy.pathname}</TableHead>,
      userAgent: <TableHead className="pr-4">{copy.userAgent}</TableHead>,
    }),
    [copy],
  );
  const tableHeader = useMemo(
    () => (
      <TableRow>
        {tableColumns.visibleIds.map((columnId) => (
          <Fragment key={columnId}>{headers[columnId]}</Fragment>
        ))}
      </TableRow>
    ),
    [headers, tableColumns.visibleIds],
  );
  const renderRow = useCallback(
    (event: BotEvent) => {
      const reasonLabel = botReasonLabel(copy, event.reasons[0] || "");
      const reasonItems =
        event.reasons.length > 0
          ? event.reasons.map((reason, index) => {
              const value = botReasonLabel(copy, reason);
              return {
                label: `${copy.reason}#${index + 1}`,
                value,
                copyValue: value,
              };
            })
          : [
              {
                label: copy.reason,
                value: reasonLabel || emptyValue(copy),
                copyValue: reasonLabel || undefined,
              },
            ];
      const eventId = event.traceId || event.rayId || "";
      const kindLabel = requestKindLabel(copy, event.kind);
      const categoryLabel = event.category
        ? requestCategoryLabel(copy, event.category)
        : emptyValue(copy);
      const siteLabel =
        event.siteName || event.siteDomain || event.siteId || emptyValue(copy);
      const siteCopyValue =
        event.siteName || event.siteDomain || event.siteId || undefined;
      const hostnameLabel = event.hostname || emptyValue(copy);
      const hostnameCopyValue = event.hostname || undefined;
      const networkLabel = event.asOrganization || emptyValue(copy);
      const networkCopyValue = event.asOrganization || undefined;
      const asnLabel = event.asn ? `AS${event.asn}` : emptyValue(copy);
      const asnCopyValue = event.asn ? `AS${event.asn}` : undefined;
      const botScoreLabel =
        event.botScore === null || !Number.isFinite(event.botScore)
          ? emptyValue(copy)
          : numberFormat(locale, event.botScore);
      const verifiedBotCategoryLabel =
        event.verifiedBotCategory || emptyValue(copy);
      const verifiedBotCategoryCopyValue =
        event.verifiedBotCategory || undefined;
      const pathnameLabel = event.pathname || "/";
      const userAgentLabel = event.userAgent || emptyValue(copy);
      const cells: Record<AbnormalRequestTableColumnId, ReactNode> = {
        id: (
          <TableCell className="pl-4 max-w-36">
            <div className="flex w-28 min-w-0 items-center gap-2">
              <VisitorAvatar seed={eventId || "unknown"} className="size-6" />
              <AnalyticsDetailsTooltipTarget
                className="min-w-0 flex-1 truncate"
                locale={locale}
                request={{
                  key: `request-observation-abnormal-id:${eventId}:${event.receivedAt}`,
                  items: [
                    {
                      label: copy.id,
                      value: eventId || emptyValue(copy),
                      copyValue: eventId || undefined,
                    },
                  ],
                }}
              >
                <span className="truncate font-mono">
                  {eventId ? shortId(eventId) : "--"}
                </span>
              </AnalyticsDetailsTooltipTarget>
            </div>
          </TableCell>
        ),
        time: (
          <TableCell className="max-w-36 text-center font-mono text-muted-foreground">
            <AnalyticsTimeTooltipTarget
              className="block truncate"
              locale={locale}
              timestamp={event.receivedAt}
            >
              {formatRelativeTime(locale, event.receivedAt, now)}
            </AnalyticsTimeTooltipTarget>
          </TableCell>
        ),
        site: (
          <TableCell className="max-w-48">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-medium"
              locale={locale}
              request={{
                key: `request-observation-abnormal-site:${event.siteId}:${event.siteName}:${event.siteDomain}`,
                items: [
                  {
                    label: copy.site,
                    value: siteLabel,
                    copyValue: siteCopyValue,
                  },
                  {
                    label: copy.hostname,
                    value: hostnameLabel,
                    copyValue: hostnameCopyValue,
                  },
                ],
              }}
            >
              {event.siteName}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        kind: (
          <TableCell className="max-w-36">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-kind:${eventId}:${event.kind}`,
                items: [
                  {
                    label: copy.kind,
                    value: kindLabel,
                    copyValue: event.kind || undefined,
                  },
                ],
              }}
            >
              {kindLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        reason: (
          <TableCell className="max-w-48">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-medium"
              locale={locale}
              request={{
                key: `request-observation-abnormal-reason:${eventId}:${event.reasons.join(",")}:${reasonLabel}`,
                items: reasonItems,
              }}
            >
              {reasonLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        category: (
          <TableCell className="max-w-36 text-center">
            <AnalyticsDetailsTooltipTarget
              className="inline-flex"
              locale={locale}
              request={{
                key: `request-observation-abnormal-category:${eventId}:${event.category}`,
                items: [
                  {
                    label: copy.category,
                    value: categoryLabel,
                    copyValue: event.category || undefined,
                  },
                ],
              }}
            >
              <CategoryBlocks category={event.category} label={categoryLabel} />
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        botScore: (
          <TableCell className="max-w-24 text-right">
            <span className="block truncate font-mono tabular-nums">
              {botScoreLabel}
            </span>
          </TableCell>
        ),
        verifiedBotCategory: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-verified-bot:${eventId}:${event.verifiedBotCategory}`,
                items: [
                  {
                    label: copy.verifiedBotCategory,
                    value: verifiedBotCategoryLabel,
                    copyValue: verifiedBotCategoryCopyValue,
                  },
                ],
              }}
            >
              {event.verifiedBotCategory || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        network: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-network:${eventId}:${event.asOrganization}:${event.asn}`,
                items: [
                  {
                    label: copy.network,
                    value: networkLabel,
                    copyValue: networkCopyValue,
                  },
                  {
                    label: copy.asn,
                    value: asnLabel,
                    copyValue: asnCopyValue,
                  },
                ],
              }}
            >
              {event.asOrganization || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        ip: (
          <TableCell className="max-w-36">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono text-muted-foreground"
              locale={locale}
              request={{
                key: `request-observation-abnormal-ip:${eventId}:${event.ip}`,
                items: [
                  {
                    label: copy.ip,
                    value: event.ip || emptyValue(copy),
                    copyValue: event.ip || undefined,
                  },
                ],
              }}
            >
              {event.ip || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        location: (
          <TableCell className="max-w-52">
            <AnalyticsDetailsTooltipTarget
              className="block min-w-0"
              locale={locale}
              request={{
                key: `request-observation-abnormal-location:${eventId}:${event.country}:${event.region}:${event.city}`,
                items: [
                  {
                    label: copy.location,
                    value: (
                      <CountryRegionMeta
                        locale={locale}
                        messages={messages}
                        country={event.country || ""}
                        region={event.region}
                        city={event.city}
                        className="max-w-none text-background [&_.text-foreground]:text-background"
                      />
                    ),
                  },
                ],
              }}
            >
              <CountryRegionMeta
                locale={locale}
                messages={messages}
                country={event.country || ""}
                region={event.region}
                className="w-full"
              />
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        pathname: (
          <TableCell className="max-w-64">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-abnormal-pathname:${eventId}:${pathnameLabel}`,
                items: [
                  {
                    label: copy.pathname,
                    value: pathnameLabel,
                    copyValue: pathnameLabel,
                  },
                ],
              }}
            >
              {pathnameLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        userAgent: (
          <TableCell className="max-w-80 pr-4">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono text-muted-foreground"
              locale={locale}
              request={{
                key: `request-observation-abnormal-user-agent:${eventId}:${event.userAgent}`,
                items: [
                  {
                    label: copy.userAgent,
                    value: userAgentLabel,
                    copyValue: event.userAgent || undefined,
                  },
                ],
              }}
            >
              {event.userAgent || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
      };
      return {
        children: (
          <>
            {tableColumns.visibleIds.map((columnId) => (
              <Fragment key={columnId}>{cells[columnId]}</Fragment>
            ))}
          </>
        ),
        props: {
          role: "button",
          tabIndex: 0,
          className:
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          onClick: () => openEvent(event),
          onKeyDown: (keyboardEvent: KeyboardEvent<HTMLTableRowElement>) =>
            handleKeyDown(keyboardEvent, event),
        },
      };
    },
    [
      copy,
      handleKeyDown,
      locale,
      messages,
      now,
      openEvent,
      tableColumns.visibleIds,
    ],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <RequestObservationRowSkeletonContent
        index={index}
        columns={tableColumns.visibleIds}
        widths={BOT_EVENT_SKELETON_WIDTHS}
        alignments={BOT_EVENT_COLUMN_ALIGNMENTS}
      />
    ),
    [tableColumns.visibleIds],
  );
  const getRowKey = useCallback(
    (event: BotEvent, index: number) =>
      event.traceId ||
      event.rayId ||
      `${event.siteId}:${event.ip}:${event.pathname}:${event.receivedAt}:${index}`,
    [],
  );

  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {copy.recentTitle}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {copy.recentDescription}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AnalyticsTableColumnSettings
              columns={columnDefinitions}
              orderedIds={tableColumns.orderedIds}
              visibleIds={tableColumns.visibleIds}
              onOrderChange={tableColumns.setOrder}
              onVisibilityChange={tableColumns.setVisible}
              onReset={tableColumns.reset}
              labels={messages.common.tableColumns}
            />
            <div className="text-xs text-muted-foreground">
              {!loading && events.length > 0 && !hasMore
                ? copy.recentLoadedAll
                : ""}
            </div>
          </div>
        </div>

        <AnalyticsDataTable
          minTableWidth="92rem"
          tableClassName="min-w-[92rem]"
          header={tableHeader}
          rows={events}
          renderRow={renderRow}
          renderSkeletonRow={renderSkeletonRow}
          getRowKey={getRowKey}
          skeletonRows={BOT_EVENT_FETCH_LIMIT}
          columnCount={tableColumns.visibleIds.length}
          loading={loading}
          loadingMore={loadingMore}
          errorContent={copy.loadFailed}
          emptyContent={copy.noData}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          enableTimeTooltips
          messages={messages}
        />
      </section>

      <BotRequestDetailDrawer
        locale={locale}
        messages={messages}
        copy={copy}
        previewEvent={selectedEvent}
        detailEvent={detailEvent}
        loading={detailLoading}
        error={detailError}
        open={drawerOpen}
        onOpenChange={handleDrawerOpenChange}
      />
    </>
  );
});

function _valuesForNormalTargetTab(
  event: NormalRequestEvent,
  tab: TargetDimensionTab,
): string[] {
  if (tab === "site") {
    return [event.siteName || event.siteDomain || event.siteId];
  }
  if (tab === "hostname") return [event.hostname];
  if (tab === "pathname") return [event.pathname || "/"];
  return [event.origin];
}

function _valuesForNormalNetworkTab(
  event: NormalRequestEvent,
  tab: NetworkDimensionTab,
): string[] {
  if (tab === "asOrganization") return [event.asOrganization];
  if (tab === "asn") return [event.asn ? `AS${event.asn}` : ""];
  if (tab === "country") return [event.country];
  if (tab === "region") return [event.region];
  if (tab === "city") return [event.city];
  return [event.colo];
}

function _aggregateNormalDimensionRows(
  events: NormalRequestEvent[],
  copy: AppMessages["requestObservation"],
  resolveValues: (event: NormalRequestEvent) => string[],
): BotDimensionRow[] {
  const rowMap = new Map<
    string,
    { count: number; sampleEvent: NormalRequestEvent | null }
  >();

  for (const event of events) {
    const values = resolveValues(event)
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedValues = values.length > 0 ? values : [emptyValue(copy)];
    for (const value of normalizedValues) {
      const current = rowMap.get(value) ?? {
        count: 0,
        sampleEvent: event,
      };
      current.count += 1;
      current.sampleEvent ??= event;
      rowMap.set(value, current);
    }
  }

  return Array.from(rowMap.entries())
    .map(([label, row]) => ({
      label,
      count: row.count,
      highThreat: 0,
      sampleEvent: row.sampleEvent
        ? ({
            ...row.sampleEvent,
            category: "",
            reasons: [],
            ip: "",
            userAgent: "",
            verifiedBotCategory: "",
            botScore: null,
            metadataJson: "",
          } satisfies BotEvent)
        : null,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label),
    )
    .slice(0, DIMENSION_ROW_LIMIT);
}

const NormalRequestsTable = memo(function NormalRequestsTable({
  locale,
  messages,
  copy,
  events,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  events: NormalRequestEvent[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  requestKey?: string;
}) {
  const [selectedEvent, setSelectedEvent] = useState<NormalRequestEvent | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const title = copy.recentNormal.title;
  const description = copy.recentNormal.description;
  const openEvent = useCallback((event: NormalRequestEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);
  const handleKeyDown = useCallback(
    (
      keyboardEvent: KeyboardEvent<HTMLTableRowElement>,
      event: NormalRequestEvent,
    ) => {
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
      keyboardEvent.preventDefault();
      openEvent(event);
    },
    [openEvent],
  );
  const columnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<NormalRequestTableColumnId>[]
  >(
    () => [
      { id: "id", label: copy.id, required: true },
      { id: "time", label: copy.time, required: true },
      { id: "site", label: copy.site, required: true },
      { id: "kind", label: copy.kind },
      { id: "requestMethod", label: copy.normalDetail.requestMethod },
      { id: "hostname", label: copy.hostname },
      { id: "network", label: copy.network },
      { id: "location", label: copy.location },
      { id: "colo", label: copy.colo },
      { id: "pathname", label: copy.pathname },
      { id: "edgeLatency", label: copy.normalDetail.edgeLatency },
    ],
    [copy],
  );
  const tableColumns = useAnalyticsTableColumns({
    storageKey:
      "insightflare:analytics-table-columns:request-observation-normal",
    columns: columnDefinitions,
  });
  const headers = useMemo<Record<NormalRequestTableColumnId, ReactNode>>(
    () => ({
      id: <TableHead className="pl-4">{copy.id}</TableHead>,
      time: <TableHead className="text-center">{copy.time}</TableHead>,
      site: <TableHead>{copy.site}</TableHead>,
      kind: <TableHead>{copy.kind}</TableHead>,
      requestMethod: (
        <TableHead className="text-center">
          {copy.normalDetail.requestMethod}
        </TableHead>
      ),
      hostname: <TableHead>{copy.hostname}</TableHead>,
      network: <TableHead>{copy.network}</TableHead>,
      location: <TableHead>{copy.location}</TableHead>,
      colo: <TableHead>{copy.colo}</TableHead>,
      pathname: <TableHead>{copy.pathname}</TableHead>,
      edgeLatency: (
        <TableHead className="pr-4 text-right">
          {copy.normalDetail.edgeLatency}
        </TableHead>
      ),
    }),
    [copy],
  );
  const tableHeader = useMemo(
    () => (
      <TableRow>
        {tableColumns.visibleIds.map((columnId) => (
          <Fragment key={columnId}>{headers[columnId]}</Fragment>
        ))}
      </TableRow>
    ),
    [headers, tableColumns.visibleIds],
  );
  const renderRow = useCallback(
    (event: NormalRequestEvent) => {
      const eventId = event.traceId || event.rayId || "";
      const kindLabel = requestKindLabel(copy, event.kind);
      const requestMethodLabel = event.requestMethod || emptyValue(copy);
      const siteLabel =
        event.siteName || event.siteDomain || event.siteId || emptyValue(copy);
      const siteCopyValue =
        event.siteName || event.siteDomain || event.siteId || undefined;
      const networkLabel = event.asOrganization || emptyValue(copy);
      const networkCopyValue = event.asOrganization || undefined;
      const hostnameLabel = event.hostname || emptyValue(copy);
      const hostnameCopyValue = event.hostname || undefined;
      const asnLabel = event.asn ? `AS${event.asn}` : emptyValue(copy);
      const asnCopyValue = event.asn ? `AS${event.asn}` : undefined;
      const coloLabel = event.colo || emptyValue(copy);
      const coloCopyValue = event.colo || undefined;
      const pathnameLabel = event.pathname || "/";
      const edgeLatencyLabel = latencyFormat(locale, copy, event.edgeLatencyMs);
      const edgeLatencyCopyValue =
        event.edgeLatencyMs === null ||
        event.edgeLatencyMs === undefined ||
        !Number.isFinite(event.edgeLatencyMs)
          ? undefined
          : edgeLatencyLabel;
      const cells: Record<NormalRequestTableColumnId, ReactNode> = {
        id: (
          <TableCell className="pl-4 max-w-36">
            <div className="flex w-28 min-w-0 items-center gap-2">
              <VisitorAvatar seed={eventId || "normal"} className="size-6" />
              <AnalyticsDetailsTooltipTarget
                className="min-w-0 flex-1 truncate"
                locale={locale}
                request={{
                  key: `request-observation-normal-id:${eventId}:${event.receivedAt}`,
                  items: [
                    {
                      label: copy.id,
                      value: eventId || emptyValue(copy),
                      copyValue: eventId || undefined,
                    },
                  ],
                }}
              >
                <span className="truncate font-mono">
                  {eventId ? shortId(eventId) : "--"}
                </span>
              </AnalyticsDetailsTooltipTarget>
            </div>
          </TableCell>
        ),
        time: (
          <TableCell className="max-w-36 text-center font-mono text-muted-foreground">
            <AnalyticsTimeTooltipTarget
              className="block truncate"
              locale={locale}
              timestamp={event.receivedAt}
            >
              {formatRelativeTime(locale, event.receivedAt, now)}
            </AnalyticsTimeTooltipTarget>
          </TableCell>
        ),
        site: (
          <TableCell className="max-w-48">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-medium"
              locale={locale}
              request={{
                key: `request-observation-normal-site:${event.siteId}:${event.siteName}:${event.siteDomain}`,
                items: [
                  {
                    label: copy.site,
                    value: siteLabel,
                    copyValue: siteCopyValue,
                  },
                  {
                    label: copy.hostname,
                    value: hostnameLabel,
                    copyValue: hostnameCopyValue,
                  },
                ],
              }}
            >
              {event.siteName || event.siteDomain || event.siteId}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        kind: (
          <TableCell className="max-w-28">
            <AnalyticsDetailsTooltipTarget
              className="inline-flex"
              locale={locale}
              request={{
                key: `request-observation-normal-kind:${eventId}:${event.kind}`,
                items: [
                  {
                    label: copy.kind,
                    value: kindLabel,
                    copyValue: event.kind || undefined,
                  },
                ],
              }}
            >
              <span className="truncate">{kindLabel}</span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        requestMethod: (
          <TableCell className="max-w-24 text-center">
            <AnalyticsDetailsTooltipTarget
              className="block truncate text-center"
              locale={locale}
              request={{
                key: `request-observation-normal-method:${eventId}:${event.requestMethod}`,
                items: [
                  {
                    label: copy.normalDetail.requestMethod,
                    value: requestMethodLabel,
                    copyValue: event.requestMethod || undefined,
                  },
                ],
              }}
            >
              <span className="block truncate text-center font-mono">
                {event.requestMethod || "--"}
              </span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        hostname: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-normal-hostname:${eventId}:${event.hostname}`,
                items: [
                  {
                    label: copy.hostname,
                    value: hostnameLabel,
                    copyValue: event.hostname || undefined,
                  },
                ],
              }}
            >
              {event.hostname || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        network: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-network:${eventId}:${event.asOrganization}:${event.asn}`,
                items: [
                  {
                    label: copy.network,
                    value: networkLabel,
                    copyValue: networkCopyValue,
                  },
                  {
                    label: copy.asn,
                    value: asnLabel,
                    copyValue: asnCopyValue,
                  },
                ],
              }}
            >
              {event.asOrganization || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        location: (
          <TableCell className="max-w-52">
            <AnalyticsDetailsTooltipTarget
              className="block min-w-0"
              locale={locale}
              request={{
                key: `request-observation-normal-location:${eventId}:${event.country}:${event.region}:${event.city}`,
                items: [
                  {
                    label: copy.location,
                    value: (
                      <CountryRegionMeta
                        locale={locale}
                        messages={messages}
                        country={event.country || ""}
                        region={event.region}
                        city={event.city}
                        className="max-w-none text-background [&_.text-foreground]:text-background"
                      />
                    ),
                  },
                ],
              }}
            >
              <CountryRegionMeta
                locale={locale}
                messages={messages}
                country={event.country || ""}
                region={event.region}
                className="w-full"
              />
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        colo: (
          <TableCell className="max-w-32">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-colo:${eventId}:${event.colo}`,
                items: [
                  {
                    label: copy.colo,
                    value: coloLabel,
                    copyValue: coloCopyValue,
                  },
                ],
              }}
            >
              {event.colo || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        pathname: (
          <TableCell className="max-w-64">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-normal-pathname:${eventId}:${pathnameLabel}`,
                items: [
                  {
                    label: copy.pathname,
                    value: pathnameLabel,
                    copyValue: pathnameLabel,
                  },
                ],
              }}
            >
              {pathnameLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        edgeLatency: (
          <TableCell className="max-w-28 pr-4 text-right">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-edge-latency:${eventId}:${event.edgeLatencyMs}`,
                items: [
                  {
                    label: copy.normalDetail.edgeLatency,
                    value: edgeLatencyLabel,
                    copyValue: edgeLatencyCopyValue,
                  },
                ],
              }}
            >
              <span className="block truncate font-mono tabular-nums text-muted-foreground">
                {edgeLatencyLabel}
              </span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
      };
      return {
        children: (
          <>
            {tableColumns.visibleIds.map((columnId) => (
              <Fragment key={columnId}>{cells[columnId]}</Fragment>
            ))}
          </>
        ),
        props: {
          role: "button",
          tabIndex: 0,
          className:
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          onClick: () => openEvent(event),
          onKeyDown: (keyboardEvent: KeyboardEvent<HTMLTableRowElement>) =>
            handleKeyDown(keyboardEvent, event),
        },
      };
    },
    [
      copy,
      handleKeyDown,
      locale,
      messages,
      now,
      openEvent,
      tableColumns.visibleIds,
    ],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <RequestObservationRowSkeletonContent
        index={index}
        columns={tableColumns.visibleIds}
        widths={NORMAL_REQUEST_SKELETON_WIDTHS}
        alignments={NORMAL_REQUEST_COLUMN_ALIGNMENTS}
      />
    ),
    [tableColumns.visibleIds],
  );
  const getRowKey = useCallback(
    (event: NormalRequestEvent, index: number) =>
      event.traceId ||
      event.rayId ||
      `${event.siteId}:${event.pathname}:${event.receivedAt}:${index}`,
    [],
  );

  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AnalyticsTableColumnSettings
              columns={columnDefinitions}
              orderedIds={tableColumns.orderedIds}
              visibleIds={tableColumns.visibleIds}
              onOrderChange={tableColumns.setOrder}
              onVisibilityChange={tableColumns.setVisible}
              onReset={tableColumns.reset}
              labels={messages.common.tableColumns}
            />
            <div className="text-xs text-muted-foreground">
              {!loading && events.length > 0 && !hasMore
                ? copy.recentLoadedAll
                : ""}
            </div>
          </div>
        </div>

        <AnalyticsDataTable
          tableClassName="min-w-[80rem]"
          header={tableHeader}
          rows={events}
          renderRow={renderRow}
          renderSkeletonRow={renderSkeletonRow}
          getRowKey={getRowKey}
          skeletonRows={BOT_EVENT_FETCH_LIMIT}
          columnCount={tableColumns.visibleIds.length}
          loading={loading}
          loadingMore={loadingMore}
          errorContent={copy.loadFailed}
          emptyContent={copy.noData}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          enableTimeTooltips
          messages={messages}
        />
      </section>

      <NormalRequestDetailDrawer
        locale={locale}
        messages={messages}
        copy={copy}
        event={selectedEvent}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </>
  );
});
