import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  createShowcaseRng,
  SHOWCASE_COUNTRIES,
} from "../showcase/site-profile";
import {
  type RealtimeLogStreamLabels,
  RealtimeLogStreamView,
  type RealtimeLogStreamViewItem,
  type RealtimeLogStreamViewProps,
} from "./realtime-log-stream-view";

const labels = {
  title: "Recent events",
  loading: "Loading...",
  empty: "No data",
  direct: "Direct",
} as const satisfies RealtimeLogStreamLabels;

const BASE_EVENT_AT = Date.UTC(2026, 6, 13, 12, 30, 0);

const items = [
  {
    id: "evt-1",
    eventAt: BASE_EVENT_AT,
    eventDateTime: "Jul 13, 12:30",
    title: "Viewed page: /blog/privacy-first-analytics",
    avatarSeed: "visitor-4f2a",
    browserLabel: "Chrome",
    browserIconKey: "chrome",
    osLabel: "macOS",
    osIconKey: "mac-os",
    countryLabel: "United States",
    countryFlagCode: "US",
    sourceLabel: "news.ycombinator.com",
  },
  {
    id: "evt-2",
    eventAt: BASE_EVENT_AT - 18_000,
    eventDateTime: "Jul 13, 12:29",
    title: "Entered page: /pricing",
    avatarSeed: "visitor-91bc",
    browserLabel: "Safari",
    browserIconKey: "safari",
    osLabel: "iOS",
    osIconKey: "ios",
    countryLabel: "Japan",
    countryFlagCode: "JP",
    sourceLabel: "google.com",
  },
  {
    id: "evt-3",
    eventAt: BASE_EVENT_AT - 41_000,
    eventDateTime: "Jul 13, 12:29",
    title: "Custom event: signup_click",
    avatarSeed: "visitor-c730",
    browserLabel: "Firefox",
    browserIconKey: "firefox",
    osLabel: "Windows 11",
    osIconKey: "windows-11",
    countryLabel: "Germany",
    countryFlagCode: "DE",
    sourceLabel: "Direct",
  },
  {
    id: "evt-4",
    eventAt: BASE_EVENT_AT - 77_000,
    eventDateTime: "Jul 13, 12:28",
    title: "Viewed page: /docs/getting-started",
    avatarSeed: "visitor-0d58",
    browserLabel: "Edge",
    browserIconKey: "edge-chromium",
    osLabel: "Windows 10",
    osIconKey: "windows-10",
    countryLabel: "Brazil",
    countryFlagCode: "BR",
    sourceLabel: "github.com",
  },
  {
    id: "evt-5",
    eventAt: BASE_EVENT_AT - 125_000,
    eventDateTime: "Jul 13, 12:28",
    title: "Left page: /features",
    avatarSeed: "visitor-a6e1",
    browserLabel: "Chrome",
    browserIconKey: "chrome",
    osLabel: "Android",
    osIconKey: "android-os",
    countryLabel: "India",
    countryFlagCode: "IN",
    sourceLabel: "duckduckgo.com",
  },
] as const satisfies readonly RealtimeLogStreamViewItem[];

const SHOWCASE_PAGES = [
  "/docs/getting-started/quick-start",
  "/blog/why-we-moved-off-ga4",
  "/docs/api/authentication",
  "/docs/deployment/cloudflare",
  "/changelog",
  "/docs/tracking/custom-events",
  "/blog/cookieless-analytics-explained",
  "/docs/guides/migrate-from-umami",
  "/",
  "/docs/reference/configuration",
  "/blog/launch-day-notes",
] as const;

const SHOWCASE_EVENTS = [
  "docs_search",
  "copy_install",
  "deploy_click",
] as const;

const SHOWCASE_CLIENTS = [
  ["Chrome", "chrome", "Windows 11", "windows-11"],
  ["Chrome", "chrome", "macOS", "mac-os"],
  ["Safari", "safari", "iOS", "ios"],
  ["Safari", "safari", "macOS", "mac-os"],
  ["Firefox", "firefox", "Linux", "linux"],
  ["Edge", "edge-chromium", "Windows 10", "windows-10"],
  ["Chrome", "chrome", "Android", "android-os"],
  ["Samsung Internet", "samsung", "Android", "android-os"],
  ["Firefox", "firefox", "Windows 11", "windows-11"],
] as const;

