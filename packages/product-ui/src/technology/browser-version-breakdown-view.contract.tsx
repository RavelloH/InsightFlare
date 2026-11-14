import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";
import { TooltipProvider } from "@insightflare/ui/tooltip";

import {
  currentTotals,
  previousTotals,
  splitTotal,
} from "../showcase/site-profile";
import {
  type BrowserVersionBreakdownLabels,
  BrowserVersionBreakdownView,
  type BrowserVersionBreakdownViewProps,
  type BrowserVersionBrowserDisplay,
} from "./browser-version-breakdown-view";

const labels = {
  title: "Browser versions",
  loadingLabel: "Loading",
  emptyLabel: "No data",
  visitorsLabel: "Visitors",
  currentPeriodLabel: "Current period",
} as const satisfies BrowserVersionBreakdownLabels;

function browser(
  name: string,
  versions: ReadonlyArray<readonly [string, number]>,
): BrowserVersionBrowserDisplay {
  const total = versions.reduce((sum, [, visitors]) => sum + visitors, 0);
  return {
    browser: name,
    visitors: total,
    versions: versions.map(([version, visitors]) => ({
      key: `${name.toLowerCase()}-${version.toLowerCase().replace(/\s+/g, "-")}`,
      displayLabel: `${name} ${version}`,
      visitors,
      share: total > 0 ? visitors / total : 0,
    })),
  };
}

const browsers = [
  browser("Chrome", [
    ["131", 9240],
    ["130", 5410],
    ["129", 2120],
    ["128", 980],
    ["Other", 670],
  ]),
  browser("Safari", [
    ["18.1", 4380],
    ["18.0", 2760],
    ["17.6", 1420],
    ["17.5", 520],
    ["Other", 280],
  ]),
] as const satisfies readonly BrowserVersionBrowserDisplay[];

const comparisonBrowsers = [
  browser("Chrome", [
    ["131", 7610],
    ["130", 5980],
    ["129", 2540],
    ["128", 1210],
    ["Other", 840],
  ]),
  browser("Safari", [
    ["18.1", 3520],
    ["18.0", 3010],
    ["17.6", 1690],
    ["17.5", 610],
    ["Other", 330],
  ]),
] as const satisfies readonly BrowserVersionBrowserDisplay[];

// Version mixes scaled to the browser totals used by the share overview.
function scaledBrowser(
  name: string,
  versions: ReadonlyArray<readonly [string, number]>,
  total: number,
): BrowserVersionBrowserDisplay {
  const values = splitTotal(
    total,
    versions.map(([, weight]) => weight),
  );
  const scaled = browser(
    name,
    versions.map(([version], index) => [version, values[index] ?? 0] as const),
  );
  // The card title already names the browser, so rows only need the version.
  return {
    ...scaled,
    versions: scaled.versions.map((entry) => ({
      ...entry,
      displayLabel: entry.displayLabel.slice(name.length + 1),
    })),
  };
}

const CHROME_MIX = [
  ["131", 54],
  ["130", 31],
  ["129", 7],
  ["128", 4],
  ["Other", 4],
] as const;
const CHROME_MIX_PREVIOUS = [
  ["131", 36],
  ["130", 41],
  ["129", 11],
  ["128", 7],
  ["Other", 5],
] as const;
const SAFARI_MIX = [
  ["18.1", 52],
  ["18.0", 28],
  ["17.6", 12],
  ["17.5", 5],
  ["Other", 3],
] as const;
const SAFARI_MIX_PREVIOUS = [
  ["18.1", 33],
  ["18.0", 38],
  ["17.6", 17],
  ["17.5", 8],
  ["Other", 4],
] as const;

const showcaseBrowsers = [
  scaledBrowser(
    "Chrome",
    CHROME_MIX,
    Math.round(currentTotals.visitors * 0.638),
  ),
  scaledBrowser(
    "Safari",
    SAFARI_MIX,
    Math.round(currentTotals.visitors * 0.191),
  ),
];
const showcaseComparisonBrowsers = [
  scaledBrowser(
    "Chrome",
    CHROME_MIX_PREVIOUS,
    Math.round(previousTotals.visitors * 0.621),
  ),
  scaledBrowser(
    "Safari",
    SAFARI_MIX_PREVIOUS,
    Math.round(previousTotals.visitors * 0.198),
  ),
];

const base = {
  locale: "en-US",
  labels,
  loading: false,
  refreshing: false,
} as const satisfies Partial<BrowserVersionBreakdownViewProps>;

export const browserVersionBreakdownFixtures = [
  {
    id: "browser-version-breakdown.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: { ...base, browsers } satisfies BrowserVersionBreakdownViewProps,
  },
  {
    id: "browser-version-breakdown.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...base,
      loading: true,
      browsers: [],
    } satisfies BrowserVersionBreakdownViewProps,
  },
  {
    id: "browser-version-breakdown.state.refreshing",
    title: "Refreshing",
    presentation: { kind: "scenario", scenario: "refreshing" },
    props: {
      ...base,
      refreshing: true,
      browsers,
    } satisfies BrowserVersionBreakdownViewProps,
  },
  {
    id: "browser-version-breakdown.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: { ...base, browsers: [] } satisfies BrowserVersionBreakdownViewProps,
  },
  {
    id: "browser-version-breakdown.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...base,
      browsers,
      comparisonBrowsers,
      comparisonLabel: "Previous period",
    } satisfies BrowserVersionBreakdownViewProps,
  },
  {
    id: "browser-version-breakdown.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...base,
      browsers: showcaseBrowsers,
      comparisonBrowsers: showcaseComparisonBrowsers,
      comparisonLabel: "Previous period",
    } satisfies BrowserVersionBreakdownViewProps,
  },
] as const satisfies readonly ComponentFixture<BrowserVersionBreakdownViewProps>[];

export const browserVersionBreakdownContract =
  defineComponentContract<BrowserVersionBreakdownViewProps>({
    id: "browser-version-breakdown",
    title: "Browser version breakdown",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "Donut cards showing the version mix of each browser, with optional period comparison and a refresh overlay.",
    fixtures: browserVersionBreakdownFixtures,
    render: (props) => (
      <TooltipProvider>
        <BrowserVersionBreakdownView {...props} />
      </TooltipProvider>
    ),
  });
