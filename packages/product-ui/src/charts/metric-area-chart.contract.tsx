import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  fixtureDay,
  fixtureWave,
  formatFixtureCount,
} from "./chart-fixture-data";
import {
  MetricAreaChart,
  type MetricAreaChartProps,
} from "./metric-area-chart";

function points(count: number, base: number, amplitude: number, phase: number) {
  return Array.from({ length: count }, (_, index) => ({
    timestampMs: fixtureDay(index),
    value: fixtureWave(index, base, amplitude, phase),
  }));
}

const baseProps = {
  color: "var(--color-chart-1)",
  locale: "en-US",
  timeZone: "UTC",
  interval: "day",
  label: "Visitors",
  formatValue: formatFixtureCount,
  animationKey: "metric-area-chart-fixture",
} as const satisfies Omit<MetricAreaChartProps, "points">;

export const metricAreaChartFixtures = [
  {
    id: "metric-area-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      points: points(14, 2600, 520, 0),
    } satisfies MetricAreaChartProps,
  },
  {
    id: "metric-area-chart.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      points: points(14, 2600, 520, 0),
      comparisonPoints: points(14, 2300, 460, 2),
      comparisonColor: "var(--color-chart-secondary-1)",
      comparisonLabel: "Previous period",
    } satisfies MetricAreaChartProps,
  },
  {
    id: "metric-area-chart.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: { ...baseProps, points: [] } satisfies MetricAreaChartProps,
  },
  {
    id: "metric-area-chart.showcase",
    title: "Showcase",
    description: "Thirty days of visitors compared with the previous period.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      points: points(30, 2800, 640, 1),
      comparisonPoints: points(30, 2450, 560, 3),
      comparisonColor: "var(--color-chart-secondary-1)",
      comparisonLabel: "Previous period",
    } satisfies MetricAreaChartProps,
  },
] as const satisfies readonly ComponentFixture<MetricAreaChartProps>[];

export const metricAreaChartContract =
  defineComponentContract<MetricAreaChartProps>({
    id: "metric-area-chart",
    title: "Metric area chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A compact props-only sparkline for one headline metric with optional period comparison.",
    fixtures: metricAreaChartFixtures,
    render: (props) => (
      <div className="h-24 w-full max-w-sm">
        <MetricAreaChart {...props} />
      </div>
    ),
  });
