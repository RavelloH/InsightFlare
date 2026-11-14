import {
  MetricSummaryGrid,
  type MetricSummaryItem,
} from "@insightflare/ui/metric-summary-grid";
import {
  RiDatabase2Line,
  RiFileList3Line,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

export interface EventMetricLabels {
  readonly totalEvents: string;
  readonly shareOfAllEvents: string;
  readonly detailSubtitle: string;
  readonly eventTypes: string;
  readonly breakdownTitle: string;
  readonly sessions: string;
  readonly avgEventsPerSession: string;
  readonly visitors: string;
  readonly recordsTitle: string;
}

export interface EventMetricSummary {
  readonly events: number;
  readonly eventTypes: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly avgEventsPerSession: number;
  readonly shareOfAllEvents?: number;
}

export interface CreateEventMetricItemsOptions {
  readonly labels: EventMetricLabels;
  readonly summary: EventMetricSummary;
  readonly comparisonSummary?: EventMetricSummary;
  readonly comparisonLabel?: string;
  readonly includeShare?: boolean;
  readonly loading?: boolean;
  readonly formatNumber: (value: number) => string;
  readonly formatPercent: (value: number) => string;
}

export type EventMetricsViewProps = CreateEventMetricItemsOptions;

function eventMetricDelta(current: number, comparison: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(comparison)) return null;
  if (comparison === 0) return null;
  return ((current - comparison) / comparison) * 100;
}

export function createEventMetricItems({
  labels,
  summary,
  comparisonSummary,
  comparisonLabel,
  includeShare,
  loading = false,
  formatNumber,
  formatPercent,
}: CreateEventMetricItemsOptions): MetricSummaryItem[] {
  const average = formatNumber(Number(summary.avgEventsPerSession || 0));
  const share =
    includeShare && summary.shareOfAllEvents !== undefined
      ? formatPercent(summary.shareOfAllEvents)
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
      ? `${comparisonLabel ?? "Comparison"}: ${formatNumber(value)}`
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
      value: formatNumber(summary.events),
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
      value: formatNumber(summary.eventTypes),
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
      value: formatNumber(summary.sessions),
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
      value: formatNumber(summary.visitors),
      detail:
        comparisonDetail(comparisonSummary?.visitors ?? 0) ??
        labels.recordsTitle,
      change: change(comparisonChanges?.visitors ?? null),
      loading,
    },
  ];
}

export function EventMetricsView(props: EventMetricsViewProps) {
  return <MetricSummaryGrid items={createEventMetricItems(props)} />;
}
