import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  currentDays,
  currentTotals,
  eventDays,
  previousDays,
  previousTotals,
  type ShowcaseTotals,
} from "../showcase/site-profile";
import {
  type EventMetricLabels,
  EventMetricsView,
  type EventMetricsViewProps,
} from "./event-metrics";

const labels = {
  totalEvents: "Total events",
  shareOfAllEvents: "Share of all events",
  detailSubtitle: "Custom events in the selected period",
  eventTypes: "Event types",
  breakdownTitle: "Event type breakdown",
  sessions: "Sessions",
  avgEventsPerSession: "Avg. events per session",
  visitors: "Visitors",
  recordsTitle: "Event records",
} as const satisfies EventMetricLabels;

const numberFormatter = new Intl.NumberFormat("en-US");
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

const baseProps = {
  labels,
  formatNumber: (value: number) => numberFormatter.format(value),
  formatPercent: (value: number) => percentFormatter.format(value),
} as const satisfies Pick<
  EventMetricsViewProps,
  "labels" | "formatNumber" | "formatPercent"
>;

const summary = {
  events: 18420,
  eventTypes: 12,
  sessions: 6310,
  visitors: 4875,
  avgEventsPerSession: 2.92,
  shareOfAllEvents: 0.184,
} as const;

const comparisonSummary = {
  events: 16105,
  eventTypes: 11,
  sessions: 5890,
  visitors: 4520,
  avgEventsPerSession: 2.73,
  shareOfAllEvents: 0.171,
} as const;

function showcaseSummary(
  days: typeof currentDays,
  totals: ShowcaseTotals,
  seed: number,
  eventTypes: number,
) {
  const events = eventDays(days, seed).reduce(
    (sum, day) => sum + day.totalEvents,
    0,
  );
  const sessions = Math.round(totals.sessions * 0.46);
  return {
    events,
    eventTypes,
    sessions,
    visitors: Math.round(totals.visitors * 0.38),
    avgEventsPerSession: Math.round((events / sessions) * 100) / 100,
    shareOfAllEvents:
      Math.round((events / (events + totals.views)) * 1000) / 1000,
  } as const;
}

const showcaseCurrent = showcaseSummary(currentDays, currentTotals, 71, 11);
const showcasePrevious = showcaseSummary(previousDays, previousTotals, 83, 10);

export const eventMetricsFixtures = [
  {
    id: "event-metrics.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: { ...baseProps, summary } satisfies EventMetricsViewProps,
  },
  {
    id: "event-metrics.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      summary,
      loading: true,
    } satisfies EventMetricsViewProps,
  },
  {
    id: "event-metrics.state.share",
    title: "With event share",
    presentation: { kind: "scenario", scenario: "share" },
    props: {
      ...baseProps,
      summary,
      includeShare: true,
    } satisfies EventMetricsViewProps,
  },
  {
    id: "event-metrics.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      summary,
      comparisonSummary,
      comparisonLabel: "Previous period",
    } satisfies EventMetricsViewProps,
  },
  {
    id: "event-metrics.showcase",
    title: "Showcase",
    description: "Headline event metrics with period comparison.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      summary: showcaseCurrent,
      comparisonSummary: showcasePrevious,
      comparisonLabel: "Previous period",
    } satisfies EventMetricsViewProps,
  },
] as const satisfies readonly ComponentFixture<EventMetricsViewProps>[];

export const eventMetricsContract =
  defineComponentContract<EventMetricsViewProps>({
    id: "event-metrics",
    title: "Event metrics",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only grid of headline custom-event metrics with optional period comparison.",
    fixtures: eventMetricsFixtures,
    render: (props) => <EventMetricsView {...props} />,
  });
