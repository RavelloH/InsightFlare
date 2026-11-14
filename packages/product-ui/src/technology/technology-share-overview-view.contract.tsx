import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import {
  RiCellphoneLine,
  RiComputerLine,
  RiTabletLine,
} from "@remixicon/react";

import type { ShareBreakdownItem } from "../sharing";
import {
  currentTotals,
  previousTotals,
  SHOWCASE_BROWSER_WEIGHTS as BROWSER_WEIGHTS,
  SHOWCASE_BROWSER_WEIGHTS_PREVIOUS as BROWSER_WEIGHTS_PREVIOUS,
  SHOWCASE_DEVICE_WEIGHTS as DEVICE_WEIGHTS,
  SHOWCASE_DEVICE_WEIGHTS_PREVIOUS as DEVICE_WEIGHTS_PREVIOUS,
  SHOWCASE_ENGINE_WEIGHTS as ENGINE_WEIGHTS,
  SHOWCASE_ENGINE_WEIGHTS_PREVIOUS as ENGINE_WEIGHTS_PREVIOUS,
  SHOWCASE_OS_WEIGHTS as OS_WEIGHTS,
  SHOWCASE_OS_WEIGHTS_PREVIOUS as OS_WEIGHTS_PREVIOUS,
  splitTotal,
} from "../showcase/site-profile";
import {
  type TechnologyShareOverviewLabels,
  TechnologyShareOverviewView,
  type TechnologyShareOverviewViewProps,
} from "./technology-share-overview-view";

const browserLabels = {
  primaryTitle: "Browser share",
  secondaryTitle: "Rendering engine share",
  valueLabel: "Visitors",
  emptyLabel: "No data",
  loadingLabel: "Loading",
} as const satisfies TechnologyShareOverviewLabels;

const deviceLabels = {
  primaryTitle: "Device share",
  secondaryTitle: "Operating system share",
  valueLabel: "Visitors",
  emptyLabel: "No data",
  loadingLabel: "Loading",
} as const satisfies TechnologyShareOverviewLabels;

