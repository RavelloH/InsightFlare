import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  createShowcaseRng,
  currentDays,
  gaussian,
  previousDays,
  type ShowcaseDay,
} from "../showcase/site-profile";
import {
  type GoalTimeseriesChartPoint,
  type GoalTimeseriesMetric,
  GoalTimeseriesView,
  type GoalTimeseriesViewProps,
} from "./goal-timeseries-view";

const START_MS = Date.UTC(2026, 6, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const POINT_COUNT = 14;

function metric(total: number, rate: number): GoalTimeseriesMetric {
  const converted = Math.min(total, Math.round(total * rate));
  return { converted, rate: total > 0 ? converted / total : 0, total };
}

function points(
  baseVisitors: number,
  baseSessions: number,
  visitorRate: number,
  sessionRate: number,
  phase: number,
): GoalTimeseriesChartPoint[] {
  return Array.from({ length: POINT_COUNT }, (_, index) => {
    const wave = Math.sin((index + phase) * 0.8);
    const visitors = metric(
      Math.round(baseVisitors + wave * 40),
      visitorRate + wave * 0.018 + index * 0.0012,
    );
    const sessions = metric(
      Math.round(baseSessions + wave * 52),
      sessionRate + wave * 0.014 + index * 0.001,
    );
    return {
      timestampMs: START_MS + index * DAY_MS,
      visitors,
      visitorsRate: visitors.rate,
      sessions,
      sessionsRate: sessions.rate,
    };
  });
}

function emptyPoints(): GoalTimeseriesChartPoint[] {
  const zero = { converted: 0, rate: 0, total: 0 };
  return Array.from({ length: POINT_COUNT }, (_, index) => ({
    timestampMs: START_MS + index * DAY_MS,
    visitors: zero,
    visitorsRate: 0,
    sessions: zero,
    sessionsRate: 0,
  }));
}

function withComparison(
  current: readonly GoalTimeseriesChartPoint[],
  previous: readonly GoalTimeseriesChartPoint[],
): GoalTimeseriesChartPoint[] {
  return current.map((point, index) => ({
    ...point,
    comparisonVisitors: previous[index]?.visitors,
    comparisonVisitorsRate: previous[index]?.visitorsRate,
    comparisonSessions: previous[index]?.sessions,
    comparisonSessionsRate: previous[index]?.sessionsRate,
  }));
}

// Daily conversion follows the traffic: calmer weekends convert a little
// worse, and curious launch-day visitors convert noticeably worse.
function showcasePoints(
  days: readonly ShowcaseDay[],
  seed: number,
  visitorRate: number,
  sessionRate: number,
): GoalTimeseriesChartPoint[] {
  const rng = createShowcaseRng(seed);
  return days.map((day) => {
    const quality =
      (day.boost > 1.3 ? 0.78 : 1) * Math.exp(gaussian(rng) * 0.06);
    const visitors = metric(day.visitors, visitorRate * quality);
    const sessions = metric(day.sessions, sessionRate * quality);
    return {
      timestampMs: day.timestampMs,
      visitors,
      visitorsRate: visitors.rate,
      sessions,
      sessionsRate: sessions.rate,
    };
  });
}

const showcaseCurrent = showcasePoints(currentDays, 311, 0.0921, 0.0654);
const showcasePrevious = showcasePoints(previousDays, 312, 0.0812, 0.0689);

const current = points(360, 470, 0.13, 0.17, 0);
const previous = points(330, 430, 0.115, 0.15, 2);

const baseProps = {
  labels: { visitors: "Visitors", sessions: "Sessions" },
  locale: "en-US",
  timeZone: "UTC",
  interval: "day",
} as const satisfies Omit<GoalTimeseriesViewProps, "data">;

export const goalTimeseriesFixtures = [
  {
    id: "goals.goal-timeseries.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      data: current,
    } satisfies GoalTimeseriesViewProps,
  },
  {
    id: "goals.goal-timeseries.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      loading: true,
      data: emptyPoints(),
    } satisfies GoalTimeseriesViewProps,
  },
  {
    id: "goals.goal-timeseries.with-comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...baseProps,
      hasComparison: true,
      comparisonLabel: "Previous period",
      data: withComparison(current, previous),
    } satisfies GoalTimeseriesViewProps,
  },
  {
    id: "goals.goal-timeseries.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      hasComparison: true,
      comparisonLabel: "Previous period",
      data: withComparison(showcaseCurrent, showcasePrevious),
    } satisfies GoalTimeseriesViewProps,
  },
] as const satisfies readonly ComponentFixture<GoalTimeseriesViewProps>[];

export const goalTimeseriesContract =
  defineComponentContract<GoalTimeseriesViewProps>({
    id: "goals.goal-timeseries",
    title: "Goal timeseries",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only conversion-rate area chart for visitors and sessions with optional period comparison.",
    fixtures: goalTimeseriesFixtures,
    render: (props) => <GoalTimeseriesView {...props} />,
  });
