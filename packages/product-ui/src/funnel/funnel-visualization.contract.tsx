import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { currentTotals } from "../showcase/site-profile";
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

// Sessions that reach each step of the docs-to-deploy journey. dropOffRate is
// the loss relative to the previous step, as the analytics API reports it.
const SHOWCASE_FUNNEL_TOTAL = Math.round(currentTotals.sessions * 0.12);
const SHOWCASE_FUNNEL_RATES = [1, 0.412, 0.127, 0.0624] as const;
const SHOWCASE_FUNNEL_LABELS = [
  ["visit", "Visited the docs"],
  ["guide", "Opened the deployment guide"],
  ["deploy", "Clicked Deploy to Cloudflare"],
  ["setup", "Viewed the setup checklist"],
] as const;
const SHOWCASE_FUNNEL_STEPS = SHOWCASE_FUNNEL_LABELS.map(
  ([id, label], index) => {
    const rate = SHOWCASE_FUNNEL_RATES[index] ?? 0;
    const previous = SHOWCASE_FUNNEL_RATES[index - 1];
    return {
      id,
      label,
      metrics: {
        conversionRate: rate,
        dropOffRate: previous ? 1 - rate / previous : 0,
      },
    };
  },
);

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
  {
    id: "funnel.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      state: "ready",
      locale: "en-US",
      labels: {
        overallConversion: "Overall conversion",
        converted: "converted sessions",
      },
      steps: SHOWCASE_FUNNEL_STEPS,
      summary: {
        overallConversionRate: SHOWCASE_FUNNEL_RATES.at(-1) ?? 0,
        convertedProgressions: Math.round(
          SHOWCASE_FUNNEL_TOTAL * (SHOWCASE_FUNNEL_RATES.at(-1) ?? 0),
        ),
        totalProgressions: SHOWCASE_FUNNEL_TOTAL,
      },
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
