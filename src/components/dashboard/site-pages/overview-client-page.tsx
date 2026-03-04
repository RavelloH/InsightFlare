"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { EngagementChart } from "@/components/dashboard/engagement-chart";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { DistributionDonutChart } from "@/components/dashboard/distribution-donut-chart";
import { SessionDurationChart } from "@/components/dashboard/session-duration-chart";
import { RealtimePanel } from "@/components/dashboard/realtime-panel";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { Spinner } from "@/components/ui/spinner";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import {
  loadFilterOptions,
  loadOverviewBundle,
  type FilterOptions,
  type OverviewBundle,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { cn } from "@/lib/utils";

interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

function toDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function emptyOverviewBundle(interval: TimeWindow["interval"]): OverviewBundle {
  return {
    overview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    previousOverview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    trend: {
      ok: true,
      interval,
      data: [],
    },
    pages: { ok: true, data: [] },
    referrers: { ok: true, data: [] },
    sessions: { ok: true, data: [] },
    events: { ok: true, data: [] },
    countries: { ok: true, data: [] },
    devices: { ok: true, data: [] },
    browsers: { ok: true, data: [] },
    eventTypes: { ok: true, data: [] },
  };
}

const EMPTY_FILTER_OPTIONS: FilterOptions = {
  countries: [],
  devices: [],
  browsers: [],
  eventTypes: [],
};
const METRIC_AREA_COLOR = "var(--color-chart-1)";
const MAX_TREND_PLACEHOLDER_POINTS = 120;

function trendStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function buildEmptyTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval">,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return [];
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const totalBuckets = toBucket - fromBucket + 1;
  const stride = Math.max(
    1,
    Math.ceil(totalBuckets / MAX_TREND_PLACEHOLDER_POINTS),
  );
  const points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];

  for (let bucket = fromBucket; bucket <= toBucket; bucket += stride) {
    points.push({
      timestampMs: bucket * stepMs,
      views: 0,
      sessions: 0,
    });
  }

  const lastTimestampMs = toBucket * stepMs;
  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      views: 0,
      sessions: 0,
    });
  }

  return points;
}

function normalizeTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval">,
  points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }>,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return points;
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const byBucket = new Map<number, { views: number; sessions: number }>();

  for (const point of points) {
    const bucket = Math.floor(Number(point.timestampMs ?? 0) / stepMs);
    if (!Number.isFinite(bucket) || bucket < fromBucket || bucket > toBucket) {
      continue;
    }
    const prev = byBucket.get(bucket) ?? { views: 0, sessions: 0 };
    byBucket.set(bucket, {
      views: prev.views + Math.max(0, Number(point.views ?? 0)),
      sessions: prev.sessions + Math.max(0, Number(point.sessions ?? 0)),
    });
  }

  const normalized: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];
  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    const value = byBucket.get(bucket);
    normalized.push({
      timestampMs: bucket * stepMs,
      views: value?.views ?? 0,
      sessions: value?.sessions ?? 0,
    });
  }

  return normalized;
}

