import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  SHOWCASE_DAY_MS,
  SHOWCASE_DAYS,
  SHOWCASE_START_MS,
  SHOWCASE_TEAM_SITES,
  teamTraffic,
} from "../showcase/site-profile";
import { fixtureDay, fixtureWave } from "./chart-fixture-data";
import {
  SiteTrafficStackChart,
  type SiteTrafficStackChartProps,
} from "./site-traffic-stack-chart";

const ALL_SITES = [
  { id: "site-news", name: "DailyPulse News" },
  { id: "site-store", name: "Orbit Store" },
  { id: "site-docs", name: "Docs Hub" },
  { id: "site-blog", name: "Field Notes" },
  { id: "site-app", name: "Launchpad App" },
] as const;

function traffic(siteCount: number, dayCount: number) {
  const sites = ALL_SITES.slice(0, siteCount);
  return {
    sites: sites.map((site) => ({ ...site })),
    data: Array.from({ length: dayCount }, (_, day) => ({
      timestampMs: fixtureDay(day),
      sites: sites.map((site, index) => {
        const visitors = fixtureWave(day, 900 - index * 130, 180, index);
        return {
          siteId: site.id,
          visitors,
          views: Math.round(visitors * (2.1 + index * 0.15)),
        };
      }),
    })),
    from: fixtureDay(0),
    to: fixtureDay(dayCount - 1),
  };
}

const baseProps = {
  locale: "en-US",
  timeZone: "UTC",
  interval: "day",
  viewsLabel: "Views",
  visitorsLabel: "Visitors",
  messages: {
    common: {
      sitesFiltered: "{active} / {total} sites filtered",
      cumulativeTraffic: "Cumulative traffic",
    },
  },
  className: "h-[280px]",
} as const satisfies Partial<SiteTrafficStackChartProps>;

export const siteTrafficStackChartFixtures = [
  {
    id: "site-traffic-stack-chart.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      ...traffic(3, 14),
    } satisfies SiteTrafficStackChartProps,
  },
  {
    id: "site-traffic-stack-chart.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      ...traffic(3, 14),
      loading: true,
    } satisfies SiteTrafficStackChartProps,
  },
  {
    id: "site-traffic-stack-chart.state.empty",
    title: "No traffic",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...baseProps,
      ...traffic(3, 14),
      data: [],
    } satisfies SiteTrafficStackChartProps,
  },
  {
    id: "site-traffic-stack-chart.showcase",
    title: "Showcase",
    description: "Thirty days of traffic across the sites of one team.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      sites: SHOWCASE_TEAM_SITES.map((site) => ({ ...site })),
      data: teamTraffic,
      from: SHOWCASE_START_MS,
      to: SHOWCASE_START_MS + (SHOWCASE_DAYS - 1) * SHOWCASE_DAY_MS,
    } satisfies SiteTrafficStackChartProps,
  },
] as const satisfies readonly ComponentFixture<SiteTrafficStackChartProps>[];

export const siteTrafficStackChartContract =
  defineComponentContract<SiteTrafficStackChartProps>({
    id: "site-traffic-stack-chart",
    title: "Site traffic stack chart",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only stacked bar chart comparing visitors and views across several sites.",
    fixtures: siteTrafficStackChartFixtures,
    render: (props) => (
      <div className="w-full">
        <SiteTrafficStackChart {...props} />
      </div>
    ),
  });
