import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  createShowcaseRng,
  currentDays,
  gaussian,
  type ShowcaseDay,
} from "../showcase/site-profile";
import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import {
  PerformanceTrendChart,
  type PerformanceTrendChartPoint,
  type PerformanceTrendChartProps,
  type PerformanceTrendMetricThresholds,
} from "./performance-trend-chart";

const THRESHOLDS: PerformanceTrendMetricThresholds = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};

function lcpPoints(
  dayCount: number,
  base: number,
  phase: number,
): PerformanceTrendChartPoint[] {
  return Array.from({ length: dayCount }, (_, day) => {
    const p50 = fixtureWave(day, base, 160, phase);
    return {
      timestampMs: fixtureDay(day),
      p50,
      p75: Math.round(p50 * 1.35),
      p95: Math.round(p50 * 2.1),
      avg: Math.round(p50 * 1.2),
      samples: fixtureWave(day, 640, 90, phase),
    };
  });
}

// LCP slows down under launch-day load, which pushes the 75th percentile past
// the "good" threshold for a few days before it recovers.
function showcaseLcpPoints(
  days: readonly ShowcaseDay[],
  seed: number,
  baseMedian: number,
): PerformanceTrendChartPoint[] {
  const rng = createShowcaseRng(seed);
  return days.map((day) => {
    const loaded = 1 + (day.boost - 1) * 0.28;
    const median = Math.round(
      baseMedian * loaded * Math.exp(gaussian(rng) * 0.05),
    );
    return {
      timestampMs: day.timestampMs,
      p50: median,
      p75: Math.round(median * (1.42 + (rng() - 0.5) * 0.08)),
      p95: Math.round(median * (2.75 + (rng() - 0.5) * 0.4)),
      avg: Math.round(median * (1.26 + (rng() - 0.5) * 0.06)),
      samples: Math.round(day.sessions * 0.55 * Math.exp(gaussian(rng) * 0.06)),
    };
  });
}

const formatMilliseconds = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : `${new Intl.NumberFormat("en-US").format(Math.round(value))} ms`;

function windowFor(dayCount: number) {
  return {
    from: fixtureDay(0),
    to: fixtureDay(dayCount - 1),
    interval: "day",
    timeZone: "UTC",
  } as const;
}

const baseProps = {
  locale: "en-US",
  activePanel: "lcp",
  labels: { p50: "Median", p75: "75th percentile", p95: "95th percentile" },
  metricThresholds: THRESHOLDS,
  formatValue: formatMilliseconds,
  className: "h-[280px]",
} as const satisfies Partial<PerformanceTrendChartProps>;

export const performanceTrendChartFixtures = [
  {
    id: "performance-trend-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      dataWindow: windowFor(14),
      points: lcpPoints(14, 2300, 0),
    } satisfies PerformanceTrendChartProps,
  },
  {
    id: "performance-trend-chart.state.empty",
    title: "No samples",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...baseProps,
      dataWindow: windowFor(14),
      points: [],
    } satisfies PerformanceTrendChartProps,
  },
  {
    id: "performance-trend-chart.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      dataWindow: windowFor(14),
      points: lcpPoints(14, 2300, 0),
      comparisonPoints: lcpPoints(14, 2650, 2),
      comparisonLabel: "Previous period",
    } satisfies PerformanceTrendChartProps,
  },
  {
    id: "performance-trend-chart.showcase",
    title: "Showcase",
    description: "Thirty days of Largest Contentful Paint percentiles.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      dataWindow: windowFor(30),
      points: showcaseLcpPoints(currentDays, 905, 1480),
    } satisfies PerformanceTrendChartProps,
  },
] as const satisfies readonly ComponentFixture<PerformanceTrendChartProps>[];

export const performanceTrendChartContract =
  defineComponentContract<PerformanceTrendChartProps>({
    id: "performance-trend-chart",
    title: "Performance trend chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only percentile chart for one Web Vitals metric with good and poor thresholds.",
    fixtures: performanceTrendChartFixtures,
    render: (props) => (
      <div className="w-full">
        <PerformanceTrendChart {...props} />
      </div>
    ),
  });
