import {
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
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLabelAppearance,
  type AsyncDimensionBreakdownRow,
  type AsyncDimensionBreakdownTab,
} from "@/components/dashboard/async-dimension-breakdown-card";
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
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
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

interface RequestObservationClientProps {
  locale: Locale;
  messages: AppMessages;
}

interface BotEvent {
  timestamp: string;
  receivedAt: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  confidence: string;
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
  latitude: number | null;
  longitude: number | null;
  userAgentLength: number;
}

interface RequestMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  pointCount: number;
  source?: "normal" | "abnormal";
  color?: [number, number, number];
}

interface RequestTrendPoint {
  timestampMs: number;
  count: number;
  baselineCount: number;
  normalCount: number;
  abnormalCount: number;
  totalCount: number;
  botRatio: number;
  abnormalRatio: number;
  normalRatio: number;
  pageviews: number;
  customEvents: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p75LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

interface RequestNetworkDimensionRow {
  key: string;
  label: string;
  count: number;
  highConfidence: number;
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
    highConfidence: number;
    mediumConfidence: number;
    affectedSites: number;
    uniqueAsns: number;
    uniqueCountries: number;
  };
  mapPoints: RequestMapPoint[];
  trend: RequestTrendPoint[];
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
      highConfidence: number;
      mediumConfidence: number;
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
const BOT_EVENT_SKELETON_WIDTHS = [
  "w-24",
  "w-28",
  "w-24",
  "w-28",
  "w-32",
  "w-40",
  "w-24",
  "w-28",
  "w-24",
  "w-24",
  "w-20",
] as const;
const NORMAL_REQUEST_SKELETON_WIDTHS = [
  "w-24",
  "w-28",
  "w-24",
  "w-16",
  "w-24",
  "w-40",
  "w-24",
  "w-28",
  "w-24",
  "w-20",
] as const;
const ABNORMAL_POINT_COLOR: [number, number, number] = [239, 68, 68];
const NORMAL_POINT_COLOR: [number, number, number] = [34, 197, 154];
const PERFORMANCE_WARNING_COLOR = "oklch(0.75 0.16 80)";
const NORMAL_TRAFFIC_SHARE_COLOR = "var(--color-chart-4)";
const LOW_CONFIDENCE_TRAFFIC_COLOR = "var(--color-chart-5)";
const MEDIUM_CONFIDENCE_TRAFFIC_COLOR = PERFORMANCE_WARNING_COLOR;
const HIGH_CONFIDENCE_TRAFFIC_COLOR = "var(--color-destructive)";

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
  | "confidence"
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
  highConfidence: number;
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
        highConfidence: data.summary.highConfidence,
        mediumConfidence: data.summary.mediumConfidence,
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

