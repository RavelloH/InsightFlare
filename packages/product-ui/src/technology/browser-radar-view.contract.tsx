import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  type BrowserRadarItem,
  type BrowserRadarLabels,
  BrowserRadarView,
  type BrowserRadarViewProps,
} from "./browser-radar-view";

const labels = {
  title: "Browser behavior",
  subtitle: "How visitors engage, by browser",
  loadingLabel: "Loading",
  emptyLabel: "No data",
  metrics: {
    duration: "Duration",
    engagement: "Engagement",
    depth: "Depth",
    loyalty: "Loyalty",
    frequency: "Frequency",
    traffic: "Traffic",
  },
} as const satisfies BrowserRadarLabels;

const items = [
  {
    browser: "Chrome",
    metrics: {
      duration: 148000,
      engagement: 0.62,
      depth: 2.9,
      loyalty: 0.41,
      frequency: 3.4,
      traffic: 0.48,
    },
  },
  {
    browser: "Safari",
    metrics: {
      duration: 121000,
      engagement: 0.57,
      depth: 2.4,
      loyalty: 0.38,
      frequency: 2.8,
      traffic: 0.24,
    },
  },
  {
    browser: "Edge",
    metrics: {
      duration: 163000,
      engagement: 0.66,
      depth: 3.2,
      loyalty: 0.45,
      frequency: 3.9,
      traffic: 0.1,
    },
  },
  {
    browser: "Firefox",
    metrics: {
      duration: 176000,
      engagement: 0.7,
      depth: 3.5,
      loyalty: 0.52,
      frequency: 4.3,
      traffic: 0.06,
    },
  },
] as const satisfies readonly BrowserRadarItem[];

const comparisonItems = [
  {
    browser: "Chrome",
    metrics: {
      duration: 139000,
      engagement: 0.59,
      depth: 2.7,
      loyalty: 0.4,
      frequency: 3.1,
      traffic: 0.46,
    },
  },
  {
    browser: "Safari",
    metrics: {
      duration: 118000,
      engagement: 0.55,
      depth: 2.3,
      loyalty: 0.36,
      frequency: 2.6,
      traffic: 0.25,
    },
  },
  {
    browser: "Edge",
    metrics: {
      duration: 151000,
      engagement: 0.63,
      depth: 3,
      loyalty: 0.43,
      frequency: 3.6,
      traffic: 0.1,
    },
  },
  {
    browser: "Firefox",
    metrics: {
      duration: 169000,
      engagement: 0.68,
      depth: 3.3,
      loyalty: 0.5,
      frequency: 4.1,
      traffic: 0.07,
    },
  },
] as const satisfies readonly BrowserRadarItem[];

const base = {
  labels,
  locale: "en-US",
  loading: false,
  comparisonLabel: "Previous period",
} as const satisfies Partial<BrowserRadarViewProps>;

export const browserRadarFixtures = [
  {
    id: "browser-radar.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...base,
      items,
      comparisonItems: [],
    } satisfies BrowserRadarViewProps,
  },
  {
    id: "browser-radar.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...base,
      loading: true,
      items: [],
      comparisonItems: [],
    } satisfies BrowserRadarViewProps,
  },
  {
    id: "browser-radar.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...base,
      items: [],
      comparisonItems: [],
    } satisfies BrowserRadarViewProps,
  },
  {
    id: "browser-radar.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...base,
      items,
      comparisonItems,
    } satisfies BrowserRadarViewProps,
  },
  {
    id: "browser-radar.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...base,
      items,
      comparisonItems,
    } satisfies BrowserRadarViewProps,
  },
] as const satisfies readonly ComponentFixture<BrowserRadarViewProps>[];

export const browserRadarContract =
  defineComponentContract<BrowserRadarViewProps>({
    id: "browser-radar",
    title: "Browser behavior radar",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A grid of per-browser radar charts comparing engagement metrics, with optional previous-period overlays.",
    fixtures: browserRadarFixtures,
    render: (props) => <BrowserRadarView {...props} />,
  });
