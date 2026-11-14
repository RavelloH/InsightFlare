import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import {
  ShareTrendAreaChart,
  type ShareTrendAreaChartProps,
  type ShareTrendAreaPoint,
  type ShareTrendAreaSeries,
} from "./share-trend-area-chart";

const SERIES: readonly ShareTrendAreaSeries[] = [
  { key: "chrome", label: "Chrome", color: "var(--color-chart-1)" },
  { key: "safari", label: "Safari", color: "var(--color-chart-2)" },
  { key: "edge", label: "Edge", color: "var(--color-chart-3)" },
  { key: "firefox", label: "Firefox", color: "var(--color-chart-4)" },
  {
    key: "other",
    label: "Other",
    color: "var(--muted-foreground)",
    isOther: true,
  },
];

function shareTrend(dayCount: number): ShareTrendAreaPoint[] {
  return Array.from({ length: dayCount }, (_, day) => {
    const values: Record<string, number> = {
      chrome: fixtureWave(day, 1500, 140, 0),
      safari: fixtureWave(day, 820, 120, 1),
      edge: fixtureWave(day, 360, 60, 2),
      firefox: fixtureWave(day, 210, 40, 3),
      other: fixtureWave(day, 90, 20, 4),
    };
    const totalVisitors = Object.values(values).reduce(
      (total, value) => total + value,
      0,
    );
    return { timestampMs: fixtureDay(day), totalVisitors, values };
  });
}

const baseProps = {
  series: SERIES,
  locale: "en-US",
  timeZone: "UTC",
  interval: "day",
  showLegend: true,
  className: "h-[280px]",
} as const satisfies Partial<ShareTrendAreaChartProps>;

export const shareTrendAreaChartFixtures = [
  {
    id: "share-trend-area-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      data: shareTrend(14),
    } satisfies ShareTrendAreaChartProps,
  },
  {
    id: "share-trend-area-chart.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      data: shareTrend(14),
      loading: true,
    } satisfies ShareTrendAreaChartProps,
  },
  {
    id: "share-trend-area-chart.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: { ...baseProps, data: [] } satisfies ShareTrendAreaChartProps,
  },
  {
    id: "share-trend-area-chart.showcase",
    title: "Showcase",
    description: "Thirty days of browser share.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      data: shareTrend(30),
    } satisfies ShareTrendAreaChartProps,
  },
] as const satisfies readonly ComponentFixture<ShareTrendAreaChartProps>[];

export const shareTrendAreaChartContract =
  defineComponentContract<ShareTrendAreaChartProps>({
    id: "share-trend-area-chart",
    title: "Share trend area chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only stacked area chart showing how the share of each category changes over time.",
    fixtures: shareTrendAreaChartFixtures,
    render: (props) => (
      <div className="w-full">
        <ShareTrendAreaChart {...props} />
      </div>
    ),
  });
