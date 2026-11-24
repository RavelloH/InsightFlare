import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { ChangeQuadrantChart } from "./change-quadrant-chart";

export interface ChangeQuadrantChartContractProps {
  locale: string;
  scenario?: "default" | "showcase" | "empty";
}

const SHOWCASE = [
  { id: "news", label: "News Portal", value: 227_000, change: -12.4 },
  { id: "shop", label: "E-Commerce Store", value: 264_000, change: 4.1 },
  { id: "docs", label: "API Documentation", value: 36_700, change: -41.8 },
  { id: "blog", label: "Personal Blog", value: 19_500, change: 63.2 },
  { id: "forum", label: "Community Forum", value: 116_000, change: 8.7 },
  { id: "edu", label: "Education Platform", value: 109_000, change: -2.3 },
  { id: "saas", label: "SaaS Dashboard", value: 70_400, change: 35.5 },
  { id: "folio", label: "Portfolio Site", value: 17_400, change: -6.1 },
];

export const changeQuadrantChartFixtures = [
  {
    id: "change-quadrant-chart.default",
    title: "Change quadrant chart",
    props: { locale: "en-US" },
  },
  {
    id: "change-quadrant-chart.showcase",
    title: "Showcase",
    description: "Eight sites by size and change, with rises and drops.",
    props: { locale: "en-US", scenario: "showcase" },
  },
  {
    id: "change-quadrant-chart.empty",
    title: "Empty",
    props: { locale: "en-US", scenario: "empty" },
  },
] as const satisfies readonly ComponentFixture<ChangeQuadrantChartContractProps>[];

export const changeQuadrantChartContract =
  defineComponentContract<ChangeQuadrantChartContractProps>({
    id: "change-quadrant-chart",
    title: "Change quadrant chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: changeQuadrantChartFixtures,
    render: ({ locale, scenario = "default" }) =>
      createElement(
        "div",
        { className: "w-full max-w-md" },
        createElement(ChangeQuadrantChart, {
          points:
            scenario === "empty"
              ? []
              : (scenario === "showcase" ? SHOWCASE : SHOWCASE.slice(0, 4)).map(
                  (point) => ({ ...point, weight: point.value * 2.3 }),
                ),
          labels: { value: "Visitors", change: "Change", weight: "Views" },
          locale,
          emptyLabel: "No data for this period",
        }),
      ),
  });
