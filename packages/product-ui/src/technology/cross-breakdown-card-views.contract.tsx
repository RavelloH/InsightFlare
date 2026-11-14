import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";
import { RiCellphoneLine, RiComputerLine } from "@remixicon/react";

import {
  BrowserCrossBreakdownCardView,
  type BrowserCrossBreakdownCardViewProps,
  type CrossBreakdownCardLabels,
  type CrossBreakdownDimension,
  DeviceCrossBreakdownCardView,
  type DeviceCrossBreakdownCardViewProps,
} from "./cross-breakdown-card-views";

const labels = {
  loadingLabel: "Loading",
  emptyLabel: "No data",
} as const satisfies CrossBreakdownCardLabels;

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const;

const browserNames = ["Chrome", "Safari", "Edge", "Firefox"] as const;

function dimension(
  columns: ReadonlyArray<{ key: string; label: string; icon?: boolean }>,
  rows: ReadonlyArray<{ key: string; label: string; values: number[] }>,
  scale = 1,
): CrossBreakdownDimension {
  return {
    columns: columns.map((column, index) => ({
      key: column.key,
      displayLabel: column.label,
      color: COLORS[index % COLORS.length],
      Icon:
        column.icon === undefined
          ? undefined
          : column.key === "mobile"
            ? RiCellphoneLine
            : RiComputerLine,
    })),
    rows: rows.map((row) => ({
      key: row.key,
      displayLabel: row.label,
      cells: row.values.map((value, index) => ({
        key: columns[index].key,
        visitors: Math.round(value * scale),
      })),
    })),
  };
}

const osColumns = [
  { key: "windows", label: "Windows" },
  { key: "ios", label: "iOS" },
  { key: "android", label: "Android" },
  { key: "macos", label: "macOS" },
  { key: "linux", label: "Linux" },
] as const;

const osByBrowser = dimension(osColumns, [
  {
    key: "chrome",
    label: browserNames[0],
    values: [9120, 1210, 5640, 2310, 1140],
  },
  { key: "safari", label: browserNames[1], values: [0, 6820, 0, 2540, 0] },
  { key: "edge", label: browserNames[2], values: [3560, 0, 180, 210, 90] },
  { key: "firefox", label: browserNames[3], values: [1480, 0, 320, 440, 240] },
]);

const osByBrowserPrevious = dimension(osColumns, [
  {
    key: "chrome",
    label: browserNames[0],
    values: [8640, 1080, 5210, 2190, 1160],
  },
  { key: "safari", label: browserNames[1], values: [0, 6310, 0, 2380, 0] },
  { key: "edge", label: browserNames[2], values: [3310, 0, 160, 190, 100] },
  { key: "firefox", label: browserNames[3], values: [1590, 0, 290, 460, 260] },
]);

const deviceColumns = [
  { key: "desktop", label: "Desktop", icon: true },
  { key: "mobile", label: "Mobile", icon: true },
] as const;

const deviceByBrowser = dimension(deviceColumns, [
  { key: "chrome", label: browserNames[0], values: [11840, 6580] },
  { key: "safari", label: browserNames[1], values: [2410, 6950] },
  { key: "edge", label: browserNames[2], values: [3590, 320] },
  { key: "firefox", label: browserNames[3], values: [2140, 340] },
]);

const deviceByBrowserPrevious = dimension(deviceColumns, [
  { key: "chrome", label: browserNames[0], values: [11020, 5960] },
  { key: "safari", label: browserNames[1], values: [2290, 6400] },
  { key: "edge", label: browserNames[2], values: [3340, 180] },
  { key: "firefox", label: browserNames[3], values: [2260, 350] },
]);

const emptyDimension: CrossBreakdownDimension = { columns: [], rows: [] };

const browserColumns = [
  { key: "chrome", label: "Chrome" },
  { key: "safari", label: "Safari" },
  { key: "edge", label: "Edge" },
  { key: "firefox", label: "Firefox" },
] as const;

const browserByDevice = dimension(browserColumns, [
  { key: "desktop", label: "Desktop", values: [11840, 2410, 3590, 2140] },
  { key: "mobile", label: "Mobile", values: [6580, 6950, 320, 340] },
  { key: "tablet", label: "Tablet", values: [780, 1210, 60, 40] },
]);

