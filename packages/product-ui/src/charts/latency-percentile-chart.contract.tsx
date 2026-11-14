import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import {
  LatencyPercentileChart,
  type LatencyPercentileChartPoint,
  type LatencyPercentileChartProps,
} from "./latency-percentile-chart";

function latency(dayCount: number): LatencyPercentileChartPoint[] {
  return Array.from({ length: dayCount }, (_, day) => {
    const p50 = fixtureWave(day, 180, 30, 0);
    return {
      timestampMs: fixtureDay(day),
      p50,
      p75: Math.round(p50 * 1.6),
      p95: Math.round(p50 * 3.2),
    };
  });
}

const formatMilliseconds = (value: number | null) =>
  value === null ? "—" : `${Math.round(value)} ms`;

const baseProps = {
  labels: { p50: "p50", p75: "p75", p95: "p95" },
  locale: "en-US",
  timeZone: "UTC",
  formatValue: formatMilliseconds,
  loadingLabel: "Loading latency…",
  emptyLabel: "No latency samples yet.",
  className: "h-[260px]",
} as const satisfies Partial<LatencyPercentileChartProps>;

export const latencyPercentileChartFixtures = [
  {
    id: "latency-percentile-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      data: latency(14),
    } satisfies LatencyPercentileChartProps,
  },
  {
    id: "latency-percentile-chart.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      data: [],
      loading: true,
    } satisfies LatencyPercentileChartProps,
  },
  {
    id: "latency-percentile-chart.state.empty",
    title: "No samples",
    presentation: { kind: "scenario", scenario: "empty" },
    props: { ...baseProps, data: [] } satisfies LatencyPercentileChartProps,
  },
  {
    id: "latency-percentile-chart.showcase",
    title: "Showcase",
    description: "Thirty days of request latency percentiles.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      data: latency(30),
    } satisfies LatencyPercentileChartProps,
  },
] as const satisfies readonly ComponentFixture<LatencyPercentileChartProps>[];

export const latencyPercentileChartContract =
  defineComponentContract<LatencyPercentileChartProps>({
    id: "latency-percentile-chart",
    title: "Latency percentile chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only line chart of p50, p75 and p95 latency over time.",
    fixtures: latencyPercentileChartFixtures,
    render: (props) => (
      <div className="w-full">
        <LatencyPercentileChart {...props} />
      </div>
    ),
  });