const browsers = [
  { key: "chrome", label: "Chrome", value: 18420 },
  { key: "safari", label: "Safari", value: 9360 },
  { key: "edge", label: "Edge", value: 3910 },
  { key: "firefox", label: "Firefox", value: 2480 },
  { key: "samsung", label: "Samsung Internet", value: 1275 },
  { key: "other", label: "Other", value: 1190, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

const browsersPrevious = [
  { key: "chrome", label: "Chrome", value: 16980 },
  { key: "safari", label: "Safari", value: 8740 },
  { key: "edge", label: "Edge", value: 3520 },
  { key: "firefox", label: "Firefox", value: 2610 },
  { key: "samsung", label: "Samsung Internet", value: 1110 },
  { key: "other", label: "Other", value: 1040, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

const engines = [
  { key: "blink", label: "Blink", value: 24120 },
  { key: "webkit", label: "WebKit", value: 9710 },
  { key: "gecko", label: "Gecko", value: 2480 },
  { key: "other", label: "Other", value: 325, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

const enginesPrevious = [
  { key: "blink", label: "Blink", value: 22010 },
  { key: "webkit", label: "WebKit", value: 9020 },
  { key: "gecko", label: "Gecko", value: 2610 },
  { key: "other", label: "Other", value: 290, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

const devices = [
  { key: "desktop", label: "Desktop", value: 21480, icon: RiComputerLine },
  { key: "mobile", label: "Mobile", value: 14260, icon: RiCellphoneLine },
  { key: "tablet", label: "Tablet", value: 1810, icon: RiTabletLine },
] as const satisfies readonly ShareBreakdownItem[];

const devicesPrevious = [
  { key: "desktop", label: "Desktop", value: 20230, icon: RiComputerLine },
  { key: "mobile", label: "Mobile", value: 12940, icon: RiCellphoneLine },
  { key: "tablet", label: "Tablet", value: 1950, icon: RiTabletLine },
] as const satisfies readonly ShareBreakdownItem[];

const operatingSystems = [
  { key: "windows", label: "Windows", value: 12640 },
  { key: "ios", label: "iOS", value: 8120 },
  { key: "android", label: "Android", value: 6140 },
  { key: "macos", label: "macOS", value: 5870 },
  { key: "linux", label: "Linux", value: 2310 },
  { key: "other", label: "Other", value: 470, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

const operatingSystemsPrevious = [
  { key: "windows", label: "Windows", value: 12010 },
  { key: "ios", label: "iOS", value: 7480 },
  { key: "android", label: "Android", value: 5620 },
  { key: "macos", label: "macOS", value: 5410 },
  { key: "linux", label: "Linux", value: 2390 },
  { key: "other", label: "Other", value: 410, isOther: true },
] as const satisfies readonly ShareBreakdownItem[];

// Showcase shares are derived from the unique visitors of each window, so the
// browser, engine, device, and OS breakdowns all add up to the same total.
function withShares<T extends { key: string; value: number }>(
  items: readonly T[],
  total: number,
  weights: Readonly<Record<string, number>>,
): T[] {
  const values = splitTotal(
    total,
    items.map((item) => weights[item.key] ?? 0),
  );
  return items.map((item, index) => ({ ...item, value: values[index] ?? 0 }));
}

const showcaseBrowsers = withShares(
  browsers,
  currentTotals.visitors,
  BROWSER_WEIGHTS,
);
const showcaseBrowsersPrevious = withShares(
  browsersPrevious,
  previousTotals.visitors,
  BROWSER_WEIGHTS_PREVIOUS,
);
const showcaseEngines = withShares(
  engines,
  currentTotals.visitors,
  ENGINE_WEIGHTS,
);
const showcaseEnginesPrevious = withShares(
  enginesPrevious,
  previousTotals.visitors,
  ENGINE_WEIGHTS_PREVIOUS,
);
const showcaseDevices = withShares(
  devices,
  currentTotals.visitors,
  DEVICE_WEIGHTS,
);
const showcaseDevicesPrevious = withShares(
  devicesPrevious,
  previousTotals.visitors,
  DEVICE_WEIGHTS_PREVIOUS,
);
const showcaseOperatingSystems = withShares(
  operatingSystems,
  currentTotals.visitors,
  OS_WEIGHTS,
);
const showcaseOperatingSystemsPrevious = withShares(
  operatingSystemsPrevious,
  previousTotals.visitors,
  OS_WEIGHTS_PREVIOUS,
);

const browserBase = {
  variant: "browser",
  locale: "en-US",
  labels: browserLabels,
  loading: false,
  refreshing: false,
} as const satisfies Partial<TechnologyShareOverviewViewProps>;

const deviceBase = {
  variant: "device",
  locale: "en-US",
  labels: deviceLabels,
  loading: false,
  refreshing: false,
} as const satisfies Partial<TechnologyShareOverviewViewProps>;

export const technologyShareOverviewFixtures = [
  {
    id: "technology-share-overview.state.ready",
    title: "Browser share",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...browserBase,
      primary: { items: browsers },
      secondary: { items: engines },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...browserBase,
      loading: true,
      primary: { items: [] },
      secondary: { items: [] },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.state.refreshing",
    title: "Refreshing",
    presentation: { kind: "scenario", scenario: "refreshing" },
    props: {
      ...browserBase,
      refreshing: true,
      primary: { items: browsers },
      secondary: { items: engines },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...browserBase,
      primary: { items: [] },
      secondary: { items: [] },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      ...browserBase,
      comparisonLabel: "Previous period",
      primary: { items: browsers, comparisonItems: browsersPrevious },
      secondary: { items: engines, comparisonItems: enginesPrevious },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.state.device",
    title: "Device and operating system share",
    presentation: { kind: "scenario", scenario: "device" },
    props: {
      ...deviceBase,
      primary: { items: devices },
      secondary: { items: operatingSystems },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.showcase",
    title: "Showcase: browsers",
    description: "Realistic browser data for marketing and documentation.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...browserBase,
      comparisonLabel: "Previous period",
      primary: {
        items: showcaseBrowsers,
        comparisonItems: showcaseBrowsersPrevious,
      },
      secondary: {
        items: showcaseEngines,
        comparisonItems: showcaseEnginesPrevious,
      },
    } satisfies TechnologyShareOverviewViewProps,
  },
  {
    id: "technology-share-overview.showcase-device",
    title: "Showcase: devices",
    description: "Realistic device data for marketing and documentation.",
    presentation: { kind: "scenario", scenario: "showcase-device" },
    props: {
      ...deviceBase,
      comparisonLabel: "Previous period",
      primary: {
        items: showcaseDevices,
        comparisonItems: showcaseDevicesPrevious,
      },
      secondary: {
        items: showcaseOperatingSystems,
        comparisonItems: showcaseOperatingSystemsPrevious,
      },
    } satisfies TechnologyShareOverviewViewProps,
  },
] as const satisfies readonly ComponentFixture<TechnologyShareOverviewViewProps>[];

export const technologyShareOverviewContract =
  defineComponentContract<TechnologyShareOverviewViewProps>({
    id: "technology-share-overview",
    title: "Technology share overview",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "Two stacked share breakdowns for browsers and engines, or devices and operating systems, with an optional refresh indicator.",
    fixtures: technologyShareOverviewFixtures,
    render: (props) => (
      <TooltipProvider>
        <TechnologyShareOverviewView {...props} />
      </TooltipProvider>
    ),
  });
