import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import { TrafficPairBarChart } from "./traffic-pair-bar-chart";

export interface TrafficPairBarChartContractProps {
  locale: string;
  comparison: boolean;
  scenario?: "default" | "showcase";
}

function defaultTraffic() {
  return [
    { timestampMs: 1_728_000_000_000, views: 128, visitors: 84 },
    { timestampMs: 1_728_086_400_000, views: 176, visitors: 112 },
    { timestampMs: 1_728_172_800_000, views: 142, visitors: 96 },
    { timestampMs: 1_728_259_200_000, views: 214, visitors: 151 },
    { timestampMs: 1_728_345_600_000, views: 189, visitors: 130 },
  ];
}

function showcaseTraffic() {
  return Array.from({ length: 30 }, (_, day) => {
    const visitors = fixtureWave(day, 2400, 520, 0);
    return {
      timestampMs: fixtureDay(day),
      visitors,
      views: Math.round(visitors * 2.35),
    };
  });
}

export const trafficPairBarChartFixtures = [
  {
    id: "traffic-pair-bar-chart.default",
    title: "Traffic pair bar chart",
    props: { locale: "en-US", comparison: false },
  },
  {
    id: "traffic-pair-bar-chart.showcase",
    title: "Showcase",
    description: "Thirty days of views and visitors with a previous period.",
    props: { locale: "en-US", comparison: true, scenario: "showcase" },
  },
] as const satisfies readonly ComponentFixture<TrafficPairBarChartContractProps>[];

export const trafficPairBarChartContract =
  defineComponentContract<TrafficPairBarChartContractProps>({
    id: "traffic-pair-bar-chart",
    title: "Traffic pair bar chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: trafficPairBarChartFixtures,
    render: ({ locale, comparison, scenario = "default" }) => {
      const traffic =
        scenario === "showcase" ? showcaseTraffic() : defaultTraffic();

      return createElement(
        "div",
        { className: "w-full" },
        createElement(TrafficPairBarChart, {
          data: traffic,
          ...(comparison
            ? {
                comparisonData: traffic.map((point) => ({
                  ...point,
                  views: point.views * 0.8,
                  visitors: point.visitors * 0.85,
                })),
              }
            : {}),
          locale,
          timeZone: "UTC",
          interval: "day",
          viewsLabel: "Views",
          visitorsLabel: "Visitors",
          dataIsComplete: true,
          range: {
            from: traffic[0]!.timestampMs,
            to: traffic.at(-1)!.timestampMs,
          },
        }),
      );
    },
  });
