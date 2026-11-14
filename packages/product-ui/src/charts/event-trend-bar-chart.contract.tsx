import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import {
  createEventTrendChartData,
  createEventTrendChartSeries,
  createEventTrendComparisonChartSeries,
  EventTrendBarChart,
  type EventTrendBarChartProps,
} from "./event-trend-bar-chart";
import type { EventTrendSeries } from "./types";

const EVENT_NAMES = [
  "signup_click",
  "checkout_start",
  "newsletter_subscribe",
  "docs_search",
] as const;

function eventTrend(
  names: ReadonlyArray<string>,
  dayCount: number,
  dayOffset: number,
  scale: number,
) {
  const rows = Array.from({ length: dayCount }, (_, day) => {
    const eventsBySeries: Record<string, number> = {};
    let totalEvents = 0;
    names.forEach((name, index) => {
      const value = Math.round(
        fixtureWave(day + dayOffset, 320 - index * 60, 70, index) * scale,
      );
      eventsBySeries[name] = value;
      totalEvents += value;
    });
    return {
      bucket: day,
      timestampMs: fixtureDay(day - (dayOffset > 0 ? dayCount : 0)),
      totalEvents,
      eventsBySeries,
    };
  });
  const series: EventTrendSeries[] = names.map((name) => {
    const events = rows.reduce(
      (total, row) => total + (row.eventsBySeries[name] ?? 0),
      0,
    );
    return {
      key: name,
      eventName: name,
      label: name,
      events,
      sessions: Math.round(events * 0.7),
      visitors: Math.round(events * 0.55),
    };
  });
  return { rows, series };
}

function currentProps(names: ReadonlyArray<string>, dayCount: number) {
  const { rows, series } = eventTrend(names, dayCount, 0, 1);
  const chartSeries = createEventTrendChartSeries(series, "Other");
  return {
    data: createEventTrendChartData(rows, chartSeries),
    series: chartSeries,
    from: fixtureDay(0),
    to: fixtureDay(dayCount - 1),
  };
}

function comparisonProps(names: ReadonlyArray<string>, dayCount: number) {
  const current = eventTrend(names, dayCount, 0, 1);
  const previous = eventTrend(names, dayCount, 3, 0.85);
  const { current: currentSeries, comparison } =
    createEventTrendComparisonChartSeries(
      current.series,
      previous.series,
      "Other",
    );
  return {
    data: createEventTrendChartData(current.rows, currentSeries),
    series: currentSeries,
    from: fixtureDay(0),
    to: fixtureDay(dayCount - 1),
    comparisonData: createEventTrendChartData(previous.rows, comparison),
    comparisonSeries: comparison,
    comparisonFrom: fixtureDay(-dayCount),
    comparisonTo: fixtureDay(-1),
    currentPeriodLabel: "Current period",
    comparisonLabel: "Previous period",
  };
}

const baseProps = {
  locale: "en-US",
  interval: "day",
  timeZone: "UTC",
  emptyLabel: "No events in this period.",
  cumulativeLabel: "Total events",
  totalLabel: "Total",
  className: "h-[320px]",
} as const satisfies Partial<EventTrendBarChartProps>;

export const eventTrendBarChartFixtures = [
  {
    id: "event-trend-bar-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      ...currentProps(EVENT_NAMES.slice(0, 3), 14),
    } satisfies EventTrendBarChartProps,
  },
  {
    id: "event-trend-bar-chart.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      ...currentProps(EVENT_NAMES.slice(0, 3), 14),
      loading: true,
    } satisfies EventTrendBarChartProps,
  },
  {
    id: "event-trend-bar-chart.state.empty",
    title: "No events",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...baseProps,
      data: [],
      series: [],
      from: fixtureDay(0),
      to: fixtureDay(13),
    } satisfies EventTrendBarChartProps,
  },
  {
    id: "event-trend-bar-chart.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      ...comparisonProps(EVENT_NAMES.slice(0, 3), 14),
    } satisfies EventTrendBarChartProps,
  },
  {
    id: "event-trend-bar-chart.showcase",
    title: "Showcase",
    description:
      "Thirty days of four custom events compared with the previous period.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      ...comparisonProps(EVENT_NAMES, 30),
    } satisfies EventTrendBarChartProps,
  },
] as const satisfies readonly ComponentFixture<EventTrendBarChartProps>[];

export const eventTrendBarChartContract =
  defineComponentContract<EventTrendBarChartProps>({
    id: "event-trend-bar-chart",
    title: "Event trend bar chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only stacked bar chart of custom events over time with a selectable legend.",
    fixtures: eventTrendBarChartFixtures,
    render: (props) => (
      <div className="w-full">
        <EventTrendBarChart {...props} />
      </div>
    ),
  });