const SHOWCASE_SOURCES = [
  "google.com",
  "Direct",
  "github.com",
  "news.ycombinator.com",
  "reddit.com",
  "duckduckgo.com",
  "x.com",
] as const;

const showcaseTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function pick<T>(values: readonly T[], rng: () => number): T {
  return values[
    Math.min(values.length - 1, Math.floor(rng() * values.length))
  ]!;
}

function showcaseItems(count: number): RealtimeLogStreamViewItem[] {
  const rng = createShowcaseRng(20260713);
  const countries = SHOWCASE_COUNTRIES.flatMap((country) =>
    Array.from(
      { length: Math.max(1, Math.round(country.weight / 2)) },
      () => country,
    ),
  );
  let eventAt = BASE_EVENT_AT;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) eventAt -= 3_000 + Math.floor(rng() * rng() * 42_000);
    const kind = rng();
    const path = pick(SHOWCASE_PAGES, rng);
    const title =
      kind < 0.5
        ? `Viewed page: ${path}`
        : kind < 0.72
          ? `Entered page: ${path}`
          : kind < 0.88
            ? `Custom event: ${pick(SHOWCASE_EVENTS, rng)}`
            : `Left page: ${path}`;
    const [browserLabel, browserIconKey, osLabel, osIconKey] = pick(
      SHOWCASE_CLIENTS,
      rng,
    );
    const country = pick(countries, rng);
    return {
      id: `showcase-${index}`,
      eventAt,
      eventDateTime: showcaseTime.format(eventAt).replace(" at ", ", "),
      title,
      avatarSeed: `visitor-${Math.floor(rng() * 0xffff)
        .toString(16)
        .padStart(4, "0")}`,
      browserLabel,
      browserIconKey,
      osLabel,
      osIconKey,
      countryLabel: country.label,
      countryFlagCode: country.code,
      sourceLabel: pick(SHOWCASE_SOURCES, rng),
    };
  });
}

const baseProps = {
  labels,
  locale: "en-US",
  reduceMotion: true,
  syncKey: "fixture",
  onReachEnd: null,
} as const satisfies Omit<RealtimeLogStreamViewProps, "items" | "state">;

export const realtimeLogStreamFixtures = [
  {
    id: "realtime-log-stream.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      ...baseProps,
      state: "ready",
      items,
    } satisfies RealtimeLogStreamViewProps,
  },
  {
    id: "realtime-log-stream.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      ...baseProps,
      state: "loading",
      items: [],
    } satisfies RealtimeLogStreamViewProps,
  },
  {
    id: "realtime-log-stream.state.empty",
    title: "Empty",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      ...baseProps,
      state: "empty",
      items: [],
    } satisfies RealtimeLogStreamViewProps,
  },
  {
    id: "realtime-log-stream.compact",
    title: "Compact",
    description: "Slim rows without the visitor avatar, for dense layouts.",
    presentation: { kind: "scenario", scenario: "compact" },
    props: {
      ...baseProps,
      state: "ready",
      items,
      density: "compact",
      showAvatar: false,
    } satisfies RealtimeLogStreamViewProps,
  },
  {
    id: "realtime-log-stream.showcase",
    title: "Showcase",
    description: "Live activity feed for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      ...baseProps,
      state: "ready",
      items: showcaseItems(16),
    } satisfies RealtimeLogStreamViewProps,
  },
] as const satisfies readonly ComponentFixture<RealtimeLogStreamViewProps>[];

export const realtimeLogStreamContract =
  defineComponentContract<RealtimeLogStreamViewProps>({
    id: "realtime-log-stream",
    title: "Realtime log stream",
    category: "Product UI / Realtime",
    categoryId: "product-realtime",
    description:
      "A props-only live activity feed with loading and empty states and animated entries.",
    fixtures: realtimeLogStreamFixtures,
    render: (props) => <RealtimeLogStreamView {...props} />,
  });
