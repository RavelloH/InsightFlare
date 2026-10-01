import {
  type ComponentContract,
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import type { GoalVisualizationProps } from "./goal-visualization";
import { GoalVisualization } from "./goal-visualization";

export type GoalVisualizationFixture = ComponentFixture<GoalVisualizationProps>;
export type GoalVisualizationContract =
  ComponentContract<GoalVisualizationProps>;

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
