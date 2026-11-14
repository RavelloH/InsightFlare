import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { DonutChart } from "./donut-chart";

export interface DonutChartContractProps {
  locale: string;
  comparison: boolean;
  scenario?: "default" | "showcase";
}

const DEFAULT_SOURCES = [
  {
    key: "search",
    label: "Search",
    value: 420,
    share: 42,
    color: "var(--color-chart-1)",
  },
  {
    key: "direct",
    label: "Direct",
    value: 310,
    share: 31,
    color: "var(--color-chart-2)",
  },
  {
    key: "social",
    label: "Social",
    value: 270,
    share: 27,
    color: "var(--color-chart-3)",
  },
];

const SHOWCASE_SOURCES = [
  {
    key: "search",
    label: "Search",
    value: 14_820,
    share: 38,
    color: "var(--color-chart-1)",
  },
  {
    key: "direct",
    label: "Direct",
    value: 10_290,
    share: 26,
    color: "var(--color-chart-2)",
  },
  {
    key: "social",
    label: "Social",
    value: 6_740,
    share: 17,
    color: "var(--color-chart-3)",
  },
  {
    key: "referral",
    label: "Referral",
    value: 4_130,
    share: 11,
    color: "var(--color-chart-4)",
  },
  {
    key: "email",
    label: "Email",
    value: 2_980,
    share: 8,
    color: "var(--color-chart-5)",
  },
];

const COMPARISON_COLORS = [
  "var(--color-chart-secondary-1)",
  "var(--color-chart-secondary-2)",
  "var(--color-chart-secondary-3)",
  "var(--color-chart-secondary-4)",
  "var(--color-chart-secondary-5)",
];

export const donutChartFixtures = [
  {
    id: "donut-chart.default",
    title: "Donut chart",
    props: { locale: "en-US", comparison: false },
  },
  {
    id: "donut-chart.showcase",
    title: "Showcase",
    description: "Five traffic channels compared with the previous period.",
    props: { locale: "en-US", comparison: true, scenario: "showcase" },
  },
] as const satisfies readonly ComponentFixture<DonutChartContractProps>[];

export const donutChartContract =
  defineComponentContract<DonutChartContractProps>({
    id: "donut-chart",
    title: "Donut chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: donutChartFixtures,
    render: ({ locale, comparison, scenario = "default" }) => {
      const sources =
        scenario === "showcase" ? SHOWCASE_SOURCES : DEFAULT_SOURCES;

      return createElement(
        "div",
        { className: "mx-auto w-full max-w-sm" },
        createElement(DonutChart, {
          data: sources,
          ...(comparison
            ? {
                comparisonData: sources.map((point, index) => ({
                  ...point,
                  value: Math.round(point.value * 0.82),
                  color: COMPARISON_COLORS[index % COMPARISON_COLORS.length]!,
                })),
              }
            : {}),
          locale,
          valueLabel: "visitors",
        }),
      );
    },
  });
