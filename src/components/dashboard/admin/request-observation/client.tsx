import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiGlobalLine,
  RiRadarLine,
  RiRefreshLine,
  RiRobot2Line,
  RiShieldCheckLine,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useAnimationControls } from "motion/react";
import { toast } from "sonner";

import { RequestObservationTrendChart } from "@/components/dashboard/charts/request-observation-trend-chart";
import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLoader,
  type AsyncDimensionBreakdownTab,
} from "@/components/dashboard/common/async-dimension-breakdown-card";
import { GeoPointsMapIsland } from "@/components/dashboard/geo/geo-points-map-island";
import { ShareRadialCard } from "@/components/dashboard/sharing/share-radial-card";
import { useDashboardQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import { formatI18nTemplate } from "@/lib/i18n/template";
import Link from "@/lib/router";
import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

import { BlockedRequestsTable } from "./blocked-requests-table";
import {
  fetchRequestObservation,
  fetchRequestObservationDimension,
  fetchRequestObservationPage,
} from "./data";
import {
  asyncDimensionPage,
  MetricTile,
  toAsyncAggregatedDimensionRows,
} from "./helpers";
import { IncludedRequestsTable } from "./included-requests-table";
import {
  BLOCKED_POINT_COLOR,
  BOT_TRAFFIC_COLOR,
  type BotEvent,
  type ClientDimensionTab,
  CUSTOM_BLOCKED_TRAFFIC_COLOR,
  type DetectionDimensionTab,
  INCLUDED_POINT_COLOR,
  type IncludedTargetDimensionTab,
  isInvalidRequestObservationCursorError,
  latencyFormat,
  type NetworkDimensionTab,
  NORMAL_TRAFFIC_SHARE_COLOR,
  normalizeRequestObservationEvent,
  normalizeRequestObservationTab,
  type NormalRequestEvent,
  REQUEST_MAP_SLIDE_TRANSITION,
  REQUEST_OBSERVATION_TAB_INDEX,
  type RequestMapPoint,
  type RequestObservationClientProps,
  type RequestObservationData,
  type RequestObservationMapConfig,
  requestObservationUiLabels,
  SUSPECTED_BOT_TRAFFIC_COLOR,
  type TargetDimensionTab,
} from "./model";
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
  const [loadingMore, setLoadingMore] = useState<"blocked" | "included" | null>(
    null,
  );
  const ui = useMemo(
    () => requestObservationUiLabels(locale, copy),
    [copy, locale],
  );
  const mapAnimationControls = useAnimationControls();
  const observationQueryKey = useMemo(
    () =>
      [
        "dashboard",
        "request-observation",
        timeWindow.from,
        timeWindow.to,
        timeWindow.interval,
        timeWindow.timeZone,
      ] as const,
    [timeWindow.from, timeWindow.interval, timeWindow.timeZone, timeWindow.to],
  );
  const observationQuery = useQuery({
    queryKey: observationQueryKey,
    queryFn: ({ signal }) => fetchRequestObservation(timeWindow, signal),
    enabled: typeof window !== "undefined",
  });
  const data = observationQuery.data ?? null;
  const loading = observationQuery.isPending;
  const refreshing = observationQuery.isFetching && !observationQuery.isPending;
  const spanMs = Math.max(1, timeWindow.to - timeWindow.from);
  const windowDetail = formatI18nTemplate(copy.overviewLabels.windowDays, {
    days: Math.max(1, Math.ceil(spanMs / 86400000)),
  });
  const labels = copy.overviewLabels;
  const trendLabels = useMemo(
    () => ({
      ...labels,
      normalRequests: ui.normalRequests,
      suspectedBotRequests: ui.suspectedBotRequests,
      botRequests: ui.botRequests,
      customBlockedRequests: ui.customBlockedRequests,
      includedRequests: ui.includedRequests,
      blockedRequests: ui.blockedRequests,
      totalRequests: ui.totalRequests,
      botRatio: ui.botRequestRatio,
      blockedRatio: ui.blockedRequestRatio,
      normalRatio: ui.normalRequestRatio,
      normalTrafficShare: ui.normalTrafficShare,
      suspectedBotTraffic: ui.suspectedBotTraffic,
      botTraffic: ui.botTraffic,
      customBlockedTraffic: ui.customBlockedTraffic,
      pageview: copy.requestKindLabels.pageview,
      leave: copy.requestKindLabels.leave,
      visibility: copy.requestKindLabels.visibility,
      customEvent: copy.requestKindLabels.custom_event,
      identify: copy.requestKindLabels.identify,
    }),
    [copy.requestKindLabels, labels, ui],
  );

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

  const loadingMoreRef = useRef<"blocked" | "included" | null>(null);
  const loadMoreEvents = useCallback(
    async (source: "blocked" | "included") => {
      if (loadingMoreRef.current !== null) return;

      const currentData =
        queryClient.getQueryData<RequestObservationData | null>(
          observationQueryKey,
        );
      const section = currentData?.[source];
      if (!section?.pagination?.hasMore || !section.pagination.nextCursor)
        return;

      loadingMoreRef.current = source;
      setLoadingMore(source);
      try {
        const page = await fetchRequestObservationPage(
          timeWindow,
          source,
          section.pagination.nextCursor,
        );
        queryClient.setQueryData<RequestObservationData | null>(
          observationQueryKey,
          (current) => {
            if (!current || !Array.isArray(page.items)) {
              return current;
            }
            const pageEvents = page.items.map((event) =>
              normalizeRequestObservationEvent(
                event as BotEvent & NormalRequestEvent,
                source,
              ),
            );
            if (source === "blocked") {
              return {
                ...current,
                events: [...current.events, ...(pageEvents as BotEvent[])],
                blocked: {
                  ...current.blocked!,
                  events: [
                    ...current.blocked!.events,
                    ...(pageEvents as BotEvent[]),
                  ],
                  pagination: page.pagination,
                },
              };
            }
            return {
              ...current,
              normalEvents: [
                ...(current.normalEvents ?? []),
                ...(pageEvents as NormalRequestEvent[]),
              ],
              included: {
                ...current.included!,
                events: [
                  ...current.included!.events,
                  ...(pageEvents as NormalRequestEvent[]),
                ],
                pagination: page.pagination,
              },
            };
          },
        );
      } catch (error) {
        if (isInvalidRequestObservationCursorError(error)) {
          try {
            const refreshed = await fetchRequestObservation(timeWindow);
            queryClient.setQueryData<RequestObservationData | null>(
              observationQueryKey,
              refreshed,
            );
          } catch (refreshError) {
            toast.error(
              refreshError instanceof Error
                ? refreshError.message
                : copy.loadFailed,
            );
          }
          return;
        }
        toast.error(error instanceof Error ? error.message : copy.loadFailed);
      } finally {
        if (loadingMoreRef.current === source) {
          loadingMoreRef.current = null;
          setLoadingMore(null);
        }
      }
    },
    [copy.loadFailed, observationQueryKey, queryClient, timeWindow],
  );
  const loadMoreBlockedEvents = useCallback(() => {
    void loadMoreEvents("blocked");
  }, [loadMoreEvents]);
  const loadMoreIncludedEvents = useCallback(() => {
    void loadMoreEvents("included");
  }, [loadMoreEvents]);

  const trend = data?.trend ?? [];
  const blockedEvents = data?.blocked?.events ?? data?.events ?? [];
  const includedEvents = data?.included?.events ?? data?.normalEvents ?? [];
  const blockedMapPoints = useMemo(
    () =>
      (data?.blocked?.mapPoints ?? data?.mapPoints ?? []).map((point) => ({
        ...point,
        source: "blocked" as const,
        color: BLOCKED_POINT_COLOR,
      })),
    [data],
  );
  const includedMapPoints = useMemo(
    () =>
      (data?.included?.mapPoints ?? []).map((point) => ({
        ...point,
        source: "included" as const,
        color: INCLUDED_POINT_COLOR,
      })),
    [data],
  );
  const overviewMapPoints = useMemo(
    () => [...includedMapPoints, ...blockedMapPoints],
    [blockedMapPoints, includedMapPoints],
  );
  const activeMap = useMemo<RequestObservationMapConfig>(() => {
    if (activeTab === "blocked") {
      return {
        key: "blocked",
        points: blockedMapPoints,
        pointColor: BLOCKED_POINT_COLOR,
        collapseOverlappingPointColors: false,
      };
    }
    if (activeTab === "included") {
      return {
        key: "included",
        points: includedMapPoints,
        pointColor: INCLUDED_POINT_COLOR,
        collapseOverlappingPointColors: false,
      };
    }
    return {
      key: "overview",
      points: overviewMapPoints,
      pointColor: INCLUDED_POINT_COLOR,
      collapseOverlappingPointColors: true,
    };
  }, [activeTab, blockedMapPoints, includedMapPoints, overviewMapPoints]);
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
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "category",
          label: copy.category,
          columnLabel: copy.category,
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "kind",
          label: copy.kind,
          columnLabel: copy.kind,
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "botScoreBucket",
          label: copy.botScoreBucket,
          columnLabel: copy.botScoreBucket,
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "verifiedBotCategory",
          label: copy.verifiedBotCategory,
          columnLabel: copy.verifiedBotCategory,
          primaryMetricLabel: ui.blockedRequests,
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
  const includedTargetTabs = useMemo(
    () =>
      [
        targetTabs[0],
        targetTabs[1],
        {
          value: "category",
          label: copy.category,
          columnLabel: copy.category,
          primaryMetricLabel: labels.requests,
        },
        targetTabs[2],
        targetTabs[3],
      ] satisfies [
        AsyncDimensionBreakdownTab<IncludedTargetDimensionTab>,
        ...AsyncDimensionBreakdownTab<IncludedTargetDimensionTab>[],
      ],
    [copy.category, labels.requests, targetTabs],
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
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "userAgent",
          label: copy.userAgent,
          columnLabel: copy.userAgent,
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "userAgentLengthBucket",
          label: copy.userAgentLengthBucket,
          columnLabel: copy.userAgentLengthBucket,
          primaryMetricLabel: ui.blockedRequests,
        },
        {
          value: "ipPrefix",
          label: copy.ipPrefix,
          columnLabel: copy.ipPrefix,
          primaryMetricLabel: ui.blockedRequests,
        },
      ] satisfies [
        AsyncDimensionBreakdownTab<ClientDimensionTab>,
        ...AsyncDimensionBreakdownTab<ClientDimensionTab>[],
      ],
    [copy],
  );

  const loadBlockedDimensionRows = useMemo(
    () =>
      async (
        group: "detection" | "target" | "network" | "client",
        tab: string,
        signal?: AbortSignal,
      ) =>
        toAsyncAggregatedDimensionRows(
          await fetchRequestObservationDimension(
            timeWindow,
            "blocked",
            group,
            tab,
            signal,
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
  const loadIncludedDimensionRows = useMemo(
    () =>
      async (group: "target" | "network", tab: string, signal?: AbortSignal) =>
        toAsyncAggregatedDimensionRows(
          await fetchRequestObservationDimension(
            timeWindow,
            "included",
            group,
            tab,
            signal,
          ),
          group === "network"
            ? {
                networkTab: tab as NetworkDimensionTab,
                locale,
                unknownLabel: copy.emptyValue,
              }
            : tab === "category"
              ? { detectionTab: "category", copy }
              : { targetTab: tab as TargetDimensionTab },
        ),
    [copy, locale, timeWindow],
  );
  const loadBlockedDetection = useCallback<
    AsyncDimensionBreakdownLoader<DetectionDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadBlockedDimensionRows("detection", tab, signal),
        limit,
      ),
    [loadBlockedDimensionRows],
  );
  const loadBlockedTarget = useCallback<
    AsyncDimensionBreakdownLoader<TargetDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadBlockedDimensionRows("target", tab, signal),
        limit,
      ),
    [loadBlockedDimensionRows],
  );
  const loadBlockedNetwork = useCallback<
    AsyncDimensionBreakdownLoader<NetworkDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadBlockedDimensionRows("network", tab, signal),
        limit,
      ),
    [loadBlockedDimensionRows],
  );
  const loadBlockedClient = useCallback<
    AsyncDimensionBreakdownLoader<ClientDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadBlockedDimensionRows("client", tab, signal),
        limit,
      ),
    [loadBlockedDimensionRows],
  );
  const loadIncludedTarget = useCallback<
    AsyncDimensionBreakdownLoader<IncludedTargetDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadIncludedDimensionRows("target", tab, signal),
        limit,
      ),
    [loadIncludedDimensionRows],
  );
  const loadIncludedNetwork = useCallback<
    AsyncDimensionBreakdownLoader<NetworkDimensionTab>
  >(
    async ({ tab, limit, signal }) =>
      asyncDimensionPage(
        await loadIncludedDimensionRows("network", tab, signal),
        limit,
      ),
    [loadIncludedDimensionRows],
  );
  const requestKey = `${timeWindow.from}:${timeWindow.to}:${timeWindow.interval}:${timeWindow.timeZone}:${locale}`;
  const overview = data?.overview;
  const blockedSummary = data?.blocked?.summary;
  const includedSummary = data?.included?.summary;
  const categoryShareItems = useMemo(
    () => [
      {
        key: "normal",
        label: ui.normalTrafficShare,
        value: overview?.normalRequests ?? 0,
        color: NORMAL_TRAFFIC_SHARE_COLOR,
      },
      {
        key: "suspected_bot",
        label: ui.suspectedBotTraffic,
        value: overview?.suspectedBotRequests ?? 0,
        color: SUSPECTED_BOT_TRAFFIC_COLOR,
      },
      {
        key: "bot",
        label: ui.botTraffic,
        value: overview?.botRequests ?? 0,
        color: BOT_TRAFFIC_COLOR,
      },
      {
        key: "custom_block",
        label: ui.customBlockedTraffic,
        value: overview?.customBlockedRequests ?? 0,
        color: CUSTOM_BLOCKED_TRAFFIC_COLOR,
      },
    ],
    [
      overview?.botRequests,
      overview?.customBlockedRequests,
      overview?.suspectedBotRequests,
      ui.customBlockedTraffic,
      ui.botTraffic,
      ui.normalTrafficShare,
      ui.suspectedBotTraffic,
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
          {ui.pageSubtitle}
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
                label={ui.totalRequests}
                value={numberFormat(locale, overview?.totalRequests ?? 0)}
                detail={windowDetail}
                loading={loading}
              />
              <MetricTile
                icon={RiRobot2Line}
                label={ui.blockedRequestRatio}
                value={percentFormat(
                  locale,
                  overview?.blockedRequestRatio ?? 0,
                )}
                detail={`${labels.requests}: ${numberFormat(
                  locale,
                  overview?.blockedRequests ?? 0,
                )}`}
                loading={loading}
              />
              <MetricTile
                icon={RiRobot2Line}
                label={ui.botRequestRatio}
                value={percentFormat(locale, overview?.botRequestRatio ?? 0)}
                detail={`${labels.requests}: ${numberFormat(
                  locale,
                  overview?.botRequests ?? 0,
                )}`}
                loading={loading}
              />
              <MetricTile
                icon={RiGlobalLine}
                label={labels.avgLatency}
                value={latencyFormat(locale, copy, overview?.avgLatencyMs)}
                detail={`${labels.p95Latency}: ${latencyFormat(
                  locale,
                  copy,
                  overview?.p95LatencyMs,
                )}`}
                loading={loading}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.overviewTrendTitle}</CardTitle>
            <CardDescription>{ui.blockedTrendDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <RequestObservationTrendChart
              data={trend}
              labels={trendLabels}
              locale={locale}
              spanMs={spanMs}
              variant="overview"
              className="h-[320px]"
            />
          </CardContent>
        </Card>

        <section className="grid min-w-0 gap-4 xl:grid-cols-2">
          <ShareRadialCard
            className="min-w-0 xl:col-span-2"
            title={labels.categoryShareTitle}
            items={categoryShareItems}
            maxItems={4}
            locale={locale}
            valueLabel={labels.requests}
            loading={loading}
            emptyLabel={copy.noData}
          />

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{labels.trafficCompositionTitle}</CardTitle>
              <CardDescription>
                {labels.trafficCompositionDescription}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RequestObservationTrendChart
                data={trend}
                labels={trendLabels}
                locale={locale}
                spanMs={spanMs}
                variant="traffic-composition"
                className="h-[280px]"
              />
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{labels.latencyTitle}</CardTitle>
              <CardDescription>{labels.latencyDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <RequestObservationTrendChart
                data={trend}
                labels={trendLabels}
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
              ) : activeTab === "blocked" ? (
                <div className="space-y-6">
                  <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
                    <div className="space-y-6">
                      <Card className="py-0">
                        <CardContent className="p-0">
                          <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
                            <MetricTile
                              icon={RiRobot2Line}
                              label={ui.blockedRequests}
                              value={numberFormat(
                                locale,
                                blockedSummary?.total ??
                                  overview?.blockedRequests ??
                                  0,
                              )}
                              detail={windowDetail}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={ui.blockedRequestRatio}
                              value={percentFormat(
                                locale,
                                blockedSummary?.ratio ??
                                  overview?.blockedRequestRatio ??
                                  0,
                              )}
                              detail={`${labels.requests}: ${numberFormat(
                                locale,
                                blockedSummary?.total ??
                                  overview?.blockedRequests ??
                                  0,
                              )}`}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiShieldCheckLine}
                              label={ui.botRequests}
                              value={numberFormat(
                                locale,
                                blockedSummary?.botRequests ?? 0,
                              )}
                              detail={copy.category}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiGlobalLine}
                              label={copy.affectedSites}
                              value={numberFormat(
                                locale,
                                blockedSummary?.affectedSites ?? 0,
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
                            {ui.blockedTrendDescription}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <RequestObservationTrendChart
                            data={trend}
                            labels={trendLabels}
                            locale={locale}
                            spanMs={spanMs}
                            variant="blocked"
                            className="h-[320px]"
                          />
                        </CardContent>
                      </Card>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={detectionTabs}
                          loader={loadBlockedDetection}
                          requestKey={`${requestKey}:detection`}
                          className="h-full"
                          secondaryMetricLabel={ui.botRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={targetTabs}
                          loader={loadBlockedTarget}
                          requestKey={`${requestKey}:target`}
                          className="h-full"
                          secondaryMetricLabel={ui.botRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loader={loadBlockedNetwork}
                          requestKey={`${requestKey}:network`}
                          className="h-full"
                          secondaryMetricLabel={ui.botRequests}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={clientTabs}
                          loader={loadBlockedClient}
                          requestKey={`${requestKey}:client`}
                          className="h-full"
                          secondaryMetricLabel={ui.botRequests}
                          emptyLabel={copy.noData}
                        />
                      </section>

                      <BlockedRequestsTable
                        locale={locale}
                        messages={messages}
                        copy={copy}
                        events={blockedEvents}
                        loading={loading}
                        hasMore={data?.blocked?.pagination?.hasMore ?? false}
                        loadingMore={loadingMore === "blocked"}
                        onLoadMore={loadMoreBlockedEvents}
                        timeWindow={timeWindow}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
                    <div className="space-y-6">
                      <Card className="py-0">
                        <CardContent className="p-0">
                          <div className="grid gap-px overflow-hidden bg-border/70 md:grid-cols-2 xl:grid-cols-4">
                            <MetricTile
                              icon={RiShieldCheckLine}
                              label={ui.includedRequests}
                              value={numberFormat(
                                locale,
                                includedSummary?.total ??
                                  overview?.includedRequests ??
                                  0,
                              )}
                              detail={percentFormat(
                                locale,
                                overview?.includedRequests &&
                                  overview.totalRequests > 0
                                  ? overview.includedRequests /
                                      overview.totalRequests
                                  : 0,
                              )}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={labels.pageviews}
                              value={numberFormat(
                                locale,
                                includedSummary?.pageviews ??
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
                                includedSummary?.uniqueCountries ?? 0,
                              )}
                              detail={copy.country}
                              loading={loading}
                            />
                            <MetricTile
                              icon={RiRadarLine}
                              label={labels.avgLatency}
                              value={latencyFormat(
                                locale,
                                copy,
                                includedSummary?.avgLatencyMs,
                              )}
                              detail={`${labels.p95Latency}: ${latencyFormat(
                                locale,
                                copy,
                                includedSummary?.p95LatencyMs,
                              )}`}
                              loading={loading}
                            />
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>{copy.trendTitle}</CardTitle>
                          <CardDescription>
                            {ui.includedTrendDescription}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <RequestObservationTrendChart
                            data={trend}
                            labels={trendLabels}
                            locale={locale}
                            spanMs={spanMs}
                            variant="included"
                            className="h-[320px]"
                          />
                        </CardContent>
                      </Card>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={includedTargetTabs}
                          loader={loadIncludedTarget}
                          requestKey={`${requestKey}:included-target`}
                          className="h-full"
                          showVisitors={false}
                          emptyLabel={copy.noData}
                        />
                        <AsyncDimensionBreakdownCard
                          locale={locale}
                          messages={messages}
                          tabs={networkTabs}
                          loader={loadIncludedNetwork}
                          requestKey={`${requestKey}:included-network`}
                          className="h-full"
                          showVisitors={false}
                          emptyLabel={copy.noData}
                        />
                      </section>

                      <IncludedRequestsTable
                        locale={locale}
                        messages={messages}
                        copy={copy}
                        events={includedEvents}
                        loading={loading}
                        hasMore={data?.included?.pagination?.hasMore ?? false}
                        loadingMore={loadingMore === "included"}
                        onLoadMore={loadMoreIncludedEvents}
                        timeWindow={timeWindow}
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
