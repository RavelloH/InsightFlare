import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  StackedBreakdownBarChart,
  type StackedBreakdownBarChartProps,
  type StackedBreakdownBarRow,
  type StackedBreakdownBarSeries,
} from "./stacked-breakdown-bar-chart";

const SERIES: readonly StackedBreakdownBarSeries[] = [
  { key: "windows", label: "Windows", color: "var(--color-chart-1)" },
  { key: "macos", label: "macOS", color: "var(--color-chart-2)" },
  { key: "android", label: "Android", color: "var(--color-chart-3)" },
  { key: "ios", label: "iOS", color: "var(--color-chart-4)" },
];

const COMPARISON_SERIES: readonly StackedBreakdownBarSeries[] = SERIES.map(
  (item, index) => ({
    ...item,
    color: `var(--color-chart-secondary-${index + 1})`,
  }),
);

const ROWS: readonly StackedBreakdownBarRow[] = [
  {
    key: "chrome",
    label: "Chrome",
    values: { windows: 5120, macos: 1980, android: 3640, ios: 410 },
  },
  {
    key: "safari",
    label: "Safari",
    values: { windows: 0, macos: 2210, android: 0, ios: 3980 },
  },
  {
    key: "edge",
    label: "Edge",
    values: { windows: 1860, macos: 240, android: 120, ios: 60 },
  },
  {
    key: "firefox",
    label: "Firefox",
    values: { windows: 940, macos: 520, android: 180, ios: 0 },
  },
  {
    key: "samsung",
    label: "Samsung Internet",
    values: { windows: 0, macos: 0, android: 760, ios: 0 },
  },
];

const PREVIOUS_ROWS: readonly StackedBreakdownBarRow[] = ROWS.map((row) => ({
  ...row,
  values: Object.fromEntries(
    Object.entries(row.values).map(([key, value]) => [
      key,
      Math.round(value * 0.86),
    ]),
  ),
}));

const baseProps = {
  locale: "en-US",
  series: SERIES,
  className: "h-[320px]",
} as const satisfies Partial<StackedBreakdownBarChartProps>;

export const stackedBreakdownBarChartFixtures = [
  {
    id: "stacked-breakdown-bar-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      rows: ROWS,
    } satisfies StackedBreakdownBarChartProps,
  },
  {
    id: "stacked-breakdown-bar-chart.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: { ...baseProps, rows: [] } satisfies StackedBreakdownBarChartProps,
  },
  {
    id: "stacked-breakdown-bar-chart.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      rows: ROWS,
      comparisonRows: PREVIOUS_ROWS,
      comparisonSeries: COMPARISON_SERIES,
    } satisfies StackedBreakdownBarChartProps,
  },
  {
    id: "stacked-breakdown-bar-chart.showcase",
    title: "Showcase",
    description: "Browser share split by operating system.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      rows: ROWS,
      comparisonRows: PREVIOUS_ROWS,
      comparisonSeries: COMPARISON_SERIES,
    } satisfies StackedBreakdownBarChartProps,
  },
] as const satisfies readonly ComponentFixture<StackedBreakdownBarChartProps>[];

export const stackedBreakdownBarChartContract =
  defineComponentContract<StackedBreakdownBarChartProps>({
    id: "stacked-breakdown-bar-chart",
    title: "Stacked breakdown bar chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only stacked bar chart that splits each category into a second dimension.",
    fixtures: stackedBreakdownBarChartFixtures,
    render: (props) => (
      <div className="w-full">
        <StackedBreakdownBarChart {...props} />
      </div>
    ),
  });