function metricCellBorderClasses(index: number): string {
  const mobileHasLeft = index % 2 === 1;
  const mobileHasTop = index >= 2;
  const wideHasLeft = index % 3 !== 0;
  const wideHasTop = index >= 3;

  return cn(
    mobileHasLeft ? "border-l" : "",
    mobileHasTop ? "border-t" : "",
    mobileHasLeft !== wideHasLeft
      ? wideHasLeft
        ? "sm:border-l"
        : "sm:border-l-0"
      : "",
    mobileHasTop !== wideHasTop
      ? wideHasTop
        ? "sm:border-t"
        : "sm:border-t-0"
      : "",
  );
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({ value }: { value: number | null }) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

interface MetricAreaPoint {
  timestampMs: number;
  value: number;
}

function MetricAreaMap({
  points,
  color,
  locale,
  label,
  formatValue,
}: {
  points: MetricAreaPoint[];
  color: string;
  locale: Locale;
  label: string;
  formatValue: (value: number) => string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );
  const chartData = useMemo(() => {
    const normalized = points.map((point, index) => ({
      index,
      timestampMs: Number.isFinite(point.timestampMs) ? point.timestampMs : 0,
      value: Number.isFinite(point.value) ? Math.max(0, point.value) : 0,
    }));

    if (normalized.length >= 2) return normalized;
    if (normalized.length === 1) {
      const first = normalized[0] ?? { index: 0, value: 0, timestampMs: 0 };
      return [
        first,
        {
          index: 1,
          value: first.value,
          timestampMs: first.timestampMs + 1,
        },
      ];
    }
    return [
      { index: 0, value: 0, timestampMs: 0 },
      { index: 1, value: 0, timestampMs: 1 },
    ];
  }, [points]);

  return (
    <div className="h-full w-full">
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.36} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <Tooltip
              cursor={{ stroke: color, strokeOpacity: 0.28, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const item = payload[0]?.payload as
                  | { timestampMs?: number; value?: number }
                  | undefined;
                const timestampMs = Number(item?.timestampMs ?? 0);
                const value = Number(item?.value ?? 0);

                return (
                  <div className="rounded-none border border-border/50 bg-background px-2 py-1 text-[11px] shadow-xl">
                    <p className="text-muted-foreground">
                      {dateFormatter.format(new Date(timestampMs))}
                    </p>
                    <p className="font-mono text-foreground">
                      {label}: {formatValue(value)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="linear"
              dataKey="value"
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2, stroke: color, fill: color }}
              isAnimationActive
              animationDuration={280}
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-card via-card/80 to-transparent" />
      </div>
    </div>
  );
}

export function OverviewClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: OverviewClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [bundle, setBundle] = useState<OverviewBundle | null>(null);
  const [filterOptions, setFilterOptions] =
    useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      loadOverviewBundle(siteId, window, filters),
      loadFilterOptions(siteId, window),
    ])
      .then(([nextBundle, nextFilterOptions]) => {
        if (!active) return;
        setBundle(nextBundle);
        setFilterOptions(nextFilterOptions);
      })
      .catch(() => {
        if (!active) return;
        setBundle(emptyOverviewBundle(window.interval));
        setFilterOptions(EMPTY_FILTER_OPTIONS);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    siteId,
    window.from,
    window.to,
    window.interval,
    filters.country,
    filters.device,
    filters.browser,
    filters.eventType,
  ]);

  const data = useMemo(
    () => bundle ?? emptyOverviewBundle(window.interval),
    [bundle, window.interval],
  );
  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );

  const previous = data.previousOverview.data;
  const noDataText = messages.common.noData;
  const currentPagesPerSession =
    data.overview.data.sessions > 0
      ? data.overview.data.views / data.overview.data.sessions
      : 0;
  const previousPagesPerSession =
    previous.sessions > 0 ? previous.views / previous.sessions : 0;
  const detailSeries = data.overview.detail?.data ?? data.trend.data;
  const trendDisplayData = useMemo(() => {
    if (loading) {
      return buildEmptyTrendData(window);
    }
    return normalizeTrendData(window, data.trend.data);
  }, [loading, window.from, window.to, window.interval, data.trend.data]);

  const viewsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.views,
  }));
  const visitorsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.visitors,
  }));
  const sessionsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.sessions,
  }));
  const bounceRateSeries = detailSeries
    .filter((point) => point.views > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.bounces / point.views,
    }));
  const pagesPerSessionSeries = detailSeries
    .filter((point) => point.sessions > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.views / point.sessions,
    }));
  const avgDurationSeries = detailSeries
    .filter((point) => point.views > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.avgDurationMs,
    }));

  const eventTypeItems = data.eventTypes.data.map((item) => ({
    label: item.value || messages.common.unknown,
    value: item.views,
  }));
  const compositionItems = [
    { label: messages.common.views, value: data.overview.data.views },
    { label: messages.common.sessions, value: data.overview.data.sessions },
    { label: messages.common.visitors, value: data.overview.data.visitors },
    { label: messages.common.bounces, value: data.overview.data.bounces },
  ];

  const metrics = [
    {
      label: messages.common.views,
      value: numberFormat(locale, data.overview.data.views),
      delta: toDeltaPercent(data.overview.data.views, previous.views),
      trend: viewsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.visitors,
      value: numberFormat(locale, data.overview.data.visitors),
      delta: toDeltaPercent(data.overview.data.visitors, previous.visitors),
      trend: visitorsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.sessions,
      value: numberFormat(locale, data.overview.data.sessions),
      delta: toDeltaPercent(data.overview.data.sessions, previous.sessions),
      trend: sessionsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.bounceRate,
      value: percentFormat(locale, data.overview.data.bounceRate),
      delta: toDeltaPercent(data.overview.data.bounceRate, previous.bounceRate),
      inverted: true,
      trend: bounceRateSeries,
      formatTrendValue: (value: number) => percentFormat(locale, value),
    },
    {
      label: messages.teamManagement.sites.pagesPerSession,
      value: pagesPerSessionFormatter.format(currentPagesPerSession),
      delta: toDeltaPercent(currentPagesPerSession, previousPagesPerSession),
      trend: pagesPerSessionSeries,
      formatTrendValue: (value: number) =>
        pagesPerSessionFormatter.format(value),
    },
    {
      label: messages.common.avgDuration,
      value: durationFormat(locale, data.overview.data.avgDurationMs),
      delta: toDeltaPercent(
        data.overview.data.avgDurationMs,
        previous.avgDurationMs,
      ),
      trend: avgDurationSeries,
      formatTrendValue: (value: number) =>
        durationFormat(locale, Math.max(0, Math.round(value))),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
      />

      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          <section className="grid grid-cols-2 sm:grid-cols-3">
            {metrics.map((item, index) => {
              const hasDelta =
                typeof item.delta === "number" && Number.isFinite(item.delta);
              const effectiveDelta = hasDelta
                ? item.inverted
                  ? -(item.delta ?? 0)
                  : (item.delta ?? 0)
                : null;

              return (
                <div
                  key={item.label}
                  className={metricCellBorderClasses(index)}
                >
                  <div className="flex min-h-[74px] items-stretch gap-3">
                    <div className="flex min-w-0 flex-1 flex-col justify-between px-3 py-2.5">
                      <p className="truncate text-xs text-muted-foreground mb-4">
                        {item.label}
                      </p>
                      <div>
                        <AutoResizer initial>
                          <AutoTransition initial>
                            {loading ? (
                              <div
                                key="loading"
                                className="inline-flex items-center"
                              >
                                <Spinner className="size-5" />
                              </div>
                            ) : (
                              <p
                                key="value"
                                className="inline-flex items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                              >
                                <span>{item.value}</span>
                                <ChangeRateInline value={effectiveDelta} />
                              </p>
                            )}
                          </AutoTransition>
                        </AutoResizer>
                      </div>
                    </div>
                    <div className="w-[60%] min-w-0">
                      <MetricAreaMap
                        points={item.trend}
                        color={METRIC_AREA_COLOR}
                        locale={locale}
                        label={item.label}
                        formatValue={item.formatTrendValue}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{messages.overview.trendTitle}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {messages.common.lastUpdated}: {shortDateTime(locale, Date.now())}
          </span>
        </CardHeader>
        <CardContent>
          {!loading && data.trend.data.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">
              <p>{noDataText}</p>
            </div>
          ) : (
            <TrendChart
              locale={locale}
              interval={window.interval}
              data={trendDisplayData}
              viewsLabel={messages.common.views}
              sessionsLabel={messages.common.sessions}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.topPages}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.pages.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.page}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.views}
                  </TableHead>
                  <TableHead className="text-right">
                    {messages.common.sessions}
                  </TableHead>
                </TableRow>
              }
              rows={data.pages.data.map((item) => (
                <TableRow key={`${item.pathname}-${item.views}`}>
                  <TableCell className="max-w-[260px] truncate font-mono">
                    {item.pathname || "/"}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.views)}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.sessions)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.topReferrers}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.referrers.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.referrer}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.views}
                  </TableHead>
                  <TableHead className="text-right">
                    {messages.common.sessions}
                  </TableHead>
                </TableRow>
              }
              rows={data.referrers.data.map((item) => (
                <TableRow key={`${item.referrer}-${item.views}`}>
                  <TableCell className="max-w-[260px] truncate font-mono">
                    {item.referrer || messages.common.unknown}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.views)}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.sessions)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>
      </div>

      <RealtimePanel siteId={siteId} locale={locale} messages={messages} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.engagementTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.trend.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <EngagementChart
                locale={locale}
                data={data.trend.data}
                viewsLabel={messages.common.views}
                sessionsLabel={messages.common.sessions}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.compositionTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={compositionItems.some((item) => item.value > 0)}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart items={compositionItems} />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.eventTypesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={eventTypeItems.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart items={eventTypeItems} />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.sessionDurationTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.sessions.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <SessionDurationChart
                durationsMs={data.sessions.data.map(
                  (item) => item.totalDurationMs,
                )}
              />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.geo}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.countries.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <TopItemsChart
                valueLabel={messages.common.views}
                items={data.countries.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.devices}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.devices.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart
                items={data.devices.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.browsers}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.browsers.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart
                items={data.browsers.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentSessions}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.sessions.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.startedAt}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.views}
                  </TableHead>
                  <TableHead className="text-right">
                    {messages.common.duration}
                  </TableHead>
                </TableRow>
              }
              rows={data.sessions.data.map((session) => (
                <TableRow key={session.sessionId}>
                  <TableCell>
                    {shortDateTime(locale, session.startedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, session.views)}
                  </TableCell>
                  <TableCell className="text-right">
                    {durationFormat(locale, session.totalDurationMs)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentEvents}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.events.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.event}</TableHead>
                  <TableHead>{messages.common.page}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.startedAt}
                  </TableHead>
                </TableRow>
              }
              rows={data.events.data.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    {event.eventType || messages.common.unknown}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate font-mono">
                    {event.pathname || "/"}
                  </TableCell>
                  <TableCell className="text-right">
                    {shortDateTime(locale, event.eventAt)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
