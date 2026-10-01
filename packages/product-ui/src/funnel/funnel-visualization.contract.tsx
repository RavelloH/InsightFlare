import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  FunnelVisualization,
  type FunnelVisualizationProps,
} from "./funnel-visualization";

export type FunnelVisualizationFixture =
  ComponentFixture<FunnelVisualizationProps>;
export type FunnelVisualizationContract = ReturnType<
  typeof defineComponentContract<FunnelVisualizationProps>
>;

const labels = {
  overallConversion: "Overall conversion",
  converted: "converted sessions",
} as const;

const steps = [
  {
    id: "landing",
    label: "Visited a landing page",
    metrics: {
      conversionRate: 1,
      dropOffRate: 0.39,
    },
  },
  {
    id: "pricing",
    label: "Viewed pricing",
    metrics: {
      conversionRate: 0.61,
      dropOffRate: 0.555,
    },
  },
  {
    id: "signup",
    label: "Started a trial",
    metrics: {
      conversionRate: 0.272,
      dropOffRate: 0.356,
    },
  },
] as const;

const summary = {
  overallConversionRate: 0.143,
  convertedProgressions: 343,
  totalProgressions: 2400,
} as const;

export const funnelVisualizationFixtures = [
  {
    id: "funnel.state.with-comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      state: "ready",
      locale: "en-US",
      labels,
      steps,
      summary,
      comparison: {
        state: "ready",
        summary: {
          overallConversionRate: 0.12,
          convertedProgressions: 288,
          totalProgressions: 2400,
        },
        steps: [
          {
            ...steps[0],
            metrics: { ...steps[0].metrics, conversionRate: 1 },
          },
          {
            ...steps[1],
            metrics: { ...steps[1].metrics, conversionRate: 0.58 },
          },
          {
            ...steps[2],
            metrics: { ...steps[2].metrics, conversionRate: 0.24 },
          },
        ],
      },
    } satisfies FunnelVisualizationProps,
  },
  {
    id: "funnel.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      state: "ready",
      locale: "en-US",
      labels,
      steps,
      summary,
    } satisfies FunnelVisualizationProps,
  },
  {
    id: "funnel.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      state: "loading",
      locale: "en-US",
      labels,
      steps: steps.map(({ id, label }) => ({ id, label })),
      comparison: { state: "loading" },
    } satisfies FunnelVisualizationProps,
  },
] as const satisfies readonly FunnelVisualizationFixture[];

export const funnelVisualizationContract: FunnelVisualizationContract =
  defineComponentContract<FunnelVisualizationProps>({
    id: "funnel",
    title: "Funnel visualization",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only conversion funnel with step metrics and period comparison.",
    fixtures: funnelVisualizationFixtures,
    render: (props) => <FunnelVisualization {...props} />,
  });
