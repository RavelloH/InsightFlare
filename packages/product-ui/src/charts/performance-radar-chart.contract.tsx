import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  PerformanceRadarChart,
  type PerformanceRadarChartProps,
  type PerformanceRadarMetricLabels,
  type PerformanceRadarMetrics,
} from "./performance-radar-chart";

const LABELS: PerformanceRadarMetricLabels = {
  duration: "Duration",
  engagement: "Engagement",
  depth: "Depth",
  loyalty: "Loyalty",
  frequency: "Frequency",
  traffic: "Traffic",
};

const MAX_BY_METRIC: PerformanceRadarMetrics = {
  duration: 100,
  engagement: 100,
  depth: 100,
  loyalty: 100,
  frequency: 100,
  traffic: 100,
};

const CURRENT: PerformanceRadarMetrics = {
  duration: 72,
  engagement: 64,
  depth: 58,
  loyalty: 41,
  frequency: 35,
  traffic: 83,
};

const PREVIOUS: PerformanceRadarMetrics = {
  duration: 66,
  engagement: 60,
  depth: 49,
  loyalty: 44,
  frequency: 31,
  traffic: 70,
};

const baseProps = {
  itemLabel: "Chrome",
  metricLabels: LABELS,
  maxByMetric: MAX_BY_METRIC,
  color: "var(--color-chart-1)",
  locale: "en-US",
  className: "mx-auto h-[320px] max-w-md",
} as const satisfies Partial<PerformanceRadarChartProps>;

export const performanceRadarChartFixtures = [
  {
    id: "performance-radar-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      metrics: CURRENT,
    } satisfies PerformanceRadarChartProps,
  },
  {
    id: "performance-radar-chart.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      metrics: CURRENT,
      comparisonMetrics: PREVIOUS,
      comparisonColor: "var(--color-chart-secondary-1)",
      comparisonLabel: "Previous period",
    } satisfies PerformanceRadarChartProps,
  },
  {
    id: "performance-radar-chart.showcase",
    title: "Showcase",
    description:
      "Engagement profile of one browser against the previous period.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      metrics: CURRENT,
      comparisonMetrics: PREVIOUS,
      comparisonColor: "var(--color-chart-secondary-1)",
      comparisonLabel: "Previous period",
    } satisfies PerformanceRadarChartProps,
  },
] as const satisfies readonly ComponentFixture<PerformanceRadarChartProps>[];

export const performanceRadarChartContract =
  defineComponentContract<PerformanceRadarChartProps>({
    id: "performance-radar-chart",
    title: "Performance radar chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only radar chart comparing normalized engagement metrics for one item.",
    fixtures: performanceRadarChartFixtures,
    render: (props) => (
      <div className="w-full">
        <PerformanceRadarChart {...props} />
      </div>
    ),
  });
