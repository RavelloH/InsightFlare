import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import { SitePulseHeatmap } from "./site-pulse-heatmap";

export interface SitePulseHeatmapContractProps {
  locale: string;
  scenario?: "default" | "showcase" | "empty";
}

const SITES = [
  { id: "news", label: "News Portal", base: 2400, amplitude: 420 },
  { id: "shop", label: "E-Commerce Store", base: 1800, amplitude: 300 },
  { id: "docs", label: "API Documentation", base: 900, amplitude: 140 },
  { id: "blog", label: "Personal Blog", base: 160, amplitude: 40 },
  { id: "forum", label: "Community Forum", base: 620, amplitude: 120 },
];

function buildRows(days: number) {
  return SITES.map((site, siteIndex) => ({
    id: site.id,
    label: site.label,
    highlighted: siteIndex === 0,
    values: Array.from({ length: days }, (_, day) => {
      const value = fixtureWave(day, site.base, site.amplitude, siteIndex);
      if (site.id === "docs" && day > days * 0.6) return Math.round(value / 3);
      if (site.id === "blog" && day === days - 6) return value * 5;
      if (site.id === "forum" && day === 3) return 0;
      return value;
    }),
  }));
}

export const sitePulseHeatmapFixtures = [
  {
    id: "site-pulse-heatmap.default",
    title: "Site pulse heatmap",
    props: { locale: "en-US" },
  },
  {
    id: "site-pulse-heatmap.showcase",
    title: "Showcase",
    description: "Thirty days across five sites with a drop and a spike.",
    props: { locale: "en-US", scenario: "showcase" },
  },
  {
    id: "site-pulse-heatmap.empty",
    title: "Empty",
    props: { locale: "en-US", scenario: "empty" },
  },
] as const satisfies readonly ComponentFixture<SitePulseHeatmapContractProps>[];

export const sitePulseHeatmapContract =
  defineComponentContract<SitePulseHeatmapContractProps>({
    id: "site-pulse-heatmap",
    title: "Site pulse heatmap",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: sitePulseHeatmapFixtures,
    render: ({ locale, scenario = "default" }) => {
      const days = scenario === "showcase" ? 30 : 14;
      return createElement(
        "div",
        { className: "w-full" },
        createElement(SitePulseHeatmap, {
          rows: scenario === "empty" ? [] : buildRows(days),
          bucketStarts: Array.from({ length: days }, (_, day) =>
            fixtureDay(day),
          ),
          locale,
          timeZone: "UTC",
          interval: "day",
          labels: {
            value: "Visitors",
            usual: "Usual",
            above: "Above usual",
            below: "Below usual",
            versusUsual: "{percent} vs usual",
          },
          emptyLabel: "No sites yet",
        }),
      );
    },
  });