  const formatter = useMemo(
    () => new Intl.NumberFormat(intlLocale(locale)),
    [locale],
  );
  const trendTickFormatter = useMemo(
    () => trendTickDateFormat(locale, spanMs),
    [locale, spanMs],
  );
  const trendTooltipFormatter = useMemo(
    () => trendTooltipDateFormat(locale, spanMs),
    [locale, spanMs],
  );

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
  const confidenceCounts = useMemo(() => {
    let low = 0;
    let medium = 0;
    let high = 0;
    for (const event of abnormalEvents) {
      if (event.confidence === "high") high += 1;
      else if (event.confidence === "medium") medium += 1;
      else low += 1;
    }
    return { low, medium, high };
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

  const trendConfig = useMemo(
    () =>
      ({
        normalCount: {
          label: labels.normalRequests,
          color: NORMAL_TRAFFIC_SHARE_COLOR,
        },
        abnormalCount: {
          label: labels.abnormalRequests,
          color: "var(--color-destructive)",
        },
        totalCount: {
          label: labels.totalRequests,
          color: "var(--color-chart-1)",
        },
        pageviews: {
          label: labels.pageviews,
          color: NORMAL_TRAFFIC_SHARE_COLOR,
        },
        customEvents: {
          label: labels.customEvents,
          color: PERFORMANCE_WARNING_COLOR,
        },
        abnormalRatio: {
          label: labels.abnormalRatio,
          color: "var(--color-destructive)",
        },
        avgLatencyMs: {
          label: labels.avgLatency,
          color: "var(--color-chart-1)",
        },
        p50LatencyMs: {
          label: labels.p50Latency,
          color: "var(--color-chart-1)",
        },
        p75LatencyMs: {
          label: labels.p75Latency,
          color: "var(--color-chart-4)",
        },
        p95LatencyMs: {
          label: labels.p95Latency,
          color: "var(--color-chart-5)",
        },
        p99LatencyMs: {
          label: labels.p99Latency,
          color: "var(--color-destructive)",
        },
        normalTrafficShare: {
          label: labels.normalTrafficShare,
          color: NORMAL_TRAFFIC_SHARE_COLOR,
        },
        lowConfidenceTraffic: {
          label: labels.lowConfidenceTraffic,
          color: LOW_CONFIDENCE_TRAFFIC_COLOR,
        },
        mediumConfidenceTraffic: {
          label: labels.mediumConfidenceTraffic,
          color: MEDIUM_CONFIDENCE_TRAFFIC_COLOR,
        },
        highConfidenceTraffic: {
          label: labels.highConfidenceTraffic,
          color: HIGH_CONFIDENCE_TRAFFIC_COLOR,
        },
      }) satisfies ChartConfig,
    [labels],
  );
  const formatTrendTooltipValue = useMemo(
    () =>
      createTrendTooltipFormatter({
        botRequestsLabel: labels.requests,
        botTrafficRatioLabel: labels.abnormalRatio,
        countFormatter: formatter,
        locale,
        labels: {
          normalCount: labels.normalRequests,
          abnormalCount: labels.abnormalRequests,
          totalCount: labels.totalRequests,
          pageviews: labels.pageviews,
          customEvents: labels.customEvents,
          abnormalRatio: labels.abnormalRatio,
          avgLatencyMs: labels.avgLatency,
          p50LatencyMs: labels.p50Latency,
          p75LatencyMs: labels.p75Latency,
          p95LatencyMs: labels.p95Latency,
          p99LatencyMs: labels.p99Latency,
          normalTrafficShare: labels.normalTrafficShare,
          lowConfidenceTraffic: labels.lowConfidenceTraffic,
          mediumConfidenceTraffic: labels.mediumConfidenceTraffic,
          highConfidenceTraffic: labels.highConfidenceTraffic,
        },
      }),
    [formatter, labels, locale],
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
          value: "confidence",
          label: copy.confidence,
          columnLabel: copy.confidence,
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

  const requestKey = `${timeWindow.interval}:${data?.generatedAt ?? 0}`;
  const overview = data?.overview;
  const abnormalSummary = data?.abnormal?.summary;
  const normalSummary = data?.normal?.summary;
  const confidenceShareItems = useMemo(
    () => [
      {
        key: "normal",
        label: labels.normalTrafficShare,
        value: overview?.normalRequests ?? 0,
        color: NORMAL_TRAFFIC_SHARE_COLOR,
      },
      {
        key: "low",
        label: labels.lowConfidenceTraffic,
        value: confidenceCounts.low,
        color: LOW_CONFIDENCE_TRAFFIC_COLOR,
      },
      {
        key: "medium",
        label: labels.mediumConfidenceTraffic,
        value: abnormalSummary?.mediumConfidence ?? confidenceCounts.medium,
        color: MEDIUM_CONFIDENCE_TRAFFIC_COLOR,
      },
      {
        key: "high",
        label: labels.highConfidenceTraffic,
        value: abnormalSummary?.highConfidence ?? confidenceCounts.high,
        color: HIGH_CONFIDENCE_TRAFFIC_COLOR,
      },
    ],
    [
      abnormalSummary?.highConfidence,
      abnormalSummary?.mediumConfidence,
      confidenceCounts.high,
      confidenceCounts.low,
      confidenceCounts.medium,
      labels.highConfidenceTraffic,
      labels.lowConfidenceTraffic,
      labels.mediumConfidenceTraffic,
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
            <ChartContainer config={trendConfig} className="h-[320px] w-full">
              <ComposedChart data={trend}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="timestampMs"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value) =>
                    trendTickFormatter.format(new Date(Number(value ?? 0)))
                  }
                  minTickGap={14}
                />
                <YAxis
                  yAxisId="requests"
                  width={52}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatter.format(Number(value))}
                />
                <YAxis
                  yAxisId="ratio"
                  orientation="right"
                  width={44}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    percentFormat(locale, Number(value))
                  }
                />
                <ChartTooltip
                  allowEscapeViewBox={{ x: false, y: true }}
                  wrapperStyle={{ zIndex: 20 }}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      labelFormatter={(value, payload) => {
                        const timestamp = Number(
                          payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                        );
                        return trendTooltipFormatter.format(
                          new Date(timestamp),
                        );
                      }}
                      formatter={formatTrendTooltipValue}
                    />
                  }
                />
                <Bar
                  yAxisId="requests"
                  dataKey="normalCount"
                  stackId="requests"
                  fill="var(--color-normalCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  yAxisId="requests"
                  dataKey="abnormalCount"
                  stackId="requests"
                  fill="var(--color-abnormalCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Line
                  yAxisId="ratio"
                  type="linear"
                  dataKey="abnormalRatio"
                  stroke="var(--color-abnormalRatio)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </ComposedChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <section className="grid gap-4 xl:grid-cols-2">
          <ShareRadialCard
            className="xl:col-span-2"
            title={labels.confidenceShareTitle}
            items={confidenceShareItems}
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
              <ChartContainer config={trendConfig} className="h-[280px] w-full">
                <ComposedChart data={trend}>
                  <defs>
                    <linearGradient
                      id="request-observability-total-fill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="var(--color-totalCount)"
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--color-totalCount)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="timestampMs"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(value) =>
                      trendTickFormatter.format(new Date(Number(value ?? 0)))
                    }
                    minTickGap={14}
                  />
                  <YAxis
                    width={52}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatter.format(Number(value))}
                  />
                  <ChartTooltip
                    allowEscapeViewBox={{ x: false, y: true }}
                    wrapperStyle={{ zIndex: 20 }}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(value, payload) => {
                          const timestamp = Number(
                            payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                          );
                          return trendTooltipFormatter.format(
                            new Date(timestamp),
                          );
                        }}
                        formatter={formatTrendTooltipValue}
                      />
                    }
                  />
                  <Area
                    type="linear"
                    dataKey="totalCount"
                    stroke="var(--color-totalCount)"
                    fill="url(#request-observability-total-fill)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="linear"
                    dataKey="pageviews"
                    stroke="var(--color-pageviews)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="linear"
                    dataKey="customEvents"
                    stroke="var(--color-customEvents)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                </ComposedChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{labels.latencyTitle}</CardTitle>
              <CardDescription>{labels.latencyDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={trendConfig} className="h-[280px] w-full">
                <ComposedChart data={trend}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="timestampMs"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(value) =>
                      trendTickFormatter.format(new Date(Number(value ?? 0)))
                    }
                    minTickGap={14}
                  />
                  <YAxis
                    width={60}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) =>
                      latencyFormat(locale, copy, Number(value))
                    }
                  />
                  <ChartTooltip
                    allowEscapeViewBox={{ x: false, y: true }}
                    wrapperStyle={{ zIndex: 20 }}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(value, payload) => {
                          const timestamp = Number(
                            payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                          );
                          return trendTooltipFormatter.format(
                            new Date(timestamp),
                          );
                        }}
                        formatter={formatTrendTooltipValue}
                      />
                    }
                  />
                  <Line
                    type="linear"
                    dataKey="p50LatencyMs"
                    stroke="var(--color-p50LatencyMs)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="p75LatencyMs"
                    stroke="var(--color-p75LatencyMs)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="p95LatencyMs"
                    stroke="var(--color-p95LatencyMs)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="p99LatencyMs"
                    stroke="var(--color-p99LatencyMs)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ChartContainer>
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
                              label={copy.highConfidenceBots}
                              value={numberFormat(
                                locale,
                                abnormalSummary?.highConfidence ?? 0,
                              )}
                              detail={copy.confidence}
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
                          <ChartContainer
                            config={trendConfig}
                            className="h-[320px] w-full"
                          >
                            <ComposedChart data={trend}>
                              <CartesianGrid vertical={false} />
                              <XAxis
                                dataKey="timestampMs"
                                tickLine={false}
                                axisLine={false}
                                tickMargin={8}
                                tickFormatter={(value) =>
                                  trendTickFormatter.format(
                                    new Date(Number(value ?? 0)),
                                  )
                                }
                                minTickGap={14}
                              />
                              <YAxis
                                yAxisId="requests"
                                width={52}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) =>
                                  formatter.format(Number(value))
                                }
                              />
                              <YAxis
                                yAxisId="ratio"
                                orientation="right"
                                width={44}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) =>
                                  percentFormat(locale, Number(value))
                                }
                              />
                              <ChartTooltip
                                allowEscapeViewBox={{ x: false, y: true }}
                                wrapperStyle={{ zIndex: 20 }}
                                content={
                                  <ChartTooltipContent
                                    indicator="dot"
                                    labelFormatter={(value, payload) => {
                                      const timestamp = Number(
                                        payload?.[0]?.payload?.timestampMs ??
                                          value ??
                                          0,
                                      );
                                      return trendTooltipFormatter.format(
                                        new Date(timestamp),
                                      );
                                    }}
                                    formatter={formatTrendTooltipValue}
                                  />
                                }
                              />
                              <Bar
                                yAxisId="requests"
                                dataKey="abnormalCount"
                                fill="var(--color-abnormalCount)"
                                radius={[3, 3, 0, 0]}
                              />
                              <Line
                                yAxisId="ratio"
                                type="linear"
                                dataKey="abnormalRatio"
                                stroke="var(--color-abnormalRatio)"
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
                              />
                            </ComposedChart>
                          </ChartContainer>
                        </CardContent>
                      </Card>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={detectionTabs}
                          loadRows={(tab) =>
                            loadAbnormalDimensionRows("detection", tab)
                          }
                          requestKey={`${requestKey}:detection`}
                          className="h-full"
                          secondaryMetricLabel={copy.highConfidenceRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={targetTabs}
                          loadRows={(tab) =>
                            loadAbnormalDimensionRows("target", tab)
                          }
                          requestKey={`${requestKey}:target`}
                          className="h-full"
                          secondaryMetricLabel={copy.highConfidenceRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loadRows={(tab) =>
                            loadAbnormalDimensionRows("network", tab)
                          }
                          requestKey={`${requestKey}:network`}
                          className="h-full"
                          secondaryMetricLabel={copy.highConfidenceRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={clientTabs}
                          loadRows={(tab) =>
                            loadAbnormalDimensionRows("client", tab)
                          }
                          requestKey={`${requestKey}:client`}
                          className="h-full"
                          secondaryMetricLabel={copy.highConfidenceRequests}
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
                          loadRows={(tab) =>
                            loadNormalDimensionRows("target", tab)
                          }
                          requestKey={`${requestKey}:normal-target`}
                          className="h-full"
                          showVisitors={false}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loadRows={(tab) =>
                            loadNormalDimensionRows("network", tab)
                          }
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

function trendTickDateFormat(
  locale: Locale,
  spanMs: number,
): Intl.DateTimeFormat {
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: "numeric",
    day: "numeric",
  });
}

function trendTooltipDateFormat(
  locale: Locale,
  spanMs: number,
): Intl.DateTimeFormat {
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
  if (tab === "confidence") return [event.confidence];
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
    { count: number; highConfidence: number; sampleEvent: BotEvent | null }
  >();

  for (const event of events) {
    const values = resolveValues(event)
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedValues = values.length > 0 ? values : [emptyValue(copy)];
    for (const value of normalizedValues) {
      const current = rowMap.get(value) ?? {
        count: 0,
        highConfidence: 0,
        sampleEvent: event,
      };
      current.count += 1;
      if (event.confidence === "high") current.highConfidence += 1;
      current.sampleEvent ??= event;
      rowMap.set(value, current);
    }
  }

  return Array.from(rowMap.entries())
    .map(([label, row]) => ({
      label,
      count: row.count,
      highConfidence: row.highConfidence,
      sampleEvent: row.sampleEvent,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.highConfidence - left.highConfidence ||
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

function TrendTooltipValue({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-36 items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        <span className="text-muted-foreground">{label}</span>
      </span>
      <span className="font-mono text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function createTrendTooltipFormatter(input: {
  botRequestsLabel: string;
  botTrafficRatioLabel: string;
  countFormatter: Intl.NumberFormat;
  locale: Locale;
  labels?: Record<string, string>;
}) {
  return function formatTrendTooltipValue(
    value: unknown,
    name: unknown,
    _item: unknown,
    _index: number,
    payload: unknown,
  ) {
    const key = String(name || "");
    const row = (payload ?? null) as Record<string, unknown> | null;
    const isRatio = key === "botRatio" || key.endsWith("Ratio");
    const isLatency = key.toLowerCase().includes("latency");
    const numeric = Number(value);
    const displayValue = Number(row?.[key] ?? numeric ?? 0);
    const formatted = isLatency
      ? durationFormat(
          input.locale,
          Number.isFinite(displayValue) ? displayValue : 0,
        )
      : isRatio
        ? percentFormat(
            input.locale,
            Number.isFinite(displayValue) ? displayValue : 0,
          )
        : input.countFormatter.format(
            Math.max(
              0,
              Math.round(Number.isFinite(displayValue) ? displayValue : 0),
            ),
          );
    const label =
      input.labels?.[key] ??
      (isRatio ? input.botTrafficRatioLabel : input.botRequestsLabel);
    const indicatorColor =
      key === "normalCount"
        ? "var(--color-normalCount)"
        : key === "totalCount"
          ? "var(--color-totalCount)"
          : key === "pageviews"
            ? "var(--color-pageviews)"
            : key === "customEvents"
              ? "var(--color-customEvents)"
              : key === "p50LatencyMs"
                ? "var(--color-p50LatencyMs)"
                : key === "p75LatencyMs"
                  ? "var(--color-p75LatencyMs)"
                  : key === "p95LatencyMs"
                    ? "var(--color-p95LatencyMs)"
                    : key === "p99LatencyMs"
                      ? "var(--color-p99LatencyMs)"
                      : isRatio
                        ? "var(--color-abnormalRatio, var(--color-botRatio))"
                        : "var(--color-abnormalCount, var(--color-count))";

    return (
      <TrendTooltipValue
        color={indicatorColor}
        label={label}
        value={formatted}
      />
    );
  };
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
    visitors: row.highConfidence,
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
    highConfidence: row.highConfidence,
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
          : options?.networkTab === "asn" && row.label
            ? `AS${row.label}`
            : row.label || options?.unknownLabel || "--",
      count: row.count,
      highConfidence: row.highConfidence,
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

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

function ConfidenceBlocks({
  confidence,
  label,
}: {
  confidence: string;
  label?: string;
}) {
  const normalized = confidence.trim().toLowerCase();
  const activeCount =
    normalized === "low"
      ? 1
      : normalized === "medium"
        ? 2
        : normalized === "high"
          ? 3
          : 0;
  const activeColor =
    normalized === "low"
      ? "bg-emerald-500"
      : normalized === "medium"
        ? "bg-amber-500"
        : normalized === "high"
          ? "bg-red-500"
          : "";

  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={label || confidence || undefined}
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
  widths,
}: {
  index: number;
  widths: readonly string[];
}) {
  return (
    <>
      {widths.map((width, cellIndex) => (
        <TableCell
          key={`${index}:${cellIndex}`}
          className={cellIndex === 0 ? "pl-4" : undefined}
        >
          <Skeleton className={cn("h-4", width)} />
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
  const event = detailEvent ?? previewEvent;
  const metadata = event ? metadataEntries(event.metadataJson) : [];
  const eventId = event ? event.traceId || event.rayId : "";
  const contentKey = loading
    ? "loading"
    : error
      ? "error"
      : event
        ? "detail"
        : "empty";

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
            <DrawerDescription>
              {previewEvent?.pathname ||
                detailEvent?.pathname ||
                copy.detailSubtitle}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            <AutoResizer initial duration={0.2} ease={[0.22, 1, 0.36, 1]}>
              <AutoTransition
                transitionKey={contentKey}
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
              >
                {loading ? (
                  <div className="flex h-64 items-center justify-center text-muted-foreground">
                    <Spinner className="size-5" />
                  </div>
                ) : error ? (
                  <div className="flex h-64 items-center justify-center text-center text-sm text-muted-foreground">
                    {error}
                  </div>
                ) : !event ? (
                  <div className="flex h-64 items-center justify-center text-muted-foreground">
                    {copy.noData}
                  </div>
                ) : (
                  <div className="space-y-5">
                    <section className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          <ConfidenceBlocks
                            confidence={event.confidence}
                            label={displayValue(event.confidence, empty)}
                          />
                        </Badge>
                        {event.reasons.map((reason) => (
                          <Badge key={reason} variant="outline">
                            {botReasonLabel(copy, reason)}
                          </Badge>
                        ))}
                        <span className="font-mono text-xs text-muted-foreground">
                          {displayValue(eventId, empty)}
                        </span>
                      </div>
                      <dl className="grid gap-3 sm:grid-cols-2">
                        <DetailItem
                          label={copy.time}
                          value={shortDateTimeWithSeconds(
                            locale,
                            event.receivedAt,
                          )}
                        />
                        <DetailItem
                          label={copy.kind}
                          value={displayValue(event.kind, empty)}
                        />
                        <DetailItem
                          label={copy.botScoreBucket}
                          value={botScoreBucket(event.botScore)}
                        />
                        <DetailItem
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
                          label={copy.origin}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.origin, empty)}
                            </span>
                          }
                        />
                        <DetailItem
                          label={copy.hostname}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.hostname, empty)}
                            </span>
                          }
                        />
                        <DetailItem
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
                          label={copy.location}
                          value={
                            <CountryRegionMeta
                              locale={locale}
                              messages={messages}
                              country={event.country || ""}
                              region={event.region}
                            />
                          }
                        />
                        <DetailItem
                          label={copy.colo}
                          value={displayValue(event.colo, empty)}
                        />
                        <DetailItem
                          label={copy.network}
                          value={displayValue(formatAsn(event), empty)}
                        />
                        <DetailItem
                          label={copy.ip}
                          value={
                            <span className="font-mono">
                              {displayValue(event.ip, empty)}
                            </span>
                          }
                        />
                      </dl>
                    </section>

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
                      <h3 className="text-sm font-medium">
                        {copy.identifiers}
                      </h3>
                      <dl className="grid gap-3 sm:grid-cols-2">
                        <DetailItem
                          label={copy.id}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(eventId, empty)}
                            </span>
                          }
                        />
                        <DetailItem
                          label="Trace ID"
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.traceId, empty)}
                            </span>
                          }
                        />
                        <DetailItem
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
                          <h3 className="text-sm font-medium">
                            {copy.metadata}
                          </h3>
                          <dl className="grid gap-3">
                            {metadata.map(([key, value]) => (
                              <DetailItem
                                key={key}
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
              </AutoTransition>
            </AutoResizer>
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
  const subtitle = event?.pathname || copy.normalDetail.subtitle;
  const requestMethodLabel = copy.normalDetail.requestMethod;
  const edgeLatencyLabel = copy.normalDetail.edgeLatency;
  const eventAtLabel = copy.normalDetail.eventAt;
  const receivedAtLabel = copy.normalDetail.receivedAt;
  const coordinatesLabel = copy.normalDetail.coordinates;
  const continentLabel = copy.normalDetail.continent;
  const contentKey = event ? "detail" : "empty";

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
            <DrawerDescription>{subtitle}</DrawerDescription>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            <AutoResizer initial duration={0.2} ease={[0.22, 1, 0.36, 1]}>
              <AutoTransition
                transitionKey={contentKey}
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
              >
                {!event ? (
                  <div className="flex h-64 items-center justify-center text-muted-foreground">
                    {copy.noData}
                  </div>
                ) : (
                  <div className="space-y-5">
                    <section className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {requestKindLabel(copy, event.kind)}
                        </Badge>
                        <Badge variant="outline">
                          {event.requestMethod || empty}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">
                          {displayValue(eventId, empty)}
                        </span>
                      </div>
                      <dl className="grid gap-3 sm:grid-cols-2">
                        <DetailItem
                          label={receivedAtLabel}
                          value={shortDateTimeWithSeconds(
                            locale,
                            event.receivedAt,
                          )}
                        />
                        <DetailItem
                          label={eventAtLabel}
                          value={shortDateTimeWithSeconds(
                            locale,
                            event.eventAt,
                          )}
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
                          label={copy.origin}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.origin, empty)}
                            </span>
                          }
                        />
                        <DetailItem
                          label={copy.hostname}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.hostname, empty)}
                            </span>
                          }
                        />
                        <DetailItem
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
                          value={latencyFormat(
                            locale,
                            copy,
                            event.edgeLatencyMs,
                          )}
                        />
                        <DetailItem
                          label={copy.location}
                          value={
                            <CountryRegionMeta
                              locale={locale}
                              messages={messages}
                              country={event.country || ""}
                              region={event.region}
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
                          label={coordinatesLabel}
                          value={
                            event.latitude !== null && event.longitude !== null
                              ? `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}`
                              : empty
                          }
                        />
                        <DetailItem
                          label={continentLabel}
                          value={displayValue(event.continent, empty)}
                        />
                      </dl>
                    </section>

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
                          label={copy.userAgent}
                          value={numberFormat(locale, event.userAgentLength)}
                        />
                      </dl>
                    </section>

                    <Separator />

                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">
                        {copy.identifiers}
                      </h3>
                      <dl className="grid gap-3 sm:grid-cols-2">
                        <DetailItem
                          label={copy.id}
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(eventId, empty)}
                            </span>
                          }
                        />
                        <DetailItem
                          label="Trace ID"
                          value={
                            <span className="break-all font-mono text-xs">
                              {displayValue(event.traceId, empty)}
                            </span>
                          }
                        />
                        <DetailItem
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
                  </div>
                )}
              </AutoTransition>
            </AutoResizer>
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

  const tableHeader = useMemo(
    () => (
      <TableRow>
        <TableHead className="pl-4">{copy.id}</TableHead>
        <TableHead>{copy.time}</TableHead>
        <TableHead>{copy.site}</TableHead>
        <TableHead>{copy.reason}</TableHead>
        <TableHead>{copy.confidence}</TableHead>
        <TableHead>{copy.network}</TableHead>
        <TableHead>{copy.asn}</TableHead>
        <TableHead>{copy.ip}</TableHead>
        <TableHead>{copy.location}</TableHead>
        <TableHead>{copy.pathname}</TableHead>
        <TableHead className="pr-4">{copy.userAgent}</TableHead>
      </TableRow>
    ),
    [copy],
  );
  const renderRow = useCallback(
    (event: BotEvent) => {
      const reasonLabel = botReasonLabel(
        copy,
        event.reasons[0] || event.confidence || "",
      );
      const eventId = event.traceId || event.rayId || "";
      return {
        children: (
          <>
            <TableCell className="pl-4 max-w-36">
              <div className="flex w-28 min-w-0 items-center gap-2">
                <VisitorAvatar seed={eventId || "unknown"} className="size-6" />
                <span
                  className="min-w-0 truncate font-mono"
                  title={eventId || undefined}
                >
                  {eventId ? shortId(eventId) : "--"}
                </span>
              </div>
            </TableCell>
            <TableCell className="max-w-36 font-mono text-muted-foreground">
              <span className="block truncate">
                {formatRelativeTime(locale, event.receivedAt, now)}
              </span>
            </TableCell>
            <TableCell className="max-w-48">
              <span
                className="block truncate font-medium"
                title={event.siteName}
              >
                {event.siteName}
              </span>
            </TableCell>
            <TableCell className="max-w-48">
              <span className="block truncate font-medium" title={reasonLabel}>
                {reasonLabel}
              </span>
            </TableCell>
            <TableCell className="max-w-36">
              <ConfidenceBlocks
                confidence={event.confidence}
                label={event.confidence || "--"}
              />
            </TableCell>
            <TableCell className="max-w-44">
              <span
                className="block truncate"
                title={event.asOrganization || undefined}
              >
                {event.asOrganization || "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-24">
              <span className="block truncate font-mono">
                {event.asn ? `AS${event.asn}` : "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-36">
              <span className="block truncate font-mono text-muted-foreground">
                {event.ip || "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-52">
              <CountryRegionMeta
                locale={locale}
                messages={messages}
                country={event.country || ""}
                region={event.region}
                className="w-full"
              />
            </TableCell>
            <TableCell className="max-w-64">
              <span
                className="block truncate font-mono"
                title={event.pathname || "/"}
              >
                {event.pathname || "/"}
              </span>
            </TableCell>
            <TableCell className="max-w-80 pr-4">
              <span
                className="block truncate font-mono text-muted-foreground"
                title={event.userAgent || undefined}
              >
                {event.userAgent || "--"}
              </span>
            </TableCell>
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
    [copy, handleKeyDown, locale, messages, now, openEvent],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <RequestObservationRowSkeletonContent
        index={index}
        widths={BOT_EVENT_SKELETON_WIDTHS}
      />
    ),
    [],
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
          <div className="shrink-0 text-xs text-muted-foreground">
            {!loading && events.length > 0
              ? hasMore
                ? `${copy.recentShowing} ${numberFormat(locale, events.length)}`
                : copy.recentLoadedAll
              : ""}
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
          columnCount={11}
          loading={loading}
          loadingMore={loadingMore}
          errorContent={copy.loadFailed}
          emptyContent={copy.noData}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
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
      highConfidence: 0,
      sampleEvent: row.sampleEvent
        ? ({
            ...row.sampleEvent,
            confidence: "",
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
  const tableHeader = useMemo(
    () => (
      <TableRow>
        <TableHead className="pl-4">{copy.id}</TableHead>
        <TableHead>{copy.time}</TableHead>
        <TableHead>{copy.site}</TableHead>
        <TableHead>{copy.kind}</TableHead>
        <TableHead>{copy.normalDetail.requestMethod}</TableHead>
        <TableHead>{copy.network}</TableHead>
        <TableHead>{copy.asn}</TableHead>
        <TableHead>{copy.location}</TableHead>
        <TableHead>{copy.pathname}</TableHead>
        <TableHead className="pr-4">{copy.normalDetail.edgeLatency}</TableHead>
      </TableRow>
    ),
    [copy],
  );
  const renderRow = useCallback(
    (event: NormalRequestEvent) => {
      const eventId = event.traceId || event.rayId || "";
      return {
        children: (
          <>
            <TableCell className="pl-4 max-w-36">
              <div className="flex w-28 min-w-0 items-center gap-2">
                <VisitorAvatar seed={eventId || "normal"} className="size-6" />
                <span
                  className="min-w-0 truncate font-mono"
                  title={eventId || undefined}
                >
                  {eventId ? shortId(eventId) : "--"}
                </span>
              </div>
            </TableCell>
            <TableCell className="max-w-36 font-mono text-muted-foreground">
              <span className="block truncate">
                {formatRelativeTime(locale, event.receivedAt, now)}
              </span>
            </TableCell>
            <TableCell className="max-w-48">
              <span
                className="block truncate font-medium"
                title={event.siteName}
              >
                {event.siteName || event.siteDomain || event.siteId}
              </span>
            </TableCell>
            <TableCell className="max-w-28">
              <Badge variant="outline">
                {requestKindLabel(copy, event.kind)}
              </Badge>
            </TableCell>
            <TableCell className="max-w-24">
              <span className="block truncate font-mono">
                {event.requestMethod || "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-44">
              <span
                className="block truncate"
                title={event.asOrganization || undefined}
              >
                {event.asOrganization || "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-24">
              <span className="block truncate font-mono">
                {event.asn ? `AS${event.asn}` : "--"}
              </span>
            </TableCell>
            <TableCell className="max-w-52">
              <CountryRegionMeta
                locale={locale}
                messages={messages}
                country={event.country || ""}
                region={event.region}
                className="w-full"
              />
            </TableCell>
            <TableCell className="max-w-64">
              <span
                className="block truncate font-mono"
                title={event.pathname || "/"}
              >
                {event.pathname || "/"}
              </span>
            </TableCell>
            <TableCell className="max-w-28 pr-4">
              <span className="block truncate font-mono tabular-nums text-muted-foreground">
                {latencyFormat(locale, copy, event.edgeLatencyMs)}
              </span>
            </TableCell>
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
    [copy, handleKeyDown, locale, messages, now, openEvent],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <RequestObservationRowSkeletonContent
        index={index}
        widths={NORMAL_REQUEST_SKELETON_WIDTHS}
      />
    ),
    [],
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
          <div className="shrink-0 text-xs text-muted-foreground">
            {!loading && events.length > 0
              ? hasMore
                ? `${copy.recentShowing} ${numberFormat(locale, events.length)}`
                : copy.recentLoadedAll
              : ""}
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
          columnCount={10}
          loading={loading}
          loadingMore={loadingMore}
          errorContent={copy.loadFailed}
          emptyContent={copy.noData}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
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

/*
function LegacyRequestObservationClient({
  locale,
  messages,
}: RequestObservationClientProps) {
  const copy = messages.requestObservation;
  const [minutes, setMinutes] = useState<WindowMinutes>(43200);
  const [data, setData] = useState<RequestObservationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useMemo(
    () => async (nextMinutes: WindowMinutes, mode: "initial" | "refresh") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      try {
        const next = await fetchRequestObservation(nextMinutes);
        setData(next);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy.loadFailed);
      } finally {
        if (mode === "initial") setLoading(false);
        else setRefreshing(false);
      }
    },
    [copy.loadFailed],
  );

  useEffect(() => {
    void load(minutes, "initial");
  }, [load, minutes]);

  const formatter = useMemo(
    () => new Intl.NumberFormat(intlLocale(locale)),
    [locale],
  );
  const trendTickFormatter = useMemo(
    () => trendTickDateFormat(locale, minutes),
    [locale, minutes],
  );
  const trendTooltipFormatter = useMemo(
    () => trendTooltipDateFormat(locale, minutes),
    [locale, minutes],
  );
  const trend = data?.trend ?? [];
  const events = data?.events ?? [];
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
  const trendConfig = useMemo(() => trendChartConfig(copy), [copy]);
  const formatTrendTooltipValue = useMemo(
    () =>
      createTrendTooltipFormatter({
        botRequestsLabel: copy.botRequests,
        botTrafficRatioLabel: copy.botTrafficRatio,
        countFormatter: formatter,
        locale,
      }),
    [copy.botRequests, copy.botTrafficRatio, formatter, locale],
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
          value: "confidence",
          label: copy.confidence,
          columnLabel: copy.confidence,
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
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "hostname",
          label: copy.hostname,
          columnLabel: copy.hostname,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "pathname",
          label: copy.pathname,
          columnLabel: copy.pathname,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "origin",
          label: copy.origin,
          columnLabel: copy.origin,
          primaryMetricLabel: copy.blocked,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<TargetDimensionTab>,
        ...AsyncDimensionBreakdownTab<TargetDimensionTab>[],
      ],
    [copy],
  );
  const networkTabs = useMemo(
    () =>
      [
        {
          value: "asOrganization",
          label: copy.asOrganization,
          columnLabel: copy.asOrganization,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "asn",
          label: copy.asn,
          columnLabel: copy.asn,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "country",
          label: copy.country,
          columnLabel: copy.country,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "region",
          label: copy.region,
          columnLabel: copy.region,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "city",
          label: copy.city,
          columnLabel: copy.city,
          primaryMetricLabel: copy.blocked,
        },
        {
          value: "colo",
          label: copy.colo,
          columnLabel: copy.colo,
          primaryMetricLabel: copy.blocked,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<NetworkDimensionTab>,
        ...AsyncDimensionBreakdownTab<NetworkDimensionTab>[],
      ],
    [copy],
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
  const loadDetectionRows = useMemo(
    () => async (tab: DetectionDimensionTab) =>
      toAsyncDimensionRows(
        aggregateDimensionRows(events, copy, (event) =>
          valuesForDetectionTab(event, tab, copy),
        ),
      ),
    [copy, events],
  );
  const loadTargetRows = useMemo(
    () => async (tab: TargetDimensionTab) =>
      toAsyncDimensionRows(
        aggregateDimensionRows(events, copy, (event) =>
          valuesForTargetTab(event, tab),
        ),
        { targetTab: tab },
      ),
    [copy, events],
  );
  const loadNetworkRows = useMemo(
    () => async (tab: NetworkDimensionTab) =>
      toAsyncDimensionRows(
        aggregateDimensionRows(events, copy, (event) =>
          valuesForNetworkTab(event, tab),
        ),
        {
          networkTab: tab,
          locale,
          unknownLabel: copy.emptyValue,
        },
      ),
    [copy, events, locale],
  );
  const loadClientRows = useMemo(
    () => async (tab: ClientDimensionTab) =>
      toAsyncDimensionRows(
        aggregateDimensionRows(events, copy, (event) =>
          valuesForClientTab(event, tab),
        ),
      ),
    [copy, events],
  );

  return (
    <div className="space-y-6 pb-6">
      <div className="pointer-events-none relative z-20 mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 pt-4 md:px-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {copy.title}
          </h1>
          <p className="max-w-prose text-sm text-foreground/75">
            {copy.subtitle}
          </p>
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <Select
            value={String(minutes)}
            onValueChange={(value) =>
              setMinutes(Number(value) as WindowMinutes)
            }
          >
            <SelectTrigger className="w-[160px] bg-background/90 backdrop-blur">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {windowLabel(messages, option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="bg-background/90 backdrop-blur"
            onClick={() => load(minutes, "refresh")}
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

      <div className="relative">
        <div
          aria-hidden={showDemoOverlay}
          className={cn(
            "space-y-6 transition duration-200",
            showDemoOverlay && "pointer-events-none select-none blur-sm",
          )}
        >
          <div className="relative h-[min(72svh,calc(100svh-10.5rem))] min-h-[18rem] overflow-hidden bg-background sm:min-h-[22rem]">
            <GeoPointsMapIsland
              locale={locale}
              messages={messages}
              points={data?.mapPoints ?? []}
              loading={loading}
              emptyLabel={copy.noData}
              heightClassName="h-full"
              countryHoverEnabled={false}
              pointColor={[239, 68, 68]}
              projectionMode="globe"
              autoRotate
            />

            <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-background via-background/65 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-background via-background/70 to-transparent" />
          </div>

          <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
            <div className="space-y-6">
              <Card className="py-0">
                <CardContent className="p-0">
                  <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
                    <MetricTile
                      icon={RiRobot2Line}
                      label={copy.botRequests}
                      value={numberFormat(locale, data?.summary.total ?? 0)}
                      detail={windowLabel(messages, minutes)}
                      loading={loading}
                    />
                    <MetricTile
                      icon={RiRadarLine}
                      label={copy.botRequestRatio}
                      value={percentFormat(
                        locale,
                        data?.summary.botRequestRatio ?? 0,
                      )}
                      detail={copy.rollupBaseline}
                      loading={loading}
                    />
                    <MetricTile
                      icon={RiShieldCheckLine}
                      label={copy.highConfidenceBots}
                      value={numberFormat(
                        locale,
                        data?.summary.highConfidence ?? 0,
                      )}
                      detail={copy.confidence}
                      loading={loading}
                    />
                    <MetricTile
                      icon={RiGlobalLine}
                      label={copy.affectedSites}
                      value={numberFormat(
                        locale,
                        data?.summary.affectedSites ?? 0,
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
                  <CardDescription>{copy.trendDescription}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer
                    config={trendConfig}
                    className="h-[320px] w-full"
                  >
                    <ComposedChart data={trend}>
                      <defs>
                        <linearGradient
                          id="request-observation-count-fill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="var(--color-count)"
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="95%"
                            stopColor="var(--color-count)"
                            stopOpacity={0.03}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="timestampMs"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tickFormatter={(value) =>
                          trendTickFormatter.format(
                            new Date(Number(value ?? 0)),
                          )
                        }
                        minTickGap={14}
                      />
                      <YAxis
                        yAxisId="bots"
                        width={52}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) =>
                          formatter.format(Number(value))
                        }
                      />
                      <YAxis
                        yAxisId="ratio"
                        orientation="right"
                        width={44}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) =>
                          percentFormat(locale, Number(value))
                        }
                      />
                      <ChartTooltip
                        allowEscapeViewBox={{ x: false, y: true }}
                        wrapperStyle={{ zIndex: 20 }}
                        content={
                          <ChartTooltipContent
                            indicator="dot"
                            labelFormatter={(value, payload) => {
                              const timestamp = Number(
                                payload?.[0]?.payload?.timestampMs ??
                                  value ??
                                  0,
                              );
                              return trendTooltipFormatter.format(
                                new Date(timestamp),
                              );
                            }}
                            formatter={formatTrendTooltipValue}
                          />
                        }
                      />
                      <Area
                        yAxisId="bots"
                        type="monotone"
                        dataKey="count"
                        stroke="var(--color-count)"
                        fill="url(#request-observation-count-fill)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        yAxisId="ratio"
                        type="monotone"
                        dataKey="botRatio"
                        stroke="var(--color-botRatio)"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </ComposedChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              <section className="grid gap-4 xl:grid-cols-2">
                <AsyncDimensionBreakdownCard
                  locale={locale}
                  messages={messages}
                  tabs={detectionTabs}
                  loadRows={loadDetectionRows}
                  requestKey={`${minutes}:${events.length}:detection`}
                  className="h-full"
                  secondaryMetricLabel={copy.highConfidenceRequests}
                  emptyLabel={copy.noData}
                />
                <AsyncDimensionBreakdownCard
                  locale={locale}
                  messages={messages}
                  tabs={targetTabs}
                  loadRows={loadTargetRows}
                  requestKey={`${minutes}:${events.length}:target`}
                  className="h-full"
                  secondaryMetricLabel={copy.highConfidenceRequests}
                  emptyLabel={copy.noData}
                />
                <AsyncDimensionBreakdownCard
                  locale={locale}
                  messages={messages}
                  tabs={networkTabs}
                  loadRows={loadNetworkRows}
                  requestKey={`${minutes}:${events.length}:network`}
                  className="h-full"
                  secondaryMetricLabel={copy.highConfidenceRequests}
                  emptyLabel={copy.noData}
                />
                <AsyncDimensionBreakdownCard
                  locale={locale}
                  messages={messages}
                  tabs={clientTabs}
                  loadRows={loadClientRows}
                  requestKey={`${minutes}:${events.length}:client`}
                  className="h-full"
                  secondaryMetricLabel={copy.highConfidenceRequests}
                  emptyLabel={copy.noData}
                />
              </section>

              <BotEventsTable
                locale={locale}
                messages={messages}
                copy={copy}
                events={events}
                loading={loading}
                requestKey={`${minutes}:${data?.generatedAt ?? 0}:${events.length}`}
                minutes={minutes}
              />
            </div>
          </div>
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
*/
