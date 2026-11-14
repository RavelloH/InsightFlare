import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import type { MetricAreaPoint } from "../charts";
import {
  currentDays,
  currentTotals,
  percentChange,
  previousDays,
  previousTotals,
  type ShowcaseDay,
} from "../showcase/site-profile";
import {
  type OverviewMetricKey,
  type OverviewMetricsLabels,
  OverviewMetricsView,
  type OverviewMetricsViewItem,
  type OverviewMetricsViewProps,
} from "./overview-metrics-view";

const START_MS = Date.UTC(2026, 6, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const POINT_COUNT = 14;

function series(base: number, amplitude: number, phase: number) {
  return Array.from({ length: POINT_COUNT }, (_, index): MetricAreaPoint => {
    const wave = Math.sin((index + phase) * 0.9) * amplitude;
    const drift = index * (amplitude / POINT_COUNT);
    return {
      timestampMs: START_MS + index * DAY_MS,
      value: Math.max(0, Math.round((base + wave + drift) * 100) / 100),
    };
  });
}

const formatCount = (value: number) =>
  new Intl.NumberFormat("en-US").format(Math.round(value));
const formatPercent = (value: number) => `${value.toFixed(1)}%`;
const formatDuration = (value: number) => {
  const seconds = Math.max(0, Math.round(value / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const labels = {
  views: "Views",
  visitors: "Visitors",
  sessions: "Sessions",
  bounceRate: "Bounce rate",
  pagesPerSession: "Pages / session",
  avgDuration: "Avg. duration",
} as const satisfies OverviewMetricsLabels;

const TRENDS: Record<OverviewMetricKey, ReadonlyArray<MetricAreaPoint>> = {
  views: series(7200, 1400, 0),
  visitors: series(2600, 520, 1),
  sessions: series(3300, 640, 2),
  bounceRate: series(41, 6, 3),
  pagesPerSession: series(2.1, 0.5, 4),
  avgDuration: series(132000, 24000, 5),
};

const COMPARISON_TRENDS: Record<
  OverviewMetricKey,
  ReadonlyArray<MetricAreaPoint>
> = {
  views: series(6400, 1200, 2),
  visitors: series(2300, 460, 3),
  sessions: series(2900, 560, 4),
  bounceRate: series(44, 6, 5),
  pagesPerSession: series(1.9, 0.4, 6),
  avgDuration: series(118000, 22000, 7),
};

function items(withComparison: boolean): OverviewMetricsViewItem[] {
  const comparisonTrend = (key: OverviewMetricKey) =>
    withComparison ? COMPARISON_TRENDS[key] : undefined;
  return [
    {
      key: "views",
      value: "126,408",
      delta: 12.4,
      trend: TRENDS.views,
      comparisonTrend: comparisonTrend("views"),
      formatTrendValue: formatCount,
    },
    {
      key: "visitors",
      value: "38,214",
      delta: 8.1,
      trend: TRENDS.visitors,
      comparisonTrend: comparisonTrend("visitors"),
      formatTrendValue: formatCount,
    },
    {
      key: "sessions",
      value: "52,960",
      delta: 9.7,
      trend: TRENDS.sessions,
      comparisonTrend: comparisonTrend("sessions"),
      formatTrendValue: formatCount,
    },
    {
      key: "bounceRate",
      value: "41.3%",
      delta: -3.2,
      lowerIsBetter: true,
      trend: TRENDS.bounceRate,
      comparisonTrend: comparisonTrend("bounceRate"),
      formatTrendValue: formatPercent,
    },
    {
      key: "pagesPerSession",
      value: "2.39",
      delta: 4.6,
      trend: TRENDS.pagesPerSession,
      comparisonTrend: comparisonTrend("pagesPerSession"),
      formatTrendValue: (value) => value.toFixed(2),
    },
    {
      key: "avgDuration",
      value: "2m 14s",
      delta: 6.8,
      trend: TRENDS.avgDuration,
      comparisonTrend: comparisonTrend("avgDuration"),
      formatTrendValue: formatDuration,
    },
  ];
}

function dailyPoints(
  days: readonly ShowcaseDay[],
  pick: (day: ShowcaseDay) => number,
): MetricAreaPoint[] {
  return days.map((day) => ({
    timestampMs: day.timestampMs,
    value: pick(day),
  }));
}

function showcaseItems(): OverviewMetricsViewItem[] {
  const format = new Intl.NumberFormat("en-US");
  const cur = currentTotals;
  const prev = previousTotals;
  const pagesPerSession = (value: number) => value.toFixed(2);
  return [
    {
      key: "views",
      value: format.format(cur.views),
      delta: percentChange(cur.views, prev.views),
      trend: dailyPoints(currentDays, (day) => day.views),
      comparisonTrend: dailyPoints(previousDays, (day) => day.views),
      formatTrendValue: formatCount,
    },
    {
      key: "visitors",
      value: format.format(cur.visitors),
      delta: percentChange(cur.visitors, prev.visitors),
      trend: dailyPoints(currentDays, (day) => day.visitors),
      comparisonTrend: dailyPoints(previousDays, (day) => day.visitors),
      formatTrendValue: formatCount,
    },
    {
      key: "sessions",
      value: format.format(cur.sessions),
      delta: percentChange(cur.sessions, prev.sessions),
      trend: dailyPoints(currentDays, (day) => day.sessions),
      comparisonTrend: dailyPoints(previousDays, (day) => day.sessions),
      formatTrendValue: formatCount,
    },
    {
      key: "bounceRate",
      value: formatPercent(cur.bounceRate * 100),
      delta: percentChange(cur.bounceRate, prev.bounceRate),
      lowerIsBetter: true,
      trend: dailyPoints(currentDays, (day) => day.bounceRate * 100),
      comparisonTrend: dailyPoints(previousDays, (day) => day.bounceRate * 100),
      formatTrendValue: formatPercent,
    },
    {
      key: "pagesPerSession",
      value: pagesPerSession(cur.pagesPerSession),
      delta: percentChange(cur.pagesPerSession, prev.pagesPerSession),
      trend: dailyPoints(currentDays, (day) => day.views / day.sessions),
      comparisonTrend: dailyPoints(
        previousDays,
        (day) => day.views / day.sessions,
      ),
      formatTrendValue: pagesPerSession,
    },
    {
      key: "avgDuration",
      value: formatDuration(cur.avgDurationMs),
      delta: percentChange(cur.avgDurationMs, prev.avgDurationMs),
      trend: dailyPoints(currentDays, (day) => day.avgDurationMs),
      comparisonTrend: dailyPoints(previousDays, (day) => day.avgDurationMs),
      formatTrendValue: formatDuration,
    },
  ];
}

const baseProps = {
  labels,
  loading: false,
  locale: "en-US",
  timeZone: "UTC",
  interval: "day",
  animationKey: "overview-metrics-fixture",
} as const satisfies Omit<OverviewMetricsViewProps, "items">;

export const overviewMetricsFixtures = [
  {
    id: "overview-metrics.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      items: items(false),
    } satisfies OverviewMetricsViewProps,
  },
  {
    id: "overview-metrics.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      loading: true,
      items: items(false),
    } satisfies OverviewMetricsViewProps,
  },
  {
    id: "overview-metrics.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      comparisonLabel: "Previous period",
      items: items(true),
    } satisfies OverviewMetricsViewProps,
  },
  {
    id: "overview-metrics.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      comparisonLabel: "Previous period",
      items: showcaseItems(),
    } satisfies OverviewMetricsViewProps,
  },
] as const satisfies readonly ComponentFixture<OverviewMetricsViewProps>[];

export const overviewMetricsContract =
  defineComponentContract<OverviewMetricsViewProps>({
    id: "overview-metrics",
    title: "Overview metrics",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only grid of headline traffic metrics with trend sparklines and period comparison.",
    fixtures: overviewMetricsFixtures,
    render: (props) => <OverviewMetricsView {...props} />,
  });
