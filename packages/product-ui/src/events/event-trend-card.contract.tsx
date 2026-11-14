import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  currentDays,
  eventDays,
  previousDays,
  SHOWCASE_DAY_MS,
  SHOWCASE_DAYS,
  SHOWCASE_EVENT_TYPES,
  SHOWCASE_START_MS,
} from "../showcase/site-profile";
import {
  EventTrendCard,
  type EventTrendCardLabels,
  type EventTrendCardProps,
  type EventTrendCardTrend,
} from "./event-trend-card";

const START_MS = Date.UTC(2026, 6, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const POINT_COUNT = 14;

const labels = {
  title: "Event trend",
  other: "Other",
  empty: "No events in this period",
  totalEvents: "Total events",
  cumulative: "Cumulative events",
  currentPeriod: "Current period",
} as const satisfies EventTrendCardLabels;

const SERIES = [
  {
    key: "signup_click",
    eventName: "signup_click",
    label: "signup_click",
    base: 140,
    amplitude: 40,
  },
  {
    key: "pricing_view",
    eventName: "pricing_view",
    label: "pricing_view",
    base: 95,
    amplitude: 25,
  },
  {
    key: "download",
    eventName: "download",
    label: "download",
    base: 60,
    amplitude: 18,
  },
  {
    key: "__other",
    eventName: "__other",
    label: "Other",
    base: 35,
    amplitude: 10,
    isOther: true,
  },
] as const;

function buildTrend(scale: number, phase: number): EventTrendCardTrend {
  const data = Array.from({ length: POINT_COUNT }, (_, index) => {
    const eventsBySeries: Record<string, number> = {};
    let total = 0;
    for (const item of SERIES) {
      const value = Math.max(
        0,
        Math.round(
          (item.base + Math.sin((index + phase) * 0.8) * item.amplitude) *
            scale,
        ),
      );
      eventsBySeries[item.key] = value;
      total += value;
    }
    return {
      bucket: index,
      timestampMs: START_MS + index * DAY_MS,
      totalEvents: total,
      eventsBySeries,
    };
  });
  const series = SERIES.map((item) => {
    const events = data.reduce(
      (sum, point) => sum + (point.eventsBySeries[item.key] ?? 0),
      0,
    );
    return {
      key: item.key,
      eventName: item.eventName,
      label: item.label,
      events,
      sessions: Math.round(events * 0.62),
      visitors: Math.round(events * 0.48),
      ...("isOther" in item ? { isOther: true } : {}),
    };
  });
  return { series, data };
}

function showcaseTrend(
  days: typeof currentDays,
  seed: number,
): EventTrendCardTrend {
  const data = eventDays(days, seed).map((day, index) => ({
    bucket: index,
    ...day,
  }));
  const sum = (key: string) =>
    data.reduce((total, point) => total + (point.eventsBySeries[key] ?? 0), 0);
  const series = [
    ...SHOWCASE_EVENT_TYPES.map((type) => {
      const events = sum(type.key);
      return {
        key: type.key,
        eventName: type.key,
        label: type.label,
        events,
        sessions: Math.round(events * type.sessionRatio),
        visitors: Math.round(events * type.visitorRatio),
      };
    }),
    (() => {
      const events = sum("__other");
      return {
        key: "__other",
        eventName: "__other",
        label: "Other",
        events,
        sessions: Math.round(events * 0.8),
        visitors: Math.round(events * 0.7),
        isOther: true,
      };
    })(),
  ];
  return { series, data };
}

const showcaseCurrent = showcaseTrend(currentDays, 71);
const showcasePrevious = showcaseTrend(previousDays, 83);

const trend = buildTrend(1, 0);
const comparisonTrend = buildTrend(0.86, 2);

const baseProps = {
  locale: "en-US",
  labels,
  window: {
    from: START_MS,
    to: START_MS + (POINT_COUNT - 1) * DAY_MS,
    interval: "day",
    timeZone: "UTC",
  },
} as const satisfies Pick<EventTrendCardProps, "locale" | "labels" | "window">;

export const eventTrendCardFixtures = [
  {
    id: "event-trend-card.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: { ...baseProps, trend } satisfies EventTrendCardProps,
  },
  {
    id: "event-trend-card.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      trend,
      loading: true,
    } satisfies EventTrendCardProps,
  },
  {
    id: "event-trend-card.state.empty",
    title: "Empty",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...baseProps,
      trend: { series: [], data: [] },
    } satisfies EventTrendCardProps,
  },
  {
    id: "event-trend-card.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      trend,
      comparisonTrend,
      comparisonWindow: {
        from: START_MS - POINT_COUNT * DAY_MS,
        to: START_MS - DAY_MS,
      },
      comparisonLabel: "Previous period",
    } satisfies EventTrendCardProps,
  },
  {
    id: "event-trend-card.showcase",
    title: "Showcase",
    description: "Stacked daily event trend with period comparison.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      window: {
        from: SHOWCASE_START_MS,
        to: SHOWCASE_START_MS + (SHOWCASE_DAYS - 1) * SHOWCASE_DAY_MS,
        interval: "day",
        timeZone: "UTC",
      },
      trend: showcaseCurrent,
      comparisonTrend: showcasePrevious,
      comparisonWindow: {
        from: SHOWCASE_START_MS - SHOWCASE_DAYS * SHOWCASE_DAY_MS,
        to: SHOWCASE_START_MS - SHOWCASE_DAY_MS,
      },
      comparisonLabel: "Previous period",
    } satisfies EventTrendCardProps,
  },
] as const satisfies readonly ComponentFixture<EventTrendCardProps>[];

export const eventTrendCardContract =
  defineComponentContract<EventTrendCardProps>({
    id: "event-trend-card",
    title: "Event trend card",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only stacked bar trend of custom events with period comparison.",
    fixtures: eventTrendCardFixtures,
    render: (props) => <EventTrendCard {...props} />,
  });
