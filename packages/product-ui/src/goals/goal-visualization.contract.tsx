import {
  type ComponentContract,
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  currentTotals,
  percentChange,
  previousTotals,
} from "../showcase/site-profile";
import type { GoalVisualizationProps } from "./goal-visualization";
import { GoalVisualization } from "./goal-visualization";

export type GoalVisualizationFixture = ComponentFixture<GoalVisualizationProps>;
export type GoalVisualizationContract =
  ComponentContract<GoalVisualizationProps>;

const countFormat = new Intl.NumberFormat("en-US");
const percentText = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function changeText(current: number, previous: number) {
  const change = percentChange(current, previous) ?? 0;
  return {
    direction: change >= 0 ? ("up" as const) : ("down" as const),
    text: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
  };
}

// Conversion of the "Clicked Deploy to Cloudflare" goal over the same windows
// as the overview metrics.
function showcaseProps(): GoalVisualizationProps {
  const visitorRate = 0.0921;
  const previousVisitorRate = 0.0812;
  const sessionRate = 0.0654;
  const previousSessionRate = 0.0689;
  const visitorsConverted = Math.round(currentTotals.visitors * visitorRate);
  const sessionsConverted = Math.round(currentTotals.sessions * sessionRate);
  const previousVisitorsConverted = Math.round(
    previousTotals.visitors * previousVisitorRate,
  );
  const previousSessionsConverted = Math.round(
    previousTotals.sessions * previousSessionRate,
  );
  return {
    visitors: {
      label: "Visitors",
      conversionRate: percentText(visitorRate),
      convertedCount: countFormat.format(visitorsConverted),
      totalCount: countFormat.format(currentTotals.visitors),
      loading: false,
      transitionKey: `${visitorRate}:${visitorsConverted}:${currentTotals.visitors}`,
      comparison: {
        loading: false,
        transitionKey: `${previousVisitorRate}:${previousVisitorsConverted}`,
        change: changeText(visitorRate, previousVisitorRate),
      },
    },
    sessions: {
      label: "Sessions",
      conversionRate: percentText(sessionRate),
      convertedCount: countFormat.format(sessionsConverted),
      totalCount: countFormat.format(currentTotals.sessions),
      loading: false,
      transitionKey: `${sessionRate}:${sessionsConverted}:${currentTotals.sessions}`,
      comparison: {
        loading: false,
        transitionKey: `${previousSessionRate}:${previousSessionsConverted}`,
        change: changeText(sessionRate, previousSessionRate),
      },
    },
    visitorConversion: {
      label: "Visitors Conversion",
      value: visitorRate * 100,
      valueText: percentText(visitorRate),
      loading: false,
      transitionKey: String(visitorRate),
      comparison: {
        label: "Visitors Conversion comparison",
        value: previousVisitorRate * 100,
        valueText: percentText(previousVisitorRate),
        loading: false,
        transitionKey: String(previousVisitorRate),
      },
    },
  };
}

export const goalVisualizationFixtures = [
  {
    id: "goals.goal-visualization.ready",
    title: "Ready",
    description: "Visitor and session conversion without comparison data.",
    props: {
      visitors: {
        label: "Visitors",
        conversionRate: "12.5%",
        convertedCount: "125",
        totalCount: "1,000",
        loading: false,
        transitionKey: "0.125:125:1000",
        comparison: null,
      },
      sessions: {
        label: "Sessions",
        conversionRate: "18.4%",
        convertedCount: "184",
        totalCount: "1,000",
        loading: false,
        transitionKey: "0.184:184:1000",
        comparison: null,
      },
      visitorConversion: {
        label: "Visitors Conversion",
        value: 12.5,
        valueText: "12.5%",
        loading: false,
        transitionKey: "0.125",
        comparison: null,
      },
    } satisfies GoalVisualizationProps,
  },
  {
    id: "goals.goal-visualization.loading",
    title: "Loading",
    description: "Current values and comparison values are loading.",
    props: {
      visitors: {
        label: "Visitors",
        conversionRate: "0%",
        convertedCount: "0",
        totalCount: "0",
        loading: true,
        transitionKey: "loading",
        comparison: {
          loading: true,
          transitionKey: "comparison-loading",
          change: null,
        },
      },
      sessions: {
        label: "Sessions",
        conversionRate: "0%",
        convertedCount: "0",
        totalCount: "0",
        loading: true,
        transitionKey: "loading",
        comparison: {
          loading: true,
          transitionKey: "comparison-loading",
          change: null,
        },
      },
      visitorConversion: {
        label: "Visitors Conversion",
        value: 0,
        valueText: "0%",
        loading: true,
        transitionKey: "loading",
        comparison: {
          label: "Visitors Conversion comparison",
          value: 0,
          valueText: "0%",
          loading: true,
          transitionKey: "comparison-loading",
        },
      },
    } satisfies GoalVisualizationProps,
  },
  {
    id: "goals.goal-visualization.with-comparison",
    title: "With comparison",
    description: "Current conversion values with comparison indicators.",
    props: {
      visitors: {
        label: "Visitors",
        conversionRate: "12.5%",
        convertedCount: "125",
        totalCount: "1,000",
        loading: false,
        transitionKey: "0.125:125:1000",
        comparison: {
          loading: false,
          transitionKey: "0.1:100:1000",
          change: { direction: "up", text: "+25.0%" },
        },
      },
      sessions: {
        label: "Sessions",
        conversionRate: "18.4%",
        convertedCount: "184",
        totalCount: "1,000",
        loading: false,
        transitionKey: "0.184:184:1000",
        comparison: {
          loading: false,
          transitionKey: "0.2:200:1000",
          change: { direction: "down", text: "-8.0%" },
        },
      },
      visitorConversion: {
        label: "Visitors Conversion",
        value: 12.5,
        valueText: "12.5%",
        loading: false,
        transitionKey: "0.125",
        comparison: {
          label: "Visitors Conversion comparison",
          value: 10,
          valueText: "10%",
          loading: false,
          transitionKey: "0.1",
        },
      },
    } satisfies GoalVisualizationProps,
  },
  {
    id: "goals.goal-visualization.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: showcaseProps(),
  },
] as const satisfies readonly GoalVisualizationFixture[];

export const goalVisualizationContract: GoalVisualizationContract =
  defineComponentContract<GoalVisualizationProps>({
    id: "goals.goal-visualization",
    title: "Goal visualization",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: goalVisualizationFixtures,
    render: (props) => <GoalVisualization {...props} />,
  });
