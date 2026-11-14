import { memo, useMemo } from "react";
import {
  createEventMetricItems as createSharedEventMetricItems,
  EventTrendCard,
} from "@insightflare/product-ui/events";
import type { MetricSummaryItem } from "@insightflare/ui/metric-summary-grid";

import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  EventsTrendData,
  EventTrendSeries,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";

import { type EventMetricSummary, type EventPageCopy } from "./types";
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
  return createSharedEventMetricItems({
    labels,
    summary,
    comparisonSummary,
    comparisonLabel,
    includeShare,
    loading,
    formatNumber: (value) => numberFormat(locale, value),
    formatPercent: (value) => percentFormat(locale, value),
  });
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
  const cardLabels = useMemo(
    () => ({
      title,
      other: labels.other,
      empty: labels.empty,
      totalEvents: labels.totalEvents,
      cumulative: cumulativeLabel,
      currentPeriod: currentPeriodLabel,
    }),
    [
      cumulativeLabel,
      currentPeriodLabel,
      labels.empty,
      labels.other,
      labels.totalEvents,
      title,
    ],
  );

  return (
    <EventTrendCard
      locale={locale}
      labels={cardLabels}
      trend={trend}
      comparisonTrend={comparisonTrend}
      comparisonWindow={comparisonWindow}
      window={timeWindow}
      loading={loading}
      comparisonLabel={comparisonLabel}
      onSelectEvent={onSelectEvent}
    />
  );
});
