import { memo, useMemo } from "react";
import {
  createEventTrendChartData,
  createEventTrendChartSeries,
  createEventTrendComparisonChartSeries,
  EventTrendBarChart,
} from "@insightflare/product-ui/charts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import type { MetricSummaryItem } from "@insightflare/ui/metric-summary-grid";
import {
  RiDatabase2Line,
  RiFileList3Line,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  EventsTrendData,
  EventTrendSeries,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";

import { type EventMetricSummary, type EventPageCopy } from "./types";
function eventMetricDelta(current: number, comparison: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(comparison)) return null;
  if (comparison === 0) return null;
  return ((current - comparison) / comparison) * 100;
}
export function createEventMetricItems({
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
}): MetricSummaryItem[] {
  const average = numberFormat(
    locale,
    Number(summary.avgEventsPerSession || 0),
  );
  const share =
    includeShare && summary.shareOfAllEvents !== undefined
      ? percentFormat(locale, summary.shareOfAllEvents)
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

  const comparisonDetail = (value: number) =>
    comparisonSummary
      ? `${comparisonLabel ?? "Comparison"}: ${numberFormat(locale, value)}`
      : undefined;
  const change = (value: number | null) =>
    value === null
      ? undefined
      : {
          value: `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`,
          direction: value >= 0 ? ("up" as const) : ("down" as const),
          tone: value >= 0 ? ("positive" as const) : ("negative" as const),
        };

  return [
    {
      id: "events",
      icon: <RiPulseLine />,
      label: labels.totalEvents,
      value: numberFormat(locale, summary.events),
      detail:
        comparisonDetail(comparisonSummary?.events ?? 0) ??
        (share
          ? `${labels.shareOfAllEvents}: ${share}`
          : labels.detailSubtitle),
      change: change(comparisonChanges?.events ?? null),
      loading,
    },
    {
      id: "event-types",
      icon: <RiStackLine />,
      label: labels.eventTypes,
      value: numberFormat(locale, summary.eventTypes),
      detail:
        comparisonDetail(comparisonSummary?.eventTypes ?? 0) ??
        labels.breakdownTitle,
      change: change(comparisonChanges?.eventTypes ?? null),
      loading,
    },
    {
      id: "sessions",
      icon: <RiFileList3Line />,
      label: labels.sessions,
      value: numberFormat(locale, summary.sessions),
      detail:
        comparisonDetail(comparisonSummary?.avgEventsPerSession ?? 0) ??
        `${labels.avgEventsPerSession}: ${average}`,
      change: change(comparisonChanges?.average ?? null),
      loading,
    },
    {
      id: "visitors",
      icon: <RiDatabase2Line />,
      label: labels.visitors,
      value: numberFormat(locale, summary.visitors),
      detail:
        comparisonDetail(comparisonSummary?.visitors ?? 0) ??
        labels.recordsTitle,
      change: change(comparisonChanges?.visitors ?? null),
      loading,
    },
  ];
}
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