const browserByDevicePrevious = dimension(browserColumns, [
  { key: "desktop", label: "Desktop", values: [11020, 2290, 3340, 2260] },
  { key: "mobile", label: "Mobile", values: [5960, 6400, 180, 350] },
  { key: "tablet", label: "Tablet", values: [820, 1260, 50, 60] },
]);

export const browserCrossBreakdownCardFixtures = [
  {
    id: "browser-cross-breakdown-card.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      locale: "en-US",
      labels,
      title: "Operating system by browser",
      dimension: osByBrowser,
      loading: false,
      hydrated: true,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
  {
    id: "browser-cross-breakdown-card.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      locale: "en-US",
      labels,
      title: "Operating system by browser",
      dimension: emptyDimension,
      loading: true,
      hydrated: false,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
  {
    id: "browser-cross-breakdown-card.state.refreshing",
    title: "Refreshing",
    presentation: { kind: "scenario", scenario: "refreshing" },
    props: {
      locale: "en-US",
      labels,
      title: "Operating system by browser",
      dimension: osByBrowser,
      loading: true,
      hydrated: true,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
  {
    id: "browser-cross-breakdown-card.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      locale: "en-US",
      labels,
      title: "Operating system by browser",
      dimension: emptyDimension,
      loading: false,
      hydrated: true,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
  {
    id: "browser-cross-breakdown-card.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      locale: "en-US",
      labels,
      title: "Device type by browser",
      dimension: deviceByBrowser,
      comparisonDimension: deviceByBrowserPrevious,
      loading: false,
      hydrated: true,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
  {
    id: "browser-cross-breakdown-card.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      locale: "en-US",
      labels,
      title: "Operating system by browser",
      dimension: osByBrowser,
      comparisonDimension: osByBrowserPrevious,
      loading: false,
      hydrated: true,
    } satisfies BrowserCrossBreakdownCardViewProps,
  },
] as const satisfies readonly ComponentFixture<BrowserCrossBreakdownCardViewProps>[];

export const deviceCrossBreakdownCardFixtures = [
  {
    id: "device-cross-breakdown-card.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      locale: "en-US",
      labels,
      title: "Browser by device",
      dimension: browserByDevice,
      loading: false,
    } satisfies DeviceCrossBreakdownCardViewProps,
  },
  {
    id: "device-cross-breakdown-card.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      locale: "en-US",
      labels,
      title: "Browser by device",
      dimension: emptyDimension,
      loading: true,
    } satisfies DeviceCrossBreakdownCardViewProps,
  },
  {
    id: "device-cross-breakdown-card.state.empty",
    title: "No data",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      locale: "en-US",
      labels,
      title: "Browser by device",
      dimension: emptyDimension,
      loading: false,
    } satisfies DeviceCrossBreakdownCardViewProps,
  },
  {
    id: "device-cross-breakdown-card.state.comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      locale: "en-US",
      labels,
      title: "Browser by device",
      dimension: browserByDevice,
      comparisonDimension: browserByDevicePrevious,
      loading: false,
    } satisfies DeviceCrossBreakdownCardViewProps,
  },
  {
    id: "device-cross-breakdown-card.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      locale: "en-US",
      labels,
      title: "Browser by device",
      dimension: browserByDevice,
      comparisonDimension: browserByDevicePrevious,
      loading: false,
    } satisfies DeviceCrossBreakdownCardViewProps,
  },
] as const satisfies readonly ComponentFixture<DeviceCrossBreakdownCardViewProps>[];

export const browserCrossBreakdownCardContract =
  defineComponentContract<BrowserCrossBreakdownCardViewProps>({
    id: "browser-cross-breakdown-card",
    title: "Browser cross breakdown card",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A stacked bar card breaking one dimension down by another, with a refresh overlay and optional period comparison.",
    fixtures: browserCrossBreakdownCardFixtures,
    render: (props) => <BrowserCrossBreakdownCardView {...props} />,
  });

export const deviceCrossBreakdownCardContract =
  defineComponentContract<DeviceCrossBreakdownCardViewProps>({
    id: "device-cross-breakdown-card",
    title: "Device cross breakdown card",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A stacked bar card breaking device types down by browser or operating system, with optional period comparison.",
    fixtures: deviceCrossBreakdownCardFixtures,
    render: (props) => <DeviceCrossBreakdownCardView {...props} />,
  });
