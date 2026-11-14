import { memo, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiPulseLine } from "@remixicon/react";

import {
  type ChartTimeWindow,
  createEventTrendChartData,
  createEventTrendChartSeries,
  createEventTrendComparisonChartSeries,
  type EventsTrendData,
  EventTrendBarChart,
  type EventTrendSeries,
} from "../charts";

export interface EventTrendCardLabels {
  readonly title: string;
  readonly other: string;
  readonly empty: string;
  readonly totalEvents: string;
  readonly cumulative: string;
  readonly currentPeriod?: string;
}

export interface EventTrendCardTrend {
  readonly series: EventTrendSeries[];
  readonly data: EventsTrendData["data"];
}

export interface EventTrendCardProps {
  readonly locale: string;
  readonly labels: EventTrendCardLabels;
  readonly trend: EventTrendCardTrend;
  readonly comparisonTrend?: EventTrendCardTrend;
  readonly comparisonWindow?: Pick<ChartTimeWindow, "from" | "to">;
  readonly window: ChartTimeWindow;
  readonly loading?: boolean;
  readonly comparisonLabel?: string;
  /** Overrides the generated series colors, in series order. */
  readonly palette?: ReadonlyArray<string>;
  readonly onSelectEvent?: (eventName: string) => void;
}

export const EventTrendCard = memo(function EventTrendCard({
  locale,
  labels,
  trend,
  comparisonTrend,
  comparisonWindow,
  window: timeWindow,
  loading,
  comparisonLabel,
  palette,
  onSelectEvent,
}: EventTrendCardProps) {
  const comparisonSeries = useMemo(
    () =>
      comparisonTrend
        ? createEventTrendComparisonChartSeries(
            trend.series,
            comparisonTrend.series,
            labels.other,
            palette,
          )
        : null,
    [comparisonTrend, labels.other, palette, trend.series],
  );
  const defaultSeries = useMemo(
    () => createEventTrendChartSeries(trend.series, labels.other, palette),
    [labels.other, palette, trend.series],
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
            {labels.title}
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
          cumulativeLabel={labels.cumulative}
          totalLabel={labels.totalEvents}
          currentPeriodLabel={labels.currentPeriod}
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
