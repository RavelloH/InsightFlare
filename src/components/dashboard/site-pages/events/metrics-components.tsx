import { memo, type ReactNode, useMemo } from "react";
import type { RemixiconComponentType } from "@remixicon/react";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiDatabase2Line,
  RiFileList3Line,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import {
  createEventTrendChartData,
  createEventTrendChartSeries,
  createEventTrendComparisonChartSeries,
  EventTrendBarChart,
} from "@/components/dashboard/charts/event-trend-bar-chart";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  EventsTrendData,
  EventTrendSeries,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

import { type EventMetricSummary, type EventPageCopy } from "./types";
function EventMetricCell({
  icon: Icon,
  label,
  value,
  detail,
  detailKey,
  comparisonChange,
  loading = false,
}: {
  icon: RemixiconComponentType;
  label: string;
  value: string;
  detail: ReactNode;
  detailKey?: string;
  comparisonChange?: number | null;
  loading?: boolean;
}) {
  const contentKey = loading ? "loading" : `${value}:${comparisonChange ?? ""}`;

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
      <AutoResizer initial animateHeight={false} className="mt-3 h-7">
        <AutoTransition
          className="h-7"
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
            <div
              key={value}
              className="flex h-7 min-w-0 items-end gap-1.5 leading-none"
            >
              <span className="min-w-0 truncate font-mono text-xl leading-none font-semibold text-foreground">
                {value}
              </span>
              {comparisonChange !== undefined ? (
                <EventMetricChangeRate value={comparisonChange} />
              ) : null}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : (detailKey ?? "detail")}
        className="mt-3 h-[14px]"
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton
            key="loading"
            className="h-full w-[min(12rem,72%)] rounded-none"
          />
        ) : (
          <p
            key={detailKey ?? "detail"}
            className="h-[14px] min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground"
          >
            {detail}
          </p>
        )}
      </AutoTransition>
    </div>
  );
}
function eventMetricDelta(current: number, comparison: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(comparison)) return null;
  if (comparison === 0) return null;
  return ((current - comparison) / comparison) * 100;
}
function EventMetricChangeRate({ value }: { value: number | null }) {
  if (value === null) return null;
  const ChangeIcon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none tabular-nums",
        value >= 0 ? "text-emerald-600" : "text-rose-600",
      )}
    >
      <ChangeIcon className="size-3.5" />
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}
function EventMetricComparisonDetail({
  locale,
  comparisonLabel,
  comparisonValue,
  formatValue = (value) => numberFormat(locale, value),
}: {
  locale: Locale;
  comparisonLabel: string;
  comparisonValue: number;
  formatValue?: (value: number) => string;
}) {
  return (
    <span className="min-w-0 truncate">
      {comparisonLabel}: {formatValue(comparisonValue)}
    </span>
  );
}
export const EventMetricGrid = memo(function EventMetricGrid({
  locale,
  labels,
  summary,
  comparisonSummary,
  comparisonLabel,
  includeShare,
  loading = false,
}: {
  locale: Locale;
  labels: EventPageCopy;
  summary: EventMetricSummary;
  comparisonSummary?: EventMetricSummary;
  comparisonLabel?: string;
  includeShare?: boolean;
  loading?: boolean;
}) {
  const average = numberFormat(
    locale,
    Number(summary.avgEventsPerSession || 0),
  );
  const share =
    includeShare && summary.shareOfAllEvents !== undefined
      ? percentFormat(locale, summary.shareOfAllEvents)
      : null;
  const comparisonDetails = comparisonSummary
    ? {
        events: (
          <EventMetricComparisonDetail
            locale={locale}
            comparisonLabel={comparisonLabel ?? "Comparison"}
            comparisonValue={comparisonSummary.events}
          />
        ),
        eventTypes: (
          <EventMetricComparisonDetail
            locale={locale}
            comparisonLabel={comparisonLabel ?? "Comparison"}
            comparisonValue={comparisonSummary.eventTypes}
          />
        ),
        sessions: (
          <EventMetricComparisonDetail
            locale={locale}
            comparisonLabel={comparisonLabel ?? "Comparison"}
            comparisonValue={comparisonSummary.sessions}
          />
        ),
        visitors: (
          <EventMetricComparisonDetail
            locale={locale}
            comparisonLabel={comparisonLabel ?? "Comparison"}
            comparisonValue={comparisonSummary.visitors}
          />
        ),
        average: (
          <EventMetricComparisonDetail
            locale={locale}
            comparisonLabel={comparisonLabel ?? "Comparison"}
            comparisonValue={comparisonSummary.avgEventsPerSession}
          />
        ),
      }
    : null;
  const comparisonChanges = comparisonSummary
    ? {
        events: eventMetricDelta(summary.events, comparisonSummary.events),
        eventTypes: eventMetricDelta(
          summary.eventTypes,
          comparisonSummary.eventTypes,
        ),
        visitors: eventMetricDelta(
          summary.visitors,
          comparisonSummary.visitors,
        ),
        average: eventMetricDelta(
          summary.avgEventsPerSession,
          comparisonSummary.avgEventsPerSession,
        ),
      }
    : null;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
          <EventMetricCell
            icon={RiPulseLine}
            label={labels.totalEvents}
            loading={loading}
            value={numberFormat(locale, summary.events)}
            comparisonChange={comparisonChanges?.events}
            detail={
              comparisonDetails?.events ??
              (share
                ? `${labels.shareOfAllEvents}: ${share}`
                : labels.detailSubtitle)
            }
            detailKey={
              comparisonSummary
                ? `comparison-events:${comparisonSummary.events}:${summary.events}`
                : "events-detail"
            }
          />
          <EventMetricCell
            icon={RiStackLine}
            label={labels.eventTypes}
            loading={loading}
            value={numberFormat(locale, summary.eventTypes)}
            comparisonChange={comparisonChanges?.eventTypes}
            detail={comparisonDetails?.eventTypes ?? labels.breakdownTitle}
            detailKey={
              comparisonSummary
                ? `comparison-event-types:${comparisonSummary.eventTypes}:${summary.eventTypes}`
                : "event-types-detail"
            }
          />
          <EventMetricCell
            icon={RiFileList3Line}
            label={labels.sessions}
            loading={loading}
            value={numberFormat(locale, summary.sessions)}
            comparisonChange={comparisonChanges?.average}
            detail={
              comparisonDetails?.average ??
              `${labels.avgEventsPerSession}: ${average}`
            }
            detailKey={
              comparisonSummary
                ? `comparison-average:${comparisonSummary.avgEventsPerSession}:${summary.avgEventsPerSession}`
                : "sessions-detail"
            }
          />
          <EventMetricCell
            icon={RiDatabase2Line}
            label={labels.visitors}
            loading={loading}
            value={numberFormat(locale, summary.visitors)}
            comparisonChange={comparisonChanges?.visitors}
            detail={comparisonDetails?.visitors ?? labels.recordsTitle}
            detailKey={
              comparisonSummary
                ? `comparison-visitors:${comparisonSummary.visitors}:${summary.visitors}`
                : "visitors-detail"
            }
          />
        </div>
      </CardContent>
    </Card>
  );
});
export const EventTrendStackedBarCard = memo(function EventTrendStackedBarCard({
  locale,
  labels,
  trend,
  comparisonTrend,
  comparisonWindow,
  window: timeWindow,
  title,
  loading,
  cumulativeLabel,
  currentPeriodLabel,
  comparisonLabel,
  onSelectEvent,
}: {
  locale: Locale;
  labels: EventPageCopy;
  trend:
    | EventsTrendData
    | { series: EventTrendSeries[]; data: EventsTrendData["data"] };
  comparisonTrend?:
    | EventsTrendData
    | { series: EventTrendSeries[]; data: EventsTrendData["data"] };
  comparisonWindow?: Pick<TimeWindow, "from" | "to">;
  window: TimeWindow;
  title: string;
  loading?: boolean;
  cumulativeLabel: string;
  currentPeriodLabel?: string;
  comparisonLabel?: string;
  onSelectEvent?: (eventName: string) => void;
}) {
  const comparisonSeries = useMemo(
    () =>
      comparisonTrend
        ? createEventTrendComparisonChartSeries(
            trend.series,
            comparisonTrend.series,
            labels.other,
          )
        : null,
    [comparisonTrend, labels.other, trend.series],
  );
  const defaultSeries = useMemo(
    () => createEventTrendChartSeries(trend.series, labels.other),
    [labels.other, trend.series],
  );
  const series = comparisonSeries?.current ?? defaultSeries;
  const chartData = useMemo(
    () => createEventTrendChartData(trend.data, series),
    [series, trend.data],
  );
  const comparisonChartData = useMemo(
    () =>
      comparisonTrend && comparisonSeries
        ? createEventTrendChartData(
            comparisonTrend.data,
            comparisonSeries.comparison,
          )
        : undefined,
    [comparisonSeries, comparisonTrend],
  );

  return (
    <Card className="overflow-visible">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <EventTrendBarChart
          data={chartData}
          series={series}
          locale={locale}
          from={timeWindow.from}
          to={timeWindow.to}
          interval={timeWindow.interval}
          timeZone={timeWindow.timeZone}
          loading={loading}
          emptyLabel={labels.empty}
          cumulativeLabel={cumulativeLabel}
          totalLabel={labels.totalEvents}
          currentPeriodLabel={currentPeriodLabel}
          comparisonData={comparisonChartData}
          comparisonSeries={comparisonSeries?.comparison}
          comparisonFrom={comparisonWindow?.from}
          comparisonTo={comparisonWindow?.to}
          comparisonLabel={comparisonLabel}
          onSelectEvent={onSelectEvent}
        />
      </CardContent>
    </Card>
  );
});
