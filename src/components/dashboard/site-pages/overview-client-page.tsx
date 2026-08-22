import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@iconify/react";
import {
  RiAdvertisementLine,
  RiArrowDownLine,
  RiArrowRightUpLine,
  RiArrowUpLine,
  RiCursorLine,
  RiLineChartLine,
  RiLinksLine,
  RiMailLine,
  RiMegaphoneLine,
  RiMoneyDollarCircleLine,
  RiPriceTag3Line,
  RiQuestionLine,
  RiSearchLine,
  RiShareForwardLine,
} from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import {
  DeviceMeta,
  InlineMeta,
  resolveDeviceTypeMeta,
} from "@/components/dashboard/journey-display";
import {
  LazyGeoCityBreadcrumbLabel,
  LazyGeoRegionBreadcrumbLabel,
} from "@/components/dashboard/lazy-geo-location-label";
import { OverviewGeoPointsMapCard } from "@/components/dashboard/overview-geo-points-map-card";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableTab,
} from "@/components/dashboard/tabbed-data-table-card";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Spinner } from "@/components/ui/spinner";
import {
  TRAFFIC_CHANNEL_IDS,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  fetchOverview,
  fetchOverviewClientDimensionTab,
  fetchOverviewGeoDimensionTab,
  fetchOverviewPageCardTab,
  fetchOverviewSourceCardTab,
  fetchTrend,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import {
  type DashboardFilterControlKey,
  dashboardFilterValue,
  serializeDashboardSearchParams,
  setDashboardFilterValue,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  canonicalizeGeoLocationValue,
} from "@/lib/dashboard/geo-location";
import {
  isSameGeoLabel,
  normalizeGeoTranslationLookupValue,
} from "@/lib/dashboard/geo-translation";
import {
  buildPageDetailHref,
  normalizePagePath,
} from "@/lib/dashboard/page-detail";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { OverviewData, TrendData } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterParams,
} from "@/lib/filter-contract";
import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { usePathname, useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
}

function toDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function emptyOverviewData(): OverviewData {
  return {
    ok: true,
    data: {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
    },
  };
}

function emptyTrendData(interval: TimeWindow["interval"]): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

const METRIC_AREA_COLOR = "var(--color-chart-1)";
const MAX_TREND_PLACEHOLDER_POINTS = 120;

function trendStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function buildEmptyTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): Array<{
  timestampMs: number;
  views: number;
  visitors: number;
}> {
  const starts: number[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );
  const hardLimit = 2000;
  for (let index = 0; index < hardLimit && current <= end; index += 1) {
    starts.push(current);
    let next = addZonedInterval(current, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + trendStepMs(window.interval);
    }
    current = next;
  }

  const stride = Math.max(
    1,
    Math.ceil(starts.length / MAX_TREND_PLACEHOLDER_POINTS),
  );
  const points: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }> = [];

  for (let index = 0; index < starts.length; index += stride) {
    const timestampMs = starts[index] ?? 0;
    points.push({
      timestampMs,
      views: 0,
      visitors: 0,
    });
  }

  const lastTimestampMs = starts[starts.length - 1] ?? 0;
  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      views: 0,
      visitors: 0,
    });
  }

  return points;
}

function normalizeTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
  points: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }>,
): Array<{
  timestampMs: number;
  views: number;
  visitors: number;
}> {
  const byBucket = new Map<number, { views: number; visitors: number }>();
  const start = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);

  for (const point of points) {
    const bucket = startOfZonedInterval(
      Number(point.timestampMs ?? 0),
      window.interval,
      window.timeZone,
    );
    if (!Number.isFinite(bucket) || bucket < start || bucket > end) {
      continue;
    }
    const prev = byBucket.get(bucket) ?? { views: 0, visitors: 0 };
    byBucket.set(bucket, {
      views: prev.views + Math.max(0, Number(point.views ?? 0)),
      visitors: prev.visitors + Math.max(0, Number(point.visitors ?? 0)),
    });
  }

  const normalized: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }> = [];
  const hardLimit = 2000;
  for (
    let index = 0, bucket = start;
    index < hardLimit && bucket <= end;
    index += 1
  ) {
    const value = byBucket.get(bucket);
    normalized.push({
      timestampMs: bucket,
      views: value?.views ?? 0,
      visitors: value?.visitors ?? 0,
    });
    let next = addZonedInterval(bucket, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= bucket) {
      next = bucket + trendStepMs(window.interval);
    }
    bucket = next;
  }

  return normalized;
}

function metricCellBorderClasses(index: number): string {
  // Mobile (1-col): top border for all except first
  const mobileHasTop = index >= 1;
  // md (2-col): left border on odd indices, top border for row 2+
  const mdHasLeft = index % 2 !== 0;
  const mdHasTop = index >= 2;
  // lg (3-col): left border on col 2/3, top border for row 2+
  const lgHasLeft = index % 3 !== 0;
  const lgHasTop = index >= 3;

  return cn(
    mobileHasTop ? "border-t" : "",
    // md (2-col): reset mobile top for row 2+, apply left + top
    mdHasTop ? "md:border-t" : "md:border-t-0",
    mdHasLeft ? "md:border-l" : "md:border-l-0",
    // lg (3-col): override md borders
    lgHasTop ? "lg:border-t" : "lg:border-t-0",
    lgHasLeft ? "lg:border-l" : "lg:border-l-0",
  );
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null, lowerIsBetter = false): string {
  if (value === null) return "text-muted-foreground";
  const isImprovement = lowerIsBetter ? value <= 0 : value >= 0;
  return isImprovement ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({
  value,
  lowerIsBetter = false,
}: {
  value: number | null;
  lowerIsBetter?: boolean;
}) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value, lowerIsBetter)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

interface MetricAreaPoint {
  timestampMs: number;
  value: number;
}

type PageCardTab = "path" | "query" | "title" | "hostname" | "entry" | "exit";
type PageCardSortKey = "views" | "visitors";
type PageCardNavigableTab = "path" | "query" | "hostname" | "entry" | "exit";
type PageCardDetailTab = "path" | "entry" | "exit";
type SourceCardTab = "domain" | "link" | "channel";
type OverviewPagesSectionCardKind = "page" | "source" | "client" | "geo";
type ClientDimensionCardTab =
  | "browser"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";
type GeoDimensionCardTab =
  | "country"
  | "region"
  | "city"
  | "continent"
  | "timezone"
  | "organization";
type GeoLocationTab = Extract<
  GeoDimensionCardTab,
  "country" | "region" | "city"
>;
type OverviewCardTabCache<T extends string> = Record<T, OverviewTabRows | null>;

export interface OverviewPagesSectionCardData {
  page: {
    path: OverviewTabRows;
    query: OverviewTabRows;
    title: OverviewTabRows;
    hostname: OverviewTabRows;
    entry: OverviewTabRows;
    exit: OverviewTabRows;
  };
  source: {
    domain: OverviewTabRows;
    link: OverviewTabRows;
    channel?: OverviewTabRows;
  };
  client: {
    browser: OverviewTabRows;
    osVersion: OverviewTabRows;
    deviceType: OverviewTabRows;
    language: OverviewTabRows;
    screenSize: OverviewTabRows;
  };
  geo: {
    country: OverviewTabRows;
    region: OverviewTabRows;
    city: OverviewTabRows;
    continent: OverviewTabRows;
    timezone: OverviewTabRows;
    organization: OverviewTabRows;
  };
}

interface PageCardTabMeta {
  label: string;
  columnLabel: string;
  primaryMetricLabel?: string;
  mono: boolean;
  showIcon: boolean;
}

type PageCardTabFetcher = (
  siteId: string,
  window: TimeWindow,
  filters: FilterDocument,
) => Promise<OverviewTabRows>;

type PageCardTargetUrlResolver = (params: {
  tab: PageCardTab;
  value: string;
  unknownLabel: string;
  fallbackHostname: string;
}) => string | null;
type PageCardDetailHrefResolver = (params: {
  tab: PageCardDetailTab;
  value: string;
  unknownLabel: string;
  basePath: string;
}) => string | null;
type PageCardDetailClickResolver = (params: {
  tab: PageCardDetailTab;
  value: string;
  unknownLabel: string;
  basePath: string;
}) => void;

interface PageCardRow {
  key: string;
  label: string;
  displayLabel?: string;
  rawLabel?: string;
  views: number;
  visitors: number;
  mono: boolean;
  iconName?: string | null;
  filterValue?: string;
  regionBreadcrumb?: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    countryCode: string;
    stateCode: string;
    hideRegion: boolean;
  };
  cityBreadcrumb?: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    cityLabel: string;
    countryCode: string;
    stateCode: string;
    cityNameDefault: string;
    hideRegion: boolean;
    hideCity: boolean;
  };
}

interface SourceCardRow {
  key: string;
  label: string;
  displayLabel?: string;
  filterValue: string;
  targetUrl: string | null;
  views: number;
  visitors: number;
  mono: boolean;
  channelId?: TrafficChannelId;
}

const ALL_PAGE_CARD_TABS: PageCardTab[] = [
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
];
const PAGE_CARD_TABS: PageCardTab[] = [
  "path",
  "title",
  "hostname",
  "entry",
  "exit",
];
const SOURCE_CARD_TABS: SourceCardTab[] = ["domain", "link", "channel"];
const PAGE_CARD_NAVIGABLE_TAB_LIST: PageCardNavigableTab[] = [
  "path",
  "hostname",
  "entry",
  "exit",
];
const PAGE_CARD_DETAIL_TAB_LIST: PageCardDetailTab[] = [
  "path",
  "entry",
  "exit",
];
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const PAGE_CARD_FILTER_CONTROL_BY_TAB: Record<
  PageCardTab,
  DashboardFilterControlKey
> = {
  path: "path",
  query: "query",
  title: "title",
  hostname: "hostname",
  entry: "entry",
  exit: "exit",
};
const SOURCE_CARD_FILTER_CONTROL_BY_TAB: Record<
  SourceCardTab,
  DashboardFilterControlKey
> = {
  domain: "sourceDomain",
  link: "sourceLink",
  channel: "channel",
};
const CLIENT_DIMENSION_CARD_TABS: ClientDimensionCardTab[] = [
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
];
const GEO_DIMENSION_CARD_TABS: GeoDimensionCardTab[] = [
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
];
const CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB: Record<
  ClientDimensionCardTab,
  DashboardFilterControlKey
> = {
  browser: "clientBrowser",
  osVersion: "clientOsVersion",
  deviceType: "clientDeviceType",
  language: "clientLanguage",
  screenSize: "clientScreenSize",
};
const GEO_AUX_FILTER_CONTROL_BY_TAB: Record<
  Exclude<GeoDimensionCardTab, GeoLocationTab>,
  DashboardFilterControlKey
> = {
  continent: "geoContinent",
  timezone: "geoTimezone",
  organization: "geoOrganization",
};
const DIRECT_REFERRER_FILTER_VALUE = "__direct__";
const GEO_REGION_VALUE_SEPARATOR = "::";

function createOverviewCardTabCache<T extends string>(
  tabs: readonly T[],
): OverviewCardTabCache<T> {
  return tabs.reduce((acc, tab) => {
    acc[tab] = null;
    return acc;
  }, {} as OverviewCardTabCache<T>);
}

function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

function toAbsoluteHttpsUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      return new URL(raw).toString();
    }
    if (raw.startsWith("//")) {
      return new URL(`https:${raw}`).toString();
    }
    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

function resolveFaviconUrlForLabel(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.startsWith("/")) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      const parsed = new URL(raw);
      return `${parsed.origin}/favicon.ico`;
    }
    if (raw.startsWith("//")) {
      const parsed = new URL(`https:${raw}`);
      return `${parsed.origin}/favicon.ico`;
    }
    const hostname = sanitizeHostname(raw);
    if (!hostname) return null;
    const parsed = new URL(`https://${hostname}`);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLabelLetter(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function extractGeoCountryCodeFromFilterValue(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const country = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())[0]
    ?.toUpperCase();
  if (!country) return null;
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

export function parseOverviewCardFilters(
  searchParams: URLSearchParams,
): FilterDocument {
  return parseFilterParams(searchParams, analyticsFilterRegistry);
}

function isGeoLocationTab(tab: GeoDimensionCardTab): tab is GeoLocationTab {
  return tab === "country" || tab === "region" || tab === "city";
}

function canonicalizeGeoFilterValue(
  raw: string | null | undefined,
): string | null {
  return canonicalizeGeoLocationValue(raw);
}

function resolveGeoLocationHighlightValue(
  tab: GeoLocationTab,
  geoFilterValue: string | null,
): string | null {
  if (!geoFilterValue) return null;
  const normalized = canonicalizeGeoFilterValue(geoFilterValue);
  if (!normalized) return null;
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());
  if (tab === "country") {
    return segments[0] || null;
  }
  if (tab === "region") {
    if (segments.length < 3) return null;
    return `${segments[0]}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments[2]}`;
  }
  if (segments.length < 4) return null;
  return `${segments[0]}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments[2]}${GEO_REGION_VALUE_SEPARATOR}${segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR)}`;
}

function resolveGeoRegionBreadcrumbData(
  value: string,
  locale: Locale,
  unknownLabel: string,
): {
  displayLabel: string;
  filterValue: string;
  breadcrumb: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    countryCode: string;
    stateCode: string;
    hideRegion: boolean;
  };
} {
  const normalized = value.trim();
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());
  const rawCountry = segments[0] || "";
  const rawStateCode = segments.length >= 3 ? segments[1] || "" : "";
  const rawStateName =
    segments.length >= 3
      ? segments.slice(2).join(GEO_REGION_VALUE_SEPARATOR).trim()
      : segments.length >= 2
        ? segments[1] || ""
        : normalized;
  const hasRegion = Boolean(rawStateCode.trim() || rawStateName.trim());
  const countryCode = rawCountry.toUpperCase();
  const effectiveStateCode = rawStateCode.trim() || rawStateName.trim();
  const effectiveStateName = rawStateName.trim() || effectiveStateCode;

  const regionLabel = normalizeDimensionLabel(rawStateName, unknownLabel);
  const { label: countryLabel, code } = resolveCountryLabel(
    rawCountry,
    locale,
    unknownLabel,
  );
  const flagCode = resolveCountryFlagCode(code, locale);
  const countryIconName = flagCode
    ? `flagpack:${flagCode.toLowerCase()}`
    : null;

  return {
    displayLabel: hasRegion ? `${countryLabel} > ${regionLabel}` : countryLabel,
    filterValue: hasRegion
      ? buildRegionLocationValue(
          countryCode,
          effectiveStateCode,
          effectiveStateName,
        )
      : countryCode || countryLabel,
    breadcrumb: {
      countryLabel,
      countryIconName,
      regionLabel,
      countryCode,
      stateCode: rawStateCode,
      hideRegion: !hasRegion,
    },
  };
}

function resolveGeoCityBreadcrumbData(
  value: string,
  locale: Locale,
  unknownLabel: string,
): {
  displayLabel: string;
  filterValue: string;
  breadcrumb: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    cityLabel: string;
    countryCode: string;
    stateCode: string;
    cityNameDefault: string;
    hideRegion: boolean;
    hideCity: boolean;
  } | null;
} {
  const normalized = value.trim();
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());

  if (segments.length < 3) {
    const cityLabel = normalizeDimensionLabel(normalized, unknownLabel);
    return {
      displayLabel: cityLabel,
      filterValue: cityLabel,
      breadcrumb: null,
    };
  }

  const rawCountry = segments[0] || "";
  const rawStateCode = segments.length >= 4 ? segments[1] || "" : "";
  const rawStateName =
    segments.length >= 4 ? segments[2] || "" : segments[1] || "";
  const rawCity =
    segments.length >= 4
      ? segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR).trim()
      : segments.slice(2).join(GEO_REGION_VALUE_SEPARATOR).trim();
  const hasRegion = Boolean(rawStateCode.trim() || rawStateName.trim());
  const hideRegion = !hasRegion;
  const regionLabel = normalizeDimensionLabel(rawStateName, unknownLabel);
  const cityLabel = normalizeDimensionLabel(rawCity, unknownLabel);
  const countryCode = rawCountry.toUpperCase();
  const effectiveStateCode = rawStateCode.trim() || rawStateName.trim();
  const effectiveStateName = rawStateName.trim() || effectiveStateCode;
  const effectiveCity = rawCity.trim() || cityLabel;
  const { label: countryLabel, code } = resolveCountryLabel(
    rawCountry,
    locale,
    unknownLabel,
  );
  const flagCode = resolveCountryFlagCode(code, locale);
  const countryIconName = flagCode
    ? `flagpack:${flagCode.toLowerCase()}`
    : null;
  const englishCountryLabel = resolveCountryLabel(
    rawCountry,
    "en",
    unknownLabel,
  ).label;
  const hideCity =
    isSameGeoLabel(rawStateName, rawCity) ||
    (hideRegion &&
      (isSameGeoLabel(countryLabel, cityLabel) ||
        isSameGeoLabel(englishCountryLabel, cityLabel)));

  return {
    displayLabel: hideRegion
      ? hideCity
        ? countryLabel
        : `${countryLabel} > ${cityLabel}`
      : hideCity
        ? `${countryLabel} > ${regionLabel}`
        : `${countryLabel} > ${regionLabel} > ${cityLabel}`,
    filterValue:
      countryCode && effectiveCity
        ? buildLocalityLocationValue(
            countryCode,
            effectiveStateCode,
            effectiveStateName,
            effectiveCity,
          )
        : effectiveCity,
    breadcrumb: {
      countryLabel,
      countryIconName,
      regionLabel,
      cityLabel,
      countryCode,
      stateCode: rawStateCode,
      cityNameDefault: effectiveCity,
      hideRegion,
      hideCity,
    },
  };
}

function buildGeoPagePath(pathname: string): string {
  const normalized = pathname.trim().replace(/\/+$/, "");
  if (!normalized) return "/geo";
  if (normalized.endsWith("/geo")) return normalized;
  return `${normalized}/geo`;
}

function buildPagesPagePath(pathname: string): string {
  const normalized = pathname.trim().replace(/\/+$/, "");
  if (!normalized) return "/pages";
  if (normalized.endsWith("/pages")) return normalized;
  if (normalized.endsWith("/pages/detail")) {
    return normalized.replace(/\/detail$/, "");
  }
  return `${normalized}/pages`;
}

function isPageCardDetailTab(tab: PageCardTab): tab is PageCardDetailTab {
  return tab === "path" || tab === "entry" || tab === "exit";
}

function resolvePageCardDetailHref(params: {
  tab?: PageCardDetailTab;
  basePath: string;
  value: string;
  unknownLabel: string;
}): string | null {
  const raw = params.value.trim();
  if (raw.length === 0 || raw === params.unknownLabel) return null;

  const normalizedPath = normalizePagePath(raw);
  if (!normalizedPath) return null;

  return buildPageDetailHref(params.basePath, normalizedPath);
}

function resolveGeoLocationQueryValue(
  tab: GeoDimensionCardTab,
  row: PageCardRow,
  unknownLabel: string,
): string | null {
  if (tab !== "country" && tab !== "region" && tab !== "city") return null;

  const unknown = normalizeGeoTranslationLookupValue(unknownLabel);
  const raw = String(row.rawLabel || row.label || "").trim();
  if (!raw) return null;

  const normalizedRaw = normalizeGeoTranslationLookupValue(raw);
  if (normalizedRaw === unknown) return null;

  const segments = raw
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (tab === "country") {
    const country = (segments[0] || raw).trim().toUpperCase();
    if (!country) return null;
    if (normalizeGeoTranslationLookupValue(country) === unknown) return null;
    return country;
  }

  if (tab === "region") {
    if (segments.length >= 3) {
      const regionName = segments
        .slice(2)
        .join(GEO_REGION_VALUE_SEPARATOR)
        .trim();
      return (
        buildRegionLocationValue(
          segments[0] || "",
          segments[1] || regionName,
          regionName || segments[1] || "",
        ) || null
      );
    }
    const breadcrumb = row.regionBreadcrumb;
    if (!breadcrumb) return null;
    if (breadcrumb.hideRegion) {
      const country = breadcrumb.countryCode.trim().toUpperCase();
      return country || null;
    }
    if (
      normalizeGeoTranslationLookupValue(breadcrumb.regionLabel) === unknown ||
      normalizeGeoTranslationLookupValue(breadcrumb.countryCode) === unknown
    ) {
      return null;
    }
    return (
      buildRegionLocationValue(
        breadcrumb.countryCode,
        breadcrumb.stateCode,
        breadcrumb.regionLabel,
      ) || null
    );
  }

  if (segments.length >= 4) {
    const cityName = segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR).trim();
    return (
      buildLocalityLocationValue(
        segments[0] || "",
        segments[1] || segments[2] || "",
        segments[2] || segments[1] || "",
        cityName,
      ) || null
    );
  }

  const breadcrumb = row.cityBreadcrumb;
  if (!breadcrumb) return null;
  if (breadcrumb.hideRegion) {
    const country = breadcrumb.countryCode.trim().toUpperCase();
    if (!country) return null;
    if (
      normalizeGeoTranslationLookupValue(breadcrumb.cityNameDefault) === unknown
    ) {
      return country;
    }
    if (breadcrumb.hideCity) return country;
    return (
      buildLocalityLocationValue(country, "", "", breadcrumb.cityNameDefault) ||
      country
    );
  }
  if (
    normalizeGeoTranslationLookupValue(breadcrumb.cityNameDefault) ===
      unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.regionLabel) === unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.countryCode) === unknown
  ) {
    return null;
  }
  return (
    buildLocalityLocationValue(
      breadcrumb.countryCode,
      breadcrumb.stateCode,
      breadcrumb.regionLabel,
      breadcrumb.cityNameDefault,
    ) || null
  );
}

function resolveGeoDimensionRowRawValue(item: {
  label?: string;
  value?: string;
}): string {
  const rawValue = typeof item.value === "string" ? item.value.trim() : "";
  if (rawValue) return rawValue;
  return String(item.label || "").trim();
}

const UMAMI_BROWSER_ICON_PREFIX = "umami-browser:";
const UMAMI_OS_ICON_PREFIX = "umami-os:";
const UMAMI_BROWSER_ICON_DIR = "/images/browser";
const UMAMI_OS_ICON_DIR = "/images/os";
const UMAMI_ICON_FALLBACK = "unknown";
const UMAMI_BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
const UMAMI_OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);

function resolveBrowserLogoIconName(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;

  let iconKey = UMAMI_ICON_FALLBACK;

  if (
    normalized.includes("android webview") ||
    normalized.includes("android-webview")
  ) {
    iconKey = "android-webview";
  } else if (normalized.includes("chromium-webview")) {
    iconKey = "chromium-webview";
  } else if (normalized.includes("edge chromium")) {
    iconKey = "edge-chromium";
  } else if (normalized.includes("edge ios")) {
    iconKey = "edge-ios";
  } else if (normalized.includes("edge")) {
    iconKey = "edge-chromium";
  } else if (
    normalized.includes("chrome ios") ||
    normalized.includes("crios")
  ) {
    iconKey = "crios";
  } else if (
    normalized.includes("firefox ios") ||
    normalized.includes("fxios")
  ) {
    iconKey = "fxios";
  } else if (normalized.includes("ios webview")) {
    iconKey = "ios-webview";
  } else if (normalized === "ios") {
    iconKey = "ios";
  } else if (normalized.includes("internet explorer") || normalized === "ie") {
    iconKey = "ie";
  } else if (normalized.includes("arc")) {
    iconKey = "arc";
  } else if (normalized.includes("opera mini")) {
    iconKey = "opera-mini";
  } else if (normalized.includes("opera gx")) {
    iconKey = "opera-gx";
  } else if (normalized.includes("opera")) {
    iconKey = "opera";
  } else if (normalized.includes("samsung")) {
    iconKey = "samsung";
  } else if (
    normalized.includes("ucbrowser") ||
    normalized.includes("uc browser")
  ) {
    iconKey = "uc";
  } else if (
    normalized.includes("qqbrowser") ||
    normalized.includes("qq browser") ||
    normalized === "qq"
  ) {
    iconKey = "qq";
  } else if (normalized.includes("duckduckgo")) {
    iconKey = "duckduckgo";
  } else if (normalized.includes("wechat")) {
    iconKey = "wechat";
  } else if (normalized.includes("vivaldi")) {
    iconKey = "vivaldi";
  } else if (normalized.includes("huawei browser") || normalized === "huawei") {
    iconKey = "huawei";
  } else if (
    normalized.includes("honor") ||
    normalized.includes("vivo browser") ||
    normalized.includes("heytap")
  ) {
    iconKey = "android";
  } else if (normalized.includes("android")) {
    iconKey = "android";
  } else if (normalized.includes("miui")) {
    iconKey = "miui";
  } else if (
    normalized.includes("waterfox") ||
    normalized.includes("librewolf") ||
    normalized.includes("iceweasel") ||
    normalized.includes("icecat") ||
    normalized.includes("icedragon") ||
    normalized.includes("fennec") ||
    normalized.includes("seamonkey") ||
    normalized.includes("pale moon")
  ) {
    iconKey = "firefox";
  } else if (normalized.includes("firefox")) {
    iconKey = "firefox";
  } else if (normalized.includes("safari")) {
    iconKey = "safari";
  } else if (
    normalized.includes("bing") ||
    normalized.includes("ecosia") ||
    normalized === "gsa" ||
    normalized.includes("coc coc") ||
    normalized.includes("coccoc") ||
    normalized.includes("whale") ||
    normalized.includes("naver") ||
    normalized.includes("sogou") ||
    normalized.includes("maxthon") ||
    normalized.includes("puffin") ||
    normalized.includes("quark")
  ) {
    iconKey = "chrome";
  } else if (normalized.includes("chrome") || normalized.includes("chromium")) {
    iconKey = "chrome";
  } else if (normalized.includes("brave")) {
    iconKey = "brave";
  } else if (normalized.includes("facebook")) {
    iconKey = "facebook";
  } else if (normalized.includes("instagram")) {
    iconKey = "instagram";
  } else if (normalized.includes("kakao")) {
    iconKey = "kakaotalk";
  } else if (normalized.includes("yandex")) {
    iconKey = "yandexbrowser";
  } else if (normalized.includes("silk")) {
    iconKey = "silk";
  } else if (normalized.includes("searchbot")) {
    iconKey = "searchbot";
  } else if (normalized.includes("curl")) {
    iconKey = "curl";
  } else if (normalized.includes("aol")) {
    iconKey = "aol";
  } else if (normalized.includes("beaker")) {
    iconKey = "beaker";
  } else if (normalized.includes("blackberry") || normalized.includes("bb10")) {
    iconKey = "blackberry";
  }

  return `${UMAMI_BROWSER_ICON_PREFIX}${iconKey}`;
}

function resolveOsLogoIconName(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;

  let iconKey = UMAMI_ICON_FALLBACK;

  if (normalized.includes("windows 11")) {
    iconKey = "windows-11";
  } else if (normalized.includes("windows 10")) {
    iconKey = "windows-10";
  } else if (normalized.includes("windows 8.1")) {
    iconKey = "windows-8-1";
  } else if (normalized.includes("windows 8")) {
    iconKey = "windows-8";
  } else if (normalized.includes("windows 7")) {
    iconKey = "windows-7";
  } else if (normalized.includes("windows vista")) {
    iconKey = "windows-vista";
  } else if (normalized.includes("windows xp")) {
    iconKey = "windows-xp";
  } else if (normalized.includes("windows 2000")) {
    iconKey = "windows-2000";
  } else if (normalized.includes("windows 98")) {
    iconKey = "windows-98";
  } else if (normalized.includes("windows 95")) {
    iconKey = "windows-95";
  } else if (normalized.includes("windows me")) {
    iconKey = "windows-me";
  } else if (normalized.includes("windows mobile")) {
    iconKey = "windows-mobile";
  } else if (normalized.includes("windows server 2003")) {
    iconKey = "windows-server-2003";
  } else if (normalized.startsWith("windows")) {
    iconKey = "windows-10";
  } else if (
    normalized.startsWith("mac") ||
    normalized.startsWith("os x") ||
    normalized.startsWith("darwin")
  ) {
    iconKey = "mac-os";
  } else if (normalized.startsWith("ios")) {
    iconKey = "ios";
  } else if (normalized.startsWith("android")) {
    iconKey = "android-os";
  } else if (
    normalized.startsWith("chrome os") ||
    normalized.startsWith("chromium os")
  ) {
    iconKey = "chrome-os";
  } else if (normalized.startsWith("amazon os")) {
    iconKey = "amazon-os";
  } else if (normalized.startsWith("blackberry")) {
    iconKey = "blackberry-os";
  } else if (normalized.includes("openbsd")) {
    iconKey = "open-bsd";
  } else if (normalized.includes("qnx")) {
    iconKey = "qnx";
  } else if (normalized.includes("os/2") || normalized.includes("os 2")) {
    iconKey = "os-2";
  } else if (normalized.includes("beos")) {
    iconKey = "beos";
  } else if (normalized.includes("sun os") || normalized.includes("sunos")) {
    iconKey = "sun-os";
  } else if (
    normalized.includes("linux") ||
    normalized.startsWith("ubuntu") ||
    normalized.startsWith("debian") ||
    normalized.startsWith("fedora") ||
    normalized.startsWith("centos")
  ) {
    iconKey = "linux";
  }

  return `${UMAMI_OS_ICON_PREFIX}${iconKey}`;
}

function resolveUmamiIconSource(
  iconName: string,
): { src: string; fallbackSrc: string; isAppleGlyph?: boolean } | null {
  if (iconName.startsWith(UMAMI_BROWSER_ICON_PREFIX)) {
    const iconKey = iconName.slice(UMAMI_BROWSER_ICON_PREFIX.length);
    return {
      src: `${UMAMI_BROWSER_ICON_DIR}/${iconKey}.svg`,
      fallbackSrc: `${UMAMI_BROWSER_ICON_DIR}/${UMAMI_ICON_FALLBACK}.svg`,
      isAppleGlyph: UMAMI_BROWSER_APPLE_ICON_KEYS.has(iconKey),
    };
  }

  if (iconName.startsWith(UMAMI_OS_ICON_PREFIX)) {
    const iconKey = iconName.slice(UMAMI_OS_ICON_PREFIX.length);
    return {
      src: `${UMAMI_OS_ICON_DIR}/${iconKey}.svg`,
      fallbackSrc: `${UMAMI_OS_ICON_DIR}/${UMAMI_ICON_FALLBACK}.svg`,
      isAppleGlyph: UMAMI_OS_APPLE_ICON_KEYS.has(iconKey),
    };
  }

  return null;
}

function LabelWithLeadingIcon({
  label,
  iconName,
}: {
  label: string;
  iconName?: string | null;
}) {
  if (!iconName) {
    return <span className="break-words">{label}</span>;
  }

  const isFlag = iconName.startsWith("flagpack:");
  const umamiIcon = resolveUmamiIconSource(iconName);

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center justify-center">
        <span className="inline-flex size-4 items-center justify-center">
          {isFlag ? (
            <Icon
              icon={iconName}
              style={{
                width: 16,
                height: 12,
              }}
              className="block shrink-0"
            />
          ) : umamiIcon ? (
            <img
              src={umamiIcon.src}
              alt=""
              width={16}
              height={16}
              className={`block h-4 w-4 shrink-0 ${umamiIcon.isAppleGlyph ? "dark:invert" : ""}`}
              loading="lazy"
              decoding="async"
              onError={(event) => {
                const target = event.currentTarget;
                if (target.dataset.fallbackApplied === "true") return;
                target.dataset.fallbackApplied = "true";
                target.src = umamiIcon.fallbackSrc;
              }}
            />
          ) : null}
        </span>
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
}

function ChannelIcon({ channel }: { channel: TrafficChannelId }) {
  const className = "size-4 text-muted-foreground";
  switch (channel) {
    case "organic_search":
      return <RiSearchLine className={className} />;
    case "social":
      return <RiShareForwardLine className={className} />;
    case "paid_search":
      return <RiMoneyDollarCircleLine className={className} />;
    case "paid_social":
      return <RiMegaphoneLine className={className} />;
    case "display":
      return <RiAdvertisementLine className={className} />;
    case "email":
      return <RiMailLine className={className} />;
    case "affiliate":
    case "referral":
      return <RiLinksLine className={className} />;
    case "campaign":
      return <RiPriceTag3Line className={className} />;
    case "direct":
      return <RiCursorLine className={className} />;
    case "other":
      return <RiQuestionLine className={className} />;
  }
}

function normalizeDimensionLabel(
  value: string,
  unknownLabel: string,
  options?: { screenSize?: boolean },
): string {
  const normalized = value.trim();
  if (!normalized) return unknownLabel;
  if (options?.screenSize && (normalized === "0x0" || normalized === "0X0")) {
    return unknownLabel;
  }
  return normalized;
}

const timezoneNameFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timezonePartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimezoneNameFormatter(
  locale: Locale,
  timeZone: string,
): Intl.DateTimeFormat | null {
  const cacheKey = `${locale}::${timeZone}`;
  const cached = timezoneNameFormatterCache.get(cacheKey);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      timeZoneName: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timezoneNameFormatterCache.set(cacheKey, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function getTimezonePartsFormatter(
  timeZone: string,
): Intl.DateTimeFormat | null {
  const cached = timezonePartsFormatterCache.get(timeZone);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timezonePartsFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function resolveTimezoneOffsetMinutes(
  timeZone: string,
  timestampMs: number,
): number | null {
  const formatter = getTimezonePartsFormatter(timeZone);
  if (!formatter) return null;

  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = formatter.formatToParts(date);
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  let second = NaN;

  for (const part of parts) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === "year") year = value;
    else if (part.type === "month") month = value;
    else if (part.type === "day") day = value;
    else if (part.type === "hour") hour = value;
    else if (part.type === "minute") minute = value;
    else if (part.type === "second") second = value;
  }

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - timestampMs) / 60000);
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function formatLocalTimeDeltaLabel(
  deltaMinutes: number,
  template: string,
): string {
  const sign = deltaMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(deltaMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  const delta = `${sign}${hours}:${minutes}`;
  return formatI18nTemplate(template, { delta });
}

function resolveTimezoneDisplayLabel(params: {
  value: string;
  locale: Locale;
  unknownLabel: string;
  timestampMs: number;
  timezoneDeltaVsLocal: string;
}): string {
  const normalized = normalizeDimensionLabel(params.value, params.unknownLabel);
  if (normalized === params.unknownLabel) return normalized;

  const baseTimestamp =
    Number.isFinite(params.timestampMs) && params.timestampMs > 0
      ? params.timestampMs
      : Date.now();
  const date = new Date(baseTimestamp);
  if (!Number.isFinite(date.getTime())) return normalized;

  const nameFormatter = getTimezoneNameFormatter(params.locale, normalized);
  const localizedName =
    nameFormatter
      ?.formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim() || null;
  const offsetMinutes = resolveTimezoneOffsetMinutes(
    normalized,
    date.getTime(),
  );

  if (!localizedName && offsetMinutes === null) return normalized;
  if (offsetMinutes !== null) {
    const localOffsetMinutes = -date.getTimezoneOffset();
    const localDelta = offsetMinutes - localOffsetMinutes;
    const prefix = localizedName || normalized;
    return `${prefix} (${formatUtcOffset(offsetMinutes)}, ${formatLocalTimeDeltaLabel(localDelta, params.timezoneDeltaVsLocal)})`;
  }
  if (localizedName) return localizedName;
  return normalized;
}

function DomainOrUrlIcon({
  label,
  unknownLabel,
}: {
  label: string;
  unknownLabel: string;
}) {
  const src = useMemo(() => {
    const normalized = label.trim();
    if (normalized.length === 0 || normalized === unknownLabel) return null;
    return resolveFaviconUrlForLabel(normalized);
  }, [label, unknownLabel]);
  const [iconLoaded, setIconLoaded] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconLoaded(false);
    setIconFailed(false);

    if (!src) return;

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setIconLoaded(true);
    };
    image.onerror = () => {
      if (!active) return;
      setIconFailed(true);
    };
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  const showFavicon = Boolean(src) && iconLoaded && !iconFailed;
  const fallbackValue = label === unknownLabel ? "" : label;

  return (
    <AutoTransition
      type="fade"
      duration={0.18}
      initial={false}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {showFavicon ? (
        <img
          key="favicon"
          src={src!}
          alt=""
          width={16}
          height={16}
          className="block size-4 shrink-0 object-contain"
        />
      ) : (
        <span
          key="fallback"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] bg-card text-[10px] leading-none font-medium text-muted-foreground"
        >
          {leadingLabelLetter(fallbackValue)}
        </span>
      )}
    </AutoTransition>
  );
}

function LabelWithOptionalIcon({
  label,
  showIcon,
  unknownLabel,
}: {
  label: string;
  showIcon: boolean;
  unknownLabel: string;
}) {
  if (!showIcon) {
    return <span className="break-words">{label}</span>;
  }

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center">
        <DomainOrUrlIcon label={label} unknownLabel={unknownLabel} />
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
}

function resolvePageCardTargetUrl(params: {
  tab: PageCardTab;
  value: string;
  unknownLabel: string;
  fallbackHostname: string;
}): string | null {
  const { tab, value, unknownLabel, fallbackHostname } = params;
  const raw = value.trim();
  if (raw.length === 0 || raw === unknownLabel) {
    return null;
  }

  if (tab === "hostname") {
    return toAbsoluteHttpsUrl(raw);
  }

  if (tab === "path" || tab === "entry" || tab === "exit") {
    if (raw.startsWith("/")) {
      const host = sanitizeHostname(fallbackHostname);
      if (host.length === 0) return null;
      try {
        return new URL(raw, `https://${host}`).toString();
      } catch {
        return null;
      }
    }
    return toAbsoluteHttpsUrl(raw);
  }

  return null;
}

function useChartVisibility(rootMargin = "120px 0px") {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasMeasuredVisibility, setHasMeasuredVisibility] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      setHasMeasuredVisibility(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        setIsVisible(nextVisible);
        setHasMeasuredVisibility(true);
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  return {
    containerRef,
    isVisible,
    hasMeasuredVisibility,
  };
}

function useAnimationOnChartSwitch({
  switchKey,
  hasData,
  isVisible,
  hasMeasuredVisibility,
}: {
  switchKey: string;
  hasData: boolean;
  isVisible: boolean;
  hasMeasuredVisibility: boolean;
}): boolean {
  const appliedKeyRef = useRef<string | null>(null);
  const animationEnabledRef = useRef(false);

  if (appliedKeyRef.current !== switchKey && hasMeasuredVisibility) {
    appliedKeyRef.current = switchKey;
    animationEnabledRef.current = hasData && isVisible;
  }

  if (appliedKeyRef.current !== switchKey) {
    return hasData && isVisible;
  }

  return animationEnabledRef.current;
}

function MetricAreaMap({
  points,
  color,
  locale,
  label,
  formatValue,
  animationKey,
}: {
  points: MetricAreaPoint[];
  color: string;
  locale: Locale;
  label: string;
  formatValue: (value: number) => string;
  animationKey: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility("80px 0px");
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );
  const chartData = useMemo(() => {
    const normalized = points.map((point, index) => ({
      index,
      timestampMs: Number.isFinite(point.timestampMs) ? point.timestampMs : 0,
      value: Number.isFinite(point.value) ? Math.max(0, point.value) : 0,
    }));

    if (normalized.length >= 2) return normalized;
    if (normalized.length === 1) {
      const first = normalized[0] ?? { index: 0, value: 0, timestampMs: 0 };
      return [
        first,
        {
          index: 1,
          value: first.value,
          timestampMs: first.timestampMs + 1,
        },
      ];
    }
    return [
      { index: 0, value: 0, timestampMs: 0 },
      { index: 1, value: 0, timestampMs: 1 },
    ];
  }, [points]);
  const areaChartSwitchKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${label}:${animationKey}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [animationKey, chartData, label]);
  const isAreaAnimationActive = useAnimationOnChartSwitch({
    switchKey: areaChartSwitchKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="h-full w-full">
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.36} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <Tooltip
              cursor={{ stroke: color, strokeOpacity: 0.28, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const item = payload[0]?.payload as
                  | { timestampMs?: number; value?: number }
                  | undefined;
                const timestampMs = Number(item?.timestampMs ?? 0);
                const value = Number(item?.value ?? 0);

                return (
                  <div className="rounded-none border border-border/50 bg-background px-2 py-1 text-[11px] shadow-xl">
                    <p className="text-muted-foreground">
                      {dateFormatter.format(new Date(timestampMs))}
                    </p>
                    <p className="font-mono text-foreground">
                      {label}: {formatValue(value)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="linear"
              dataKey="value"
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2, stroke: color, fill: color }}
              isAnimationActive={isAreaAnimationActive}
              animationDuration={isAreaAnimationActive ? 280 : 0}
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-card via-card/80 to-transparent" />
      </div>
    </div>
  );
}

interface OverviewPagesSectionProps extends OverviewClientPageProps {
  filters: FilterDocument;
  loading?: boolean;
  cardDataOverride?: OverviewPagesSectionCardData | null;
  visibleCards?: readonly OverviewPagesSectionCardKind[];
  pageCardTabs?: readonly PageCardTab[];
  pageCardTabMetaOverride?: Partial<
    Record<PageCardTab, Partial<PageCardTabMeta>>
  >;
  pageCardFilterEnabledOverride?: Partial<Record<PageCardTab, boolean>>;
  pageCardNavigableTabs?: readonly PageCardNavigableTab[];
  pageCardDetailTabs?: readonly PageCardDetailTab[];
  pageCardFetchers?: Partial<Record<PageCardTab, PageCardTabFetcher>>;
  sourceCardFetchers?: Partial<Record<SourceCardTab, PageCardTabFetcher>>;
  clientCardFetchers?: Partial<
    Record<ClientDimensionCardTab, PageCardTabFetcher>
  >;
  geoCardFetchers?: Partial<Record<GeoDimensionCardTab, PageCardTabFetcher>>;
  pageCardTargetUrlResolvers?: Partial<
    Record<PageCardTab, PageCardTargetUrlResolver>
  >;
  pageCardDetailHrefResolvers?: Partial<
    Record<PageCardDetailTab, PageCardDetailHrefResolver>
  >;
  pageCardDetailClickResolvers?: Partial<
    Record<PageCardDetailTab, PageCardDetailClickResolver>
  >;
  pageCardShowVisitors?: boolean;
  primaryMetricLabel?: string;
  geoPageBasePathname?: string;
  sectionClassName?: string;
}

export function OverviewPagesSection({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  filters,
  loading = false,
  cardDataOverride,
  visibleCards,
  pageCardTabs,
  pageCardTabMetaOverride,
  pageCardFilterEnabledOverride,
  pageCardNavigableTabs,
  pageCardDetailTabs,
  pageCardFetchers,
  sourceCardFetchers,
  clientCardFetchers,
  geoCardFetchers,
  pageCardTargetUrlResolvers,
  pageCardDetailHrefResolvers,
  pageCardDetailClickResolvers,
  pageCardShowVisitors = true,
  primaryMetricLabel,
  geoPageBasePathname,
  sectionClassName,
}: OverviewPagesSectionProps) {
  const router = useRouter();
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || pathname;
  const { window } = useDashboardQuery();
  const resolvedPageCardTabs = useMemo(
    () => pageCardTabs ?? PAGE_CARD_TABS,
    [pageCardTabs],
  );
  const resolvedVisibleCards = useMemo(
    () =>
      new Set<OverviewPagesSectionCardKind>(
        visibleCards ?? ["page", "source", "client", "geo"],
      ),
    [visibleCards],
  );
  const timezoneReferenceTimestampMs = useMemo(() => {
    const from = Number(window.from ?? 0);
    const to = Number(window.to ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Date.now();
    if (to <= from) return Math.max(0, Math.floor(from));
    return Math.floor(from + (to - from) / 2);
  }, [window.from, window.to]);
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const pageCardFetchersRef = useRef(pageCardFetchers);
  pageCardFetchersRef.current = pageCardFetchers;
  const sourceCardFetchersRef = useRef(sourceCardFetchers);
  sourceCardFetchersRef.current = sourceCardFetchers;
  const clientCardFetchersRef = useRef(clientCardFetchers);
  clientCardFetchersRef.current = clientCardFetchers;
  const geoCardFetchersRef = useRef(geoCardFetchers);
  geoCardFetchersRef.current = geoCardFetchers;
  const [pageCardTabData, setPageCardTabData] = useState<
    OverviewCardTabCache<PageCardTab>
  >(() => createOverviewCardTabCache(ALL_PAGE_CARD_TABS));
  const [sourceCardTabData, setSourceCardTabData] = useState<
    OverviewCardTabCache<SourceCardTab>
  >(() => createOverviewCardTabCache(SOURCE_CARD_TABS));
  const [clientDimensionCardTabData, setClientDimensionCardTabData] = useState<
    OverviewCardTabCache<ClientDimensionCardTab>
  >(() => createOverviewCardTabCache(CLIENT_DIMENSION_CARD_TABS));
  const [geoDimensionCardTabData, setGeoDimensionCardTabData] = useState<
    OverviewCardTabCache<GeoDimensionCardTab>
  >(() => createOverviewCardTabCache(GEO_DIMENSION_CARD_TABS));
  const [pageCardTab, setPageCardTab] = useState<PageCardTab>("path");
  const [sourceCardTab, setSourceCardTab] = useState<SourceCardTab>("domain");
  const [clientDimensionCardTab, setClientDimensionCardTab] =
    useState<ClientDimensionCardTab>("browser");
  const [geoDimensionCardTab, setGeoDimensionCardTab] =
    useState<GeoDimensionCardTab>("country");
  const hasCardDataOverride = Boolean(cardDataOverride);
  const resolvedPageCardTabData = cardDataOverride?.page ?? pageCardTabData;
  const resolvedSourceCardTabData =
    cardDataOverride?.source ?? sourceCardTabData;
  const resolvedSourceCardTabs = useMemo(() => {
    const hasChannelData =
      resolvedSourceCardTabData.channel !== undefined ||
      Boolean(sourceCardFetchers?.channel) ||
      (!hasCardDataOverride && !sourceCardFetchers);
    return hasChannelData
      ? SOURCE_CARD_TABS
      : SOURCE_CARD_TABS.filter((tab) => tab !== "channel");
  }, [
    hasCardDataOverride,
    resolvedSourceCardTabData.channel,
    sourceCardFetchers,
  ]);
  const resolvedClientDimensionCardTabData =
    cardDataOverride?.client ?? clientDimensionCardTabData;
  const resolvedGeoDimensionCardTabData =
    cardDataOverride?.geo ?? geoDimensionCardTabData;
  const activePageCardTabData = resolvedPageCardTabData[pageCardTab];
  const activeSourceCardTabData = resolvedSourceCardTabData[sourceCardTab];
  const activeClientDimensionCardTabData =
    resolvedClientDimensionCardTabData[clientDimensionCardTab];
  const activeGeoDimensionCardTabData =
    resolvedGeoDimensionCardTabData[geoDimensionCardTab];
  const resolvedPageCardNavigableTabs = useMemo(
    () =>
      new Set<PageCardNavigableTab>(
        pageCardNavigableTabs ?? PAGE_CARD_NAVIGABLE_TAB_LIST,
      ),
    [pageCardNavigableTabs],
  );
  const resolvedPageCardDetailTabs = useMemo(
    () =>
      new Set<PageCardDetailTab>(
        pageCardDetailTabs ?? PAGE_CARD_DETAIL_TAB_LIST,
      ),
    [pageCardDetailTabs],
  );
  const pageCardFilterEnabledByTab = useMemo<Record<PageCardTab, boolean>>(
    () => ({
      path: true,
      query: true,
      title: true,
      hostname: true,
      entry: true,
      exit: true,
      ...(pageCardFilterEnabledOverride ?? {}),
    }),
    [pageCardFilterEnabledOverride],
  );

  useEffect(() => {
    if (resolvedPageCardTabs.includes(pageCardTab)) return;
    setPageCardTab(resolvedPageCardTabs[0] ?? "path");
  }, [pageCardTab, resolvedPageCardTabs]);

  useEffect(() => {
    if (resolvedSourceCardTabs.includes(sourceCardTab)) return;
    setSourceCardTab(resolvedSourceCardTabs[0] ?? "domain");
  }, [resolvedSourceCardTabs, sourceCardTab]);

  useEffect(() => {
    if (hasCardDataOverride) return;
    setPageCardTabData(createOverviewCardTabCache(ALL_PAGE_CARD_TABS));
    setSourceCardTabData(createOverviewCardTabCache(SOURCE_CARD_TABS));
    setClientDimensionCardTabData(
      createOverviewCardTabCache(CLIENT_DIMENSION_CARD_TABS),
    );
    setGeoDimensionCardTabData(
      createOverviewCardTabCache(GEO_DIMENSION_CARD_TABS),
    );
  }, [
    filtersKey,
    siteId,
    window.from,
    window.to,
    window.interval,
    window.timeZone,
    hasCardDataOverride,
  ]);

  useEffect(() => {
    if (hasCardDataOverride) return;
    if (activePageCardTabData !== null) return;
    let active = true;

    const loadPageCardTab =
      pageCardFetchersRef.current?.[pageCardTab] ??
      ((
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchOverviewPageCardTab(
          requestedSiteId,
          requestedWindow,
          pageCardTab,
          requestedFilters,
          {
            limit: 100,
          },
        ));

    loadPageCardTab(siteId, window, filters)
      .then((data) => {
        if (!active) return;
        setPageCardTabData((prev) => ({
          ...prev,
          [pageCardTab]: data,
        }));
      })
      .catch(() => {
        if (!active) return;
        setPageCardTabData((prev) => ({
          ...prev,
          [pageCardTab]: [],
        }));
      });

    return () => {
      active = false;
    };
  }, [
    activePageCardTabData,
    filtersKey,
    pageCardTab,
    siteId,
    window.from,
    window.interval,
    window.to,
    window.timeZone,
    hasCardDataOverride,
  ]);

  useEffect(() => {
    if (hasCardDataOverride) return;
    if (!resolvedSourceCardTabs.includes(sourceCardTab)) return;
    if (activeSourceCardTabData !== null) return;
    let active = true;

    const loadSourceCardTab =
      sourceCardFetchersRef.current?.[sourceCardTab] ??
      ((
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchOverviewSourceCardTab(
          requestedSiteId,
          requestedWindow,
          sourceCardTab,
          requestedFilters,
          { limit: 100 },
        ));

    loadSourceCardTab(siteId, window, filters)
      .then((data) => {
        if (!active) return;
        setSourceCardTabData((prev) => ({
          ...prev,
          [sourceCardTab]: data,
        }));
      })
      .catch(() => {
        if (!active) return;
        setSourceCardTabData((prev) => ({
          ...prev,
          [sourceCardTab]: [],
        }));
      });

    return () => {
      active = false;
    };
  }, [
    activeSourceCardTabData,
    filtersKey,
    siteId,
    sourceCardTab,
    resolvedSourceCardTabs,
    window.from,
    window.interval,
    window.to,
    window.timeZone,
    hasCardDataOverride,
  ]);

  useEffect(() => {
    if (hasCardDataOverride) return;
    if (activeClientDimensionCardTabData !== null) return;
    let active = true;

    const loadClientCardTab =
      clientCardFetchersRef.current?.[clientDimensionCardTab] ??
      ((
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchOverviewClientDimensionTab(
          requestedSiteId,
          requestedWindow,
          clientDimensionCardTab,
          requestedFilters,
          { limit: 100 },
        ));

    loadClientCardTab(siteId, window, filters)
      .then((data) => {
        if (!active) return;
        setClientDimensionCardTabData((prev) => ({
          ...prev,
          [clientDimensionCardTab]: data,
        }));
      })
      .catch(() => {
        if (!active) return;
        setClientDimensionCardTabData((prev) => ({
          ...prev,
          [clientDimensionCardTab]: [],
        }));
      });

    return () => {
      active = false;
    };
  }, [
    activeClientDimensionCardTabData,
    clientDimensionCardTab,
    filtersKey,
    siteId,
    window.from,
    window.interval,
    window.to,
    window.timeZone,
    hasCardDataOverride,
  ]);

  useEffect(() => {
    if (hasCardDataOverride) return;
    if (activeGeoDimensionCardTabData !== null) return;
    let active = true;

    const loadGeoCardTab =
      geoCardFetchersRef.current?.[geoDimensionCardTab] ??
      ((
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchOverviewGeoDimensionTab(
          requestedSiteId,
          requestedWindow,
          geoDimensionCardTab,
          requestedFilters,
          { limit: 100 },
        ));

    loadGeoCardTab(siteId, window, filters)
      .then((data) => {
        if (!active) return;
        setGeoDimensionCardTabData((prev) => ({
          ...prev,
          [geoDimensionCardTab]: data,
        }));
      })
      .catch(() => {
        if (!active) return;
        setGeoDimensionCardTabData((prev) => ({
          ...prev,
          [geoDimensionCardTab]: [],
        }));
      });

    return () => {
      active = false;
    };
  }, [
    activeGeoDimensionCardTabData,
    filtersKey,
    geoDimensionCardTab,
    siteId,
    window.from,
    window.interval,
    window.to,
    window.timeZone,
    hasCardDataOverride,
  ]);

  const noDataText = messages.common.noData;

  const pageCardTabMeta = useMemo<Record<PageCardTab, PageCardTabMeta>>(
    () => ({
      path: {
        label: messages.common.path,
        columnLabel: messages.common.path,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.path ?? {}),
      },
      query: {
        label: messages.pages.queryTab,
        columnLabel: messages.pages.queryTab,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.query ?? {}),
      },
      title: {
        label: messages.common.title,
        columnLabel: messages.common.title,
        mono: false,
        showIcon: false,
        ...(pageCardTabMetaOverride?.title ?? {}),
      },
      hostname: {
        label: messages.common.hostname,
        columnLabel: messages.common.hostname,
        mono: true,
        showIcon: true,
        ...(pageCardTabMetaOverride?.hostname ?? {}),
      },
      entry: {
        label: messages.common.entryPage,
        columnLabel: messages.common.entryPage,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.entry ?? {}),
      },
      exit: {
        label: messages.common.exitPage,
        columnLabel: messages.common.exitPage,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.exit ?? {}),
      },
    }),
    [
      messages.common.entryPage,
      messages.common.exitPage,
      messages.common.hostname,
      messages.common.path,
      messages.common.title,
      messages.pages.queryTab,
      pageCardTabMetaOverride,
    ],
  );
  const pathRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.path ?? []).map((item, index) => {
        const rawLabel = String(item.label || "").trim();
        const fallbackLabel =
          pageCardTabMeta.path.label === messages.pages.hashTab
            ? messages.pages.noHash
            : "/";
        const label = rawLabel || fallbackLabel;
        return {
          key: `${label || fallbackLabel}-${index}`,
          label,
          displayLabel: decodeUrlDisplayValue(label),
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: pageCardTabMeta.path.mono,
        };
      }),
    [
      messages.pages.hashTab,
      messages.pages.noHash,
      pageCardTabMeta.path.label,
      pageCardTabMeta.path.mono,
      resolvedPageCardTabData.path,
    ],
  );
  const queryRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.query ?? []).map((item, index) => {
        const label = String(item.label || "").trim();
        const fallbackLabel = messages.pages.noQuery;
        const resolvedLabel = label || fallbackLabel;
        return {
          key: `query-${label || fallbackLabel}-${index}`,
          label: resolvedLabel,
          displayLabel: decodeUrlDisplayValue(resolvedLabel),
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: pageCardTabMeta.query.mono,
        };
      }),
    [
      messages.pages.noQuery,
      pageCardTabMeta.query.mono,
      resolvedPageCardTabData.query,
    ],
  );
  const titleRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.title ?? []).map((item) => {
        const normalized = String(item.label || "").trim();
        const label =
          normalized.length > 0 ? normalized : messages.common.unknown;
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: false,
        };
      }),
    [messages.common.unknown, resolvedPageCardTabData.title],
  );
  const hostnameRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.hostname ?? []).map((item) => {
        const normalized = String(item.label || "").trim();
        const label =
          normalized.length > 0 ? normalized : messages.common.unknown;
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: true,
        };
      }),
    [messages.common.unknown, resolvedPageCardTabData.hostname],
  );
  const entryRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.entry ?? []).map((item) => {
        const label = String(item.label || "").trim() || "/";
        return {
          key: label,
          label,
          displayLabel: decodeUrlDisplayValue(label),
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: true,
        };
      }),
    [resolvedPageCardTabData.entry],
  );
  const exitRows = useMemo<PageCardRow[]>(
    () =>
      (resolvedPageCardTabData.exit ?? []).map((item) => {
        const label = String(item.label || "").trim() || "/";
        return {
          key: label,
          label,
          displayLabel: decodeUrlDisplayValue(label),
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: true,
        };
      }),
    [resolvedPageCardTabData.exit],
  );
  const pageCardRows = useMemo<Record<PageCardTab, PageCardRow[]>>(
    () => ({
      path: pathRows,
      query: queryRows,
      title: titleRows,
      hostname: hostnameRows,
      entry: entryRows,
      exit: exitRows,
    }),
    [pathRows, queryRows, titleRows, hostnameRows, entryRows, exitRows],
  );
  const activePageCardFilterValue = useMemo(
    () =>
      dashboardFilterValue(
        filters,
        PAGE_CARD_FILTER_CONTROL_BY_TAB[pageCardTab],
      ) ?? null,
    [filters, pageCardTab],
  );
  const pageCardDefaultHostname = useMemo(() => {
    const filteredHostname = sanitizeHostname(
      dashboardFilterValue(filters, "hostname") ?? "",
    );
    if (filteredHostname.length > 0) return filteredHostname;

    const configuredHostname = sanitizeHostname(siteDomain);
    if (configuredHostname.length > 0) return configuredHostname;

    for (const row of hostnameRows) {
      const hostname = sanitizeHostname(row.label);
      if (hostname.length > 0) return hostname;
    }
    return "";
  }, [filters, hostnameRows, siteDomain]);
  const pageDetailBasePath = useMemo(
    () => buildPagesPagePath(pathname),
    [pathname],
  );
  const sourceCardTabMeta: Record<
    SourceCardTab,
    { label: string; columnLabel: string; mono: boolean; showIcon: boolean }
  > = {
    domain: {
      label: messages.overview.sourceTab,
      columnLabel: messages.overview.sourceDomainColumn,
      mono: true,
      showIcon: true,
    },
    link: {
      label: messages.overview.sourceLinkTab,
      columnLabel: messages.overview.sourceLinkColumn,
      mono: true,
      showIcon: true,
    },
    channel: {
      label: messages.overview.channelTab,
      columnLabel: messages.overview.channelColumn,
      mono: false,
      showIcon: true,
    },
  };
  const sourceCardDirectLabel = messages.overview.direct;
  const sourceDomainRows = useMemo<SourceCardRow[]>(() => {
    return (resolvedSourceCardTabData.domain ?? []).map((item, index) => {
      const raw = String(item.label || "").trim();
      const domain = raw.length > 0 ? sanitizeHostname(raw) : "";
      const filterValue = domain || DIRECT_REFERRER_FILTER_VALUE;
      const label = domain || sourceCardDirectLabel;
      return {
        key: `domain-${filterValue}-${index}`,
        label,
        filterValue,
        targetUrl: domain ? toAbsoluteHttpsUrl(domain) : null,
        views: Math.max(0, Number(item.views || 0)),
        visitors: Math.max(0, Number(item.visitors || 0)),
        mono: true,
      };
    });
  }, [sourceCardDirectLabel, resolvedSourceCardTabData.domain]);
  const sourceLinkRows = useMemo<SourceCardRow[]>(() => {
    return (resolvedSourceCardTabData.link ?? []).map((item, index) => {
      const raw = String(item.label || "").trim();
      const targetUrl = raw.length > 0 ? toAbsoluteHttpsUrl(raw) : null;
      const filterValue = raw.length > 0 ? raw : DIRECT_REFERRER_FILTER_VALUE;
      const label = raw.length > 0 ? (targetUrl ?? raw) : sourceCardDirectLabel;
      return {
        key: `link-${filterValue}-${index}`,
        label,
        displayLabel: decodeUrlDisplayValue(label),
        filterValue,
        targetUrl,
        views: Math.max(0, Number(item.views || 0)),
        visitors: Math.max(0, Number(item.visitors || 0)),
        mono: true,
      };
    });
  }, [sourceCardDirectLabel, resolvedSourceCardTabData.link]);
  const sourceChannelRows = useMemo<SourceCardRow[]>(() => {
    return (resolvedSourceCardTabData.channel ?? []).map((item, index) => {
      const raw = String(item.label || "").trim();
      const channelId = TRAFFIC_CHANNEL_IDS.includes(raw as TrafficChannelId)
        ? (raw as TrafficChannelId)
        : "other";
      return {
        key: `channel-${channelId}-${index}`,
        label: messages.overview.channelLabels[channelId],
        filterValue: channelId,
        targetUrl: null,
        views: Math.max(0, Number(item.views || 0)),
        visitors: Math.max(0, Number(item.visitors || 0)),
        mono: false,
        channelId,
      };
    });
  }, [messages.overview.channelLabels, resolvedSourceCardTabData.channel]);
  const sourceCardRows = useMemo<Record<SourceCardTab, SourceCardRow[]>>(
    () => ({
      domain: sourceDomainRows,
      link: sourceLinkRows,
      channel: sourceChannelRows,
    }),
    [sourceChannelRows, sourceDomainRows, sourceLinkRows],
  );
  const activeSourceCardFilterValue = useMemo(() => {
    return (
      dashboardFilterValue(
        filters,
        SOURCE_CARD_FILTER_CONTROL_BY_TAB[sourceCardTab],
      ) ?? null
    );
  }, [filters, sourceCardTab]);
  const clientDimensionCardTabMeta: Record<
    ClientDimensionCardTab,
    { label: string; columnLabel: string; mono: boolean }
  > = {
    browser: {
      label: messages.common.browser,
      columnLabel: messages.common.browser,
      mono: false,
    },
    osVersion: {
      label: messages.common.operatingSystem,
      columnLabel: messages.common.operatingSystem,
      mono: false,
    },
    deviceType: {
      label: messages.common.deviceType,
      columnLabel: messages.common.deviceType,
      mono: false,
    },
    language: {
      label: messages.common.language,
      columnLabel: messages.common.language,
      mono: false,
    },
    screenSize: {
      label: messages.common.screenSize,
      columnLabel: messages.common.screenSize,
      mono: true,
    },
  };
  const geoDimensionCardTabMeta: Record<
    GeoDimensionCardTab,
    { label: string; columnLabel: string; mono: boolean }
  > = {
    country: {
      label: messages.geo.countryLabel,
      columnLabel: messages.geo.countryLabel,
      mono: false,
    },
    region: {
      label: messages.geo.regionLabel,
      columnLabel: messages.geo.regionLabel,
      mono: false,
    },
    city: {
      label: messages.geo.cityLabel,
      columnLabel: messages.geo.cityLabel,
      mono: false,
    },
    continent: {
      label: messages.common.continent,
      columnLabel: messages.common.continent,
      mono: false,
    },
    timezone: {
      label: messages.common.timezone,
      columnLabel: messages.common.timezone,
      mono: false,
    },
    organization: {
      label: messages.common.organization,
      columnLabel: messages.common.organization,
      mono: false,
    },
  };
  const clientDimensionCardRows = useMemo<
    Record<ClientDimensionCardTab, PageCardRow[]>
  >(() => {
    const toRows = (
      rows: Array<{ label: string; views: number; visitors: number }>,
      options?: {
        mono?: boolean;
        screenSize?: boolean;
        transformLabel?: (value: string) => string;
        resolveIconName?: (value: string) => string | null;
        resolveFilterValue?: (
          rawValue: string,
          normalizedLabel: string,
        ) => string;
      },
    ): PageCardRow[] =>
      rows.map((item, index) => {
        const rawValue = String(item.label || "");
        const rawLabel = normalizeDimensionLabel(
          rawValue,
          messages.common.unknown,
          { screenSize: options?.screenSize },
        );
        const label = options?.transformLabel
          ? options.transformLabel(rawLabel)
          : rawLabel;
        const filterValue =
          options?.resolveFilterValue?.(rawValue, rawLabel) ?? rawLabel;
        return {
          key: `${label}-${index}`,
          label,
          rawLabel: rawValue.trim() || rawLabel,
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: options?.mono ?? false,
          iconName: options?.resolveIconName?.(rawLabel) ?? null,
          filterValue,
        };
      });

    return {
      browser: toRows(resolvedClientDimensionCardTabData.browser ?? [], {
        resolveIconName: resolveBrowserLogoIconName,
      }),
      osVersion: toRows(resolvedClientDimensionCardTabData.osVersion ?? [], {
        resolveIconName: resolveOsLogoIconName,
      }),
      deviceType: toRows(resolvedClientDimensionCardTabData.deviceType ?? [], {
        transformLabel: (value) =>
          resolveDeviceTypeMeta(
            value,
            messages.common.deviceLabels,
            messages.common.unknown,
          ).label,
      }),
      language: toRows(resolvedClientDimensionCardTabData.language ?? [], {
        transformLabel: (value) =>
          resolveLanguageLabel(value, locale, messages.common.unknown).label,
        resolveFilterValue: (rawValue, normalizedLabel) =>
          rawValue.trim() || normalizedLabel,
      }),
      screenSize: toRows(resolvedClientDimensionCardTabData.screenSize ?? [], {
        mono: true,
        screenSize: true,
      }),
    };
  }, [resolvedClientDimensionCardTabData, locale, messages.common.unknown]);
  const geoDimensionCardRows = useMemo<
    Record<GeoDimensionCardTab, PageCardRow[]>
  >(() => {
    const toRows = (
      rows: Array<{ label: string; views: number; visitors: number }>,
      options?: {
        transformLabel?: (value: string) => string;
        resolveIconName?: (value: string) => string | null;
        resolveFilterValue?: (value: string) => string;
      },
    ): PageCardRow[] =>
      rows.map((item, index) => {
        const originalValue = String(item.label || "");
        const rawLabel = normalizeDimensionLabel(
          originalValue,
          messages.common.unknown,
        );
        const label = options?.transformLabel
          ? options.transformLabel(rawLabel)
          : rawLabel;
        return {
          key: `${label}-${index}`,
          label,
          rawLabel: originalValue.trim() || rawLabel,
          views: Math.max(0, Number(item.views || 0)),
          visitors: Math.max(0, Number(item.visitors || 0)),
          mono: false,
          iconName: options?.resolveIconName?.(rawLabel) ?? null,
          filterValue: options?.resolveFilterValue?.(originalValue) ?? rawLabel,
        };
      });

    const regionRows: PageCardRow[] = (
      resolvedGeoDimensionCardTabData.region ?? []
    ).map((item, index) => {
      const value = resolveGeoDimensionRowRawValue(item);
      const regionData = resolveGeoRegionBreadcrumbData(
        value,
        locale,
        messages.common.unknown,
      );

      return {
        key: `${regionData.displayLabel}-${index}`,
        label: regionData.displayLabel,
        rawLabel: value.trim() || regionData.filterValue,
        views: Math.max(0, Number(item.views || 0)),
        visitors: Math.max(0, Number(item.visitors || 0)),
        mono: false,
        iconName: null,
        filterValue: regionData.filterValue,
        regionBreadcrumb: regionData.breadcrumb,
      };
    });
    const cityRows: PageCardRow[] = (
      resolvedGeoDimensionCardTabData.city ?? []
    ).map((item, index) => {
      const value = resolveGeoDimensionRowRawValue(item);
      const cityData = resolveGeoCityBreadcrumbData(
        value,
        locale,
        messages.common.unknown,
      );

      return {
        key: `${cityData.displayLabel}-${index}`,
        label: cityData.displayLabel,
        rawLabel: value.trim() || cityData.filterValue,
        views: Math.max(0, Number(item.views || 0)),
        visitors: Math.max(0, Number(item.visitors || 0)),
        mono: false,
        iconName: null,
        filterValue: cityData.filterValue,
        cityBreadcrumb: cityData.breadcrumb ?? undefined,
      };
    });

    return {
      country: toRows(resolvedGeoDimensionCardTabData.country ?? [], {
        transformLabel: (value) =>
          resolveCountryLabel(value, locale, messages.common.unknown).label,
        resolveIconName: (value) => {
          const { code } = resolveCountryLabel(
            value,
            locale,
            messages.common.unknown,
          );
          const flagCode = resolveCountryFlagCode(code, locale);
          return flagCode ? `flagpack:${flagCode.toLowerCase()}` : null;
        },
      }),
      region: regionRows,
      city: cityRows,
      continent: toRows(resolvedGeoDimensionCardTabData.continent ?? [], {
        transformLabel: (value) =>
          resolveContinentLabel(
            value,
            messages.common.unknown,
            messages.common.continentLabels,
          ),
      }),
      timezone: toRows(resolvedGeoDimensionCardTabData.timezone ?? [], {
        transformLabel: (value) =>
          resolveTimezoneDisplayLabel({
            value,
            locale,
            unknownLabel: messages.common.unknown,
            timestampMs: timezoneReferenceTimestampMs,
            timezoneDeltaVsLocal: messages.geo.timezoneDeltaVsLocal,
          }),
      }),
      organization: toRows(resolvedGeoDimensionCardTabData.organization ?? []),
    };
  }, [
    resolvedGeoDimensionCardTabData,
    locale,
    messages.common.continentLabels,
    messages.common.unknown,
    messages.geo.timezoneDeltaVsLocal,
    timezoneReferenceTimestampMs,
  ]);
  const resolvedPrimaryMetricLabel =
    primaryMetricLabel ?? messages.common.views;
  const activeClientDimensionCardFilterValue = useMemo(() => {
    return (
      dashboardFilterValue(
        filters,
        CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB[clientDimensionCardTab],
      ) ?? null
    );
  }, [clientDimensionCardTab, filters]);
  const activeGeoDimensionCardFilterValue = useMemo(() => {
    if (isGeoLocationTab(geoDimensionCardTab)) {
      return (
        canonicalizeGeoFilterValue(dashboardFilterValue(filters, "geo")) ?? null
      );
    }
    return (
      dashboardFilterValue(
        filters,
        GEO_AUX_FILTER_CONTROL_BY_TAB[geoDimensionCardTab],
      ) ?? null
    );
  }, [filters, geoDimensionCardTab]);

  const setPageCardFilter = (
    next: { tab: PageCardTab; value: string } | null,
  ) => {
    const activeTab = next?.tab ?? pageCardTab;
    if (!pageCardFilterEnabledByTab[activeTab]) return;
    const nextFilters = setDashboardFilterValue(
      filters,
      PAGE_CARD_FILTER_CONTROL_BY_TAB[activeTab],
      next?.value,
    );
    const params = withDashboardFilterSearchParams(searchParams, nextFilters);
    const current = serializeDashboardSearchParams(searchParams);
    const updated = serializeDashboardSearchParams(params);
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    replaceUrlWithoutNavigation(target);
  };
  const setSourceCardFilter = (
    next: { tab: SourceCardTab; value: string } | null,
  ) => {
    const activeTab = next?.tab ?? sourceCardTab;
    const nextFilters = setDashboardFilterValue(
      filters,
      SOURCE_CARD_FILTER_CONTROL_BY_TAB[activeTab],
      next?.value,
    );
    const params = withDashboardFilterSearchParams(searchParams, nextFilters);
    const current = serializeDashboardSearchParams(searchParams);
    const updated = serializeDashboardSearchParams(params);
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    replaceUrlWithoutNavigation(target);
  };
  const setClientDimensionCardFilter = (
    next: { tab: ClientDimensionCardTab; value: string } | null,
  ) => {
    const activeTab = next?.tab ?? clientDimensionCardTab;
    const nextFilters = setDashboardFilterValue(
      filters,
      CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB[activeTab],
      next?.value,
    );
    const params = withDashboardFilterSearchParams(searchParams, nextFilters);
    const current = serializeDashboardSearchParams(searchParams);
    const updated = serializeDashboardSearchParams(params);
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    replaceUrlWithoutNavigation(target);
  };
  const setGeoDimensionCardFilter = (
    next: { tab: GeoDimensionCardTab; value: string } | null,
  ) => {
    const activeTab = next?.tab ?? geoDimensionCardTab;
    const filterControl = isGeoLocationTab(activeTab)
      ? "geo"
      : GEO_AUX_FILTER_CONTROL_BY_TAB[activeTab];
    const filterValue =
      next && isGeoLocationTab(next.tab)
        ? canonicalizeGeoFilterValue(next.value)
        : next?.value;
    const nextFilters = setDashboardFilterValue(
      filters,
      filterControl,
      filterValue,
    );
    const params = withDashboardFilterSearchParams(searchParams, nextFilters);
    const current = serializeDashboardSearchParams(searchParams);
    const updated = serializeDashboardSearchParams(params);
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    replaceUrlWithoutNavigation(target);
  };
  const handlePageCardTabChange = (tab: PageCardTab) => {
    if (tab !== pageCardTab) {
      setPageCardTab(tab);
    }
  };
  const openPageCardRowTarget = (
    targetUrl: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    globalThis.window.open(targetUrl, "_blank", "noopener,noreferrer");
  };
  const openPageCardRowDetail = (
    detailHref: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    router.push(detailHref);
  };
  const openPageCardRowDetailAction = (
    detailAction: PageCardDetailClickResolver,
    detailParams: Parameters<PageCardDetailClickResolver>[0],
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    detailAction(detailParams);
  };
  const openGeoDimensionLocationTarget = (
    targetUrl: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    router.push(targetUrl);
  };
  const pageCardRowsForTable = useMemo<
    Record<PageCardTab, PageCardRow[] | null>
  >(
    () => ({
      path: resolvedPageCardTabData.path === null ? null : pageCardRows.path,
      query: resolvedPageCardTabData.query === null ? null : pageCardRows.query,
      title: resolvedPageCardTabData.title === null ? null : pageCardRows.title,
      hostname:
        resolvedPageCardTabData.hostname === null
          ? null
          : pageCardRows.hostname,
      entry: resolvedPageCardTabData.entry === null ? null : pageCardRows.entry,
      exit: resolvedPageCardTabData.exit === null ? null : pageCardRows.exit,
    }),
    [pageCardRows, resolvedPageCardTabData],
  );
  const sourceCardRowsForTable = useMemo<
    Record<SourceCardTab, SourceCardRow[] | null>
  >(
    () => ({
      domain:
        resolvedSourceCardTabData.domain === null
          ? null
          : sourceCardRows.domain,
      link:
        resolvedSourceCardTabData.link === null ? null : sourceCardRows.link,
      channel:
        resolvedSourceCardTabData.channel === undefined
          ? null
          : resolvedSourceCardTabData.channel === null
            ? null
            : sourceCardRows.channel,
    }),
    [resolvedSourceCardTabData, sourceCardRows],
  );
  const clientDimensionCardRowsForTable = useMemo<
    Record<ClientDimensionCardTab, PageCardRow[] | null>
  >(
    () => ({
      browser:
        resolvedClientDimensionCardTabData.browser === null
          ? null
          : clientDimensionCardRows.browser,
      osVersion:
        resolvedClientDimensionCardTabData.osVersion === null
          ? null
          : clientDimensionCardRows.osVersion,
      deviceType:
        resolvedClientDimensionCardTabData.deviceType === null
          ? null
          : clientDimensionCardRows.deviceType,
      language:
        resolvedClientDimensionCardTabData.language === null
          ? null
          : clientDimensionCardRows.language,
      screenSize:
        resolvedClientDimensionCardTabData.screenSize === null
          ? null
          : clientDimensionCardRows.screenSize,
    }),
    [clientDimensionCardRows, resolvedClientDimensionCardTabData],
  );
  const geoDimensionCardRowsForTable = useMemo<
    Record<GeoDimensionCardTab, PageCardRow[] | null>
  >(
    () => ({
      country:
        resolvedGeoDimensionCardTabData.country === null
          ? null
          : geoDimensionCardRows.country,
      region:
        resolvedGeoDimensionCardTabData.region === null
          ? null
          : geoDimensionCardRows.region,
      city:
        resolvedGeoDimensionCardTabData.city === null
          ? null
          : geoDimensionCardRows.city,
      continent:
        resolvedGeoDimensionCardTabData.continent === null
          ? null
          : geoDimensionCardRows.continent,
      timezone:
        resolvedGeoDimensionCardTabData.timezone === null
          ? null
          : geoDimensionCardRows.timezone,
      organization:
        resolvedGeoDimensionCardTabData.organization === null
          ? null
          : geoDimensionCardRows.organization,
    }),
    [geoDimensionCardRows, resolvedGeoDimensionCardTabData],
  );
  const overviewMetricColumns = useMemo<
    readonly TabbedDataTableColumn<PageCardRow, PageCardSortKey, string>[]
  >(
    () => [
      {
        key: "views",
        label: resolvedPrimaryMetricLabel,
        getValue: (row) => row.views,
        format: (value) => numberFormat(locale, value),
      },
      {
        key: "visitors",
        label: messages.common.visitors,
        getValue: (row) => row.visitors,
        format: (value) => numberFormat(locale, value),
      },
    ],
    [locale, messages.common.visitors, resolvedPrimaryMetricLabel],
  );
  const pageCardMetricColumns = useMemo<
    (
      tab: PageCardTab,
    ) => readonly TabbedDataTableColumn<
      PageCardRow,
      PageCardSortKey,
      PageCardTab
    >[]
  >(
    () => (tab) => {
      const viewsColumn = {
        key: "views" as const,
        label:
          pageCardTabMeta[tab].primaryMetricLabel ?? resolvedPrimaryMetricLabel,
        getValue: (row: PageCardRow) => row.views,
        format: (value: number) => numberFormat(locale, value),
      };
      if (!pageCardShowVisitors) return [viewsColumn];
      return [
        viewsColumn,
        {
          key: "visitors",
          label: messages.common.visitors,
          getValue: (row) => row.visitors,
          format: (value) => numberFormat(locale, value),
        },
      ];
    },
    [
      locale,
      messages.common.visitors,
      pageCardShowVisitors,
      pageCardTabMeta,
      resolvedPrimaryMetricLabel,
    ],
  );
  const pageCardTableTabs = useMemo(
    () =>
      (resolvedPageCardTabs.length > 0
        ? resolvedPageCardTabs
        : (["path"] as PageCardTab[])
      ).map((tab) => ({
        value: tab,
        label: pageCardTabMeta[tab].label,
        columnLabel: pageCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<PageCardTab>,
        ...TabbedDataTableTab<PageCardTab>[],
      ],
    [pageCardTabMeta, resolvedPageCardTabs],
  );
  const sourceCardTableTabs = useMemo(
    () =>
      resolvedSourceCardTabs.map((tab) => ({
        value: tab,
        label: sourceCardTabMeta[tab].label,
        columnLabel: sourceCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<SourceCardTab>,
        ...TabbedDataTableTab<SourceCardTab>[],
      ],
    [resolvedSourceCardTabs, sourceCardTabMeta],
  );
  const clientDimensionCardTableTabs = useMemo(
    () =>
      CLIENT_DIMENSION_CARD_TABS.map((tab) => ({
        value: tab,
        label: clientDimensionCardTabMeta[tab].label,
        columnLabel: clientDimensionCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<ClientDimensionCardTab>,
        ...TabbedDataTableTab<ClientDimensionCardTab>[],
      ],
    [clientDimensionCardTabMeta],
  );
  const geoDimensionCardTableTabs = useMemo(
    () =>
      GEO_DIMENSION_CARD_TABS.map((tab) => ({
        value: tab,
        label: geoDimensionCardTabMeta[tab].label,
        columnLabel: geoDimensionCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<GeoDimensionCardTab>,
        ...TabbedDataTableTab<GeoDimensionCardTab>[],
      ],
    [geoDimensionCardTabMeta],
  );
  const loadingByPageCardTab = useMemo(
    () =>
      Object.fromEntries(
        ALL_PAGE_CARD_TABS.map((tab) => [
          tab,
          loading ||
            (!hasCardDataOverride && resolvedPageCardTabData[tab] === null),
        ]),
      ) as Record<PageCardTab, boolean>,
    [hasCardDataOverride, loading, resolvedPageCardTabData],
  );
  const loadingBySourceCardTab = useMemo(
    () =>
      Object.fromEntries(
        resolvedSourceCardTabs.map((tab) => [
          tab,
          loading ||
            (!hasCardDataOverride && resolvedSourceCardTabData[tab] === null),
        ]),
      ) as Record<SourceCardTab, boolean>,
    [
      hasCardDataOverride,
      loading,
      resolvedSourceCardTabData,
      resolvedSourceCardTabs,
    ],
  );
  const loadingByClientDimensionCardTab = useMemo(
    () =>
      Object.fromEntries(
        CLIENT_DIMENSION_CARD_TABS.map((tab) => [
          tab,
          loading ||
            (!hasCardDataOverride &&
              resolvedClientDimensionCardTabData[tab] === null),
        ]),
      ) as Record<ClientDimensionCardTab, boolean>,
    [hasCardDataOverride, loading, resolvedClientDimensionCardTabData],
  );
  const loadingByGeoDimensionCardTab = useMemo(
    () =>
      Object.fromEntries(
        GEO_DIMENSION_CARD_TABS.map((tab) => [
          tab,
          loading ||
            (!hasCardDataOverride &&
              resolvedGeoDimensionCardTabData[tab] === null),
        ]),
      ) as Record<GeoDimensionCardTab, boolean>,
    [hasCardDataOverride, loading, resolvedGeoDimensionCardTabData],
  );
  const searchConfig = useMemo(
    () => ({
      actionLabel: messages.common.search,
      placeholder: (tab: { label: string }) =>
        formatI18nTemplate(messages.overview.searchInTab, { tab: tab.label }),
    }),
    [messages.common.search, messages.overview.searchInTab],
  );
  const comparePageRows = useCallback(
    (
      left: PageCardRow,
      right: PageCardRow,
      { sort }: { sort: { key: PageCardSortKey; direction: "asc" | "desc" } },
    ) => {
      const primary =
        (left[sort.key] - right[sort.key]) *
        (sort.direction === "asc" ? 1 : -1);
      if (primary !== 0) return primary;
      if (right.views !== left.views) return right.views - left.views;
      if (right.visitors !== left.visitors)
        return right.visitors - left.visitors;
      return (left.displayLabel ?? left.label).localeCompare(
        right.displayLabel ?? right.label,
      );
    },
    [],
  );
  const pageCardLabel = useCallback(
    (item: PageCardRow, tab: PageCardTab) => {
      const displayLabel = item.displayLabel ?? item.label;
      const rowTargetUrl = resolvedPageCardNavigableTabs.has(
        tab as PageCardNavigableTab,
      )
        ? (pageCardTargetUrlResolvers?.[tab] ?? resolvePageCardTargetUrl)({
            tab,
            value: item.label,
            unknownLabel: messages.common.unknown,
            fallbackHostname: pageCardDefaultHostname,
          })
        : null;
      const rowDetailAction =
        isPageCardDetailTab(tab) && resolvedPageCardDetailTabs.has(tab)
          ? (pageCardDetailClickResolvers?.[tab] ?? null)
          : null;
      const rowDetailHref =
        !rowDetailAction &&
        isPageCardDetailTab(tab) &&
        resolvedPageCardDetailTabs.has(tab)
          ? (pageCardDetailHrefResolvers?.[tab] ?? resolvePageCardDetailHref)({
              tab,
              basePath: pageDetailBasePath,
              value: item.label,
              unknownLabel: messages.common.unknown,
            })
          : null;
      const rowDetailParams =
        rowDetailAction && isPageCardDetailTab(tab)
          ? {
              tab: tab as PageCardDetailTab,
              basePath: pageDetailBasePath,
              value: item.label,
              unknownLabel: messages.common.unknown,
            }
          : null;
      const meta = pageCardTabMeta[tab];

      return (
        <span
          className={cn(
            "inline-flex items-center gap-2 break-words",
            meta.mono && "font-mono",
          )}
        >
          <LabelWithOptionalIcon
            label={displayLabel}
            showIcon={meta.showIcon}
            unknownLabel={messages.common.unknown}
          />
          {rowTargetUrl ? (
            <Clickable
              className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
              onClick={(event) => openPageCardRowTarget(rowTargetUrl, event)}
              aria-label={displayLabel}
              title={displayLabel}
            >
              <RiArrowRightUpLine size="1.4em" />
            </Clickable>
          ) : null}
          {rowDetailAction && rowDetailParams ? (
            <Clickable
              className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
              onClick={(event) =>
                openPageCardRowDetailAction(
                  rowDetailAction,
                  rowDetailParams,
                  event,
                )
              }
              aria-label={messages.common.search}
              title={messages.common.search}
            >
              <RiSearchLine size="1.2em" />
            </Clickable>
          ) : rowDetailHref ? (
            <Clickable
              className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
              onClick={(event) => openPageCardRowDetail(rowDetailHref, event)}
              aria-label={messages.common.search}
              title={messages.common.search}
            >
              <RiSearchLine size="1.2em" />
            </Clickable>
          ) : null}
        </span>
      );
    },
    [
      messages.common.search,
      messages.common.unknown,
      pageCardDefaultHostname,
      pageCardDetailClickResolvers,
      pageCardDetailHrefResolvers,
      pageCardTabMeta,
      pageCardTargetUrlResolvers,
      pageDetailBasePath,
      resolvedPageCardDetailTabs,
      resolvedPageCardNavigableTabs,
    ],
  );
  const geoDimensionRowLocationTarget = useCallback(
    (tab: GeoDimensionCardTab, item: PageCardRow) => {
      const rowLocationValue = resolveGeoLocationQueryValue(
        tab,
        item,
        messages.common.unknown,
      );
      return rowLocationValue
        ? `${buildGeoPagePath(geoPageBasePathname ?? livePathname)}?${new URLSearchParams(
            { location: rowLocationValue },
          ).toString()}`
        : null;
    },
    [geoPageBasePathname, livePathname, messages.common.unknown],
  );
  return (
    <>
      <section
        className={cn(
          "grid items-stretch gap-6 xl:grid-cols-2",
          sectionClassName,
        )}
      >
        {resolvedVisibleCards.has("page") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<PageCardTab, PageCardRow, PageCardSortKey>
              value={pageCardTab}
              onValueChange={handlePageCardTabChange}
              tabs={pageCardTableTabs}
              rowsByTab={pageCardRowsForTable}
              loadingByTab={loadingByPageCardTab}
              columns={pageCardMetricColumns}
              rowAdapter={{
                renderLabel: (row, { tab, source }) =>
                  source === "search" ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-2 break-words",
                        pageCardTabMeta[tab].mono && "font-mono",
                      )}
                    >
                      <LabelWithOptionalIcon
                        label={row.label}
                        showIcon={pageCardTabMeta[tab].showIcon}
                        unknownLabel={messages.common.unknown}
                      />
                    </span>
                  ) : (
                    pageCardLabel(row, tab)
                  ),
                getSearchText: (row) => row.label,
                getExportLabel: (row) => row.label,
                getActive: (row) =>
                  activePageCardFilterValue === (row.filterValue ?? row.label),
                getInteractive: (row, tab) =>
                  pageCardFilterEnabledByTab[tab] ||
                  Boolean(
                    resolvedPageCardNavigableTabs.has(
                      tab as PageCardNavigableTab,
                    )
                      ? (
                          pageCardTargetUrlResolvers?.[tab] ??
                          resolvePageCardTargetUrl
                        )({
                          tab,
                          value: row.label,
                          unknownLabel: messages.common.unknown,
                          fallbackHostname: pageCardDefaultHostname,
                        })
                      : null,
                  ) ||
                  (isPageCardDetailTab(tab) &&
                    resolvedPageCardDetailTabs.has(tab)),
                onClick: (row, { tab }) => {
                  const rowFilterValue = row.filterValue ?? row.label;
                  if (pageCardFilterEnabledByTab[tab]) {
                    const normalized = rowFilterValue.trim();
                    setPageCardFilter(
                      activePageCardFilterValue === normalized
                        ? null
                        : { tab, value: normalized },
                    );
                    return;
                  }

                  const rowTargetUrl = resolvedPageCardNavigableTabs.has(
                    tab as PageCardNavigableTab,
                  )
                    ? (
                        pageCardTargetUrlResolvers?.[tab] ??
                        resolvePageCardTargetUrl
                      )({
                        tab,
                        value: row.label,
                        unknownLabel: messages.common.unknown,
                        fallbackHostname: pageCardDefaultHostname,
                      })
                    : null;
                  if (rowTargetUrl) {
                    globalThis.window.open(
                      rowTargetUrl,
                      "_blank",
                      "noopener,noreferrer",
                    );
                    return;
                  }

                  const rowDetailAction =
                    isPageCardDetailTab(tab) &&
                    resolvedPageCardDetailTabs.has(tab)
                      ? (pageCardDetailClickResolvers?.[tab] ?? null)
                      : null;
                  if (rowDetailAction && isPageCardDetailTab(tab)) {
                    rowDetailAction({
                      tab,
                      basePath: pageDetailBasePath,
                      value: row.label,
                      unknownLabel: messages.common.unknown,
                    });
                    return;
                  }

                  const rowDetailHref =
                    isPageCardDetailTab(tab) &&
                    resolvedPageCardDetailTabs.has(tab)
                      ? (
                          pageCardDetailHrefResolvers?.[tab] ??
                          resolvePageCardDetailHref
                        )({
                          tab,
                          basePath: pageDetailBasePath,
                          value: row.label,
                          unknownLabel: messages.common.unknown,
                        })
                      : null;
                  if (rowDetailHref) router.push(rowDetailHref);
                },
              }}
              filterRows={(rows) =>
                activePageCardFilterValue
                  ? rows.filter(
                      (row) =>
                        (row.filterValue ?? row.label) ===
                        activePageCardFilterValue,
                    )
                  : [...rows]
              }
              compareRows={comparePageRows}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={{
                labels: messages.common.tableExport,
              }}
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("source") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<SourceCardTab, SourceCardRow, PageCardSortKey>
              value={sourceCardTab}
              onValueChange={(value) => setSourceCardTab(value)}
              tabs={sourceCardTableTabs}
              rowsByTab={sourceCardRowsForTable}
              loadingByTab={loadingBySourceCardTab}
              columns={overviewMetricColumns}
              rowAdapter={{
                renderLabel: (row, { tab, source }) => {
                  const displayLabel =
                    source === "search"
                      ? row.label
                      : (row.displayLabel ?? row.label);
                  if (tab === "channel" && row.channelId) {
                    return (
                      <InlineMeta
                        icon={<ChannelIcon channel={row.channelId} />}
                        label={displayLabel}
                      />
                    );
                  }
                  return (
                    <span
                      className={cn(
                        "inline-flex items-center gap-2 break-words",
                        row.mono && "font-mono",
                      )}
                    >
                      <LabelWithOptionalIcon
                        label={displayLabel}
                        showIcon={sourceCardTabMeta[tab].showIcon}
                        unknownLabel={sourceCardDirectLabel}
                      />
                      {source !== "search" && row.targetUrl ? (
                        <Clickable
                          className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                          onClick={(event) =>
                            openPageCardRowTarget(row.targetUrl!, event)
                          }
                          aria-label={displayLabel}
                          title={displayLabel}
                        >
                          <RiArrowRightUpLine size="1.4em" />
                        </Clickable>
                      ) : null}
                    </span>
                  );
                },
                getSearchText: (row) => row.label,
                getExportLabel: (row) => row.label,
                getActive: (row) =>
                  activeSourceCardFilterValue !== null &&
                  activeSourceCardFilterValue === row.filterValue,
                getInteractive: () => true,
                onClick: (row, { tab }) => {
                  const normalized = row.filterValue.trim();
                  setSourceCardFilter(
                    activeSourceCardFilterValue === normalized
                      ? null
                      : { tab, value: normalized },
                  );
                },
              }}
              filterRows={(rows) =>
                activeSourceCardFilterValue
                  ? rows.filter(
                      (row) => row.filterValue === activeSourceCardFilterValue,
                    )
                  : [...rows]
              }
              compareRows={comparePageRows}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={{
                labels: messages.common.tableExport,
              }}
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("client") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<
              ClientDimensionCardTab,
              PageCardRow,
              PageCardSortKey
            >
              value={clientDimensionCardTab}
              onValueChange={(value) => setClientDimensionCardTab(value)}
              tabs={clientDimensionCardTableTabs}
              rowsByTab={clientDimensionCardRowsForTable}
              loadingByTab={loadingByClientDimensionCardTab}
              columns={overviewMetricColumns}
              rowAdapter={{
                renderLabel: (row, { tab, source }) =>
                  tab === "deviceType" ? (
                    <DeviceMeta
                      deviceType={row.rawLabel ?? row.label}
                      deviceLabels={messages.common.deviceLabels}
                      unknownLabel={messages.common.unknown}
                    />
                  ) : (
                    <span className={cn(row.mono && "font-mono")}>
                      <LabelWithLeadingIcon
                        label={
                          source === "search"
                            ? row.rawLabel?.trim() || row.label
                            : row.label
                        }
                        iconName={row.iconName}
                      />
                    </span>
                  ),
                getSearchText: (row) => row.rawLabel?.trim() || row.label,
                getExportLabel: (row) => row.rawLabel?.trim() || row.label,
                getActive: (row) =>
                  activeClientDimensionCardFilterValue ===
                  (row.filterValue ?? row.label),
                getInteractive: () => true,
                onClick: (row, { tab }) => {
                  const normalized = (row.filterValue ?? row.label).trim();
                  setClientDimensionCardFilter(
                    activeClientDimensionCardFilterValue === normalized
                      ? null
                      : { tab, value: normalized },
                  );
                },
              }}
              filterRows={(rows) =>
                activeClientDimensionCardFilterValue
                  ? rows.filter(
                      (row) =>
                        (row.filterValue ?? row.label) ===
                        activeClientDimensionCardFilterValue,
                    )
                  : [...rows]
              }
              compareRows={comparePageRows}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={{
                labels: messages.common.tableExport,
              }}
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("geo") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<
              GeoDimensionCardTab,
              PageCardRow,
              PageCardSortKey
            >
              value={geoDimensionCardTab}
              onValueChange={(value) => setGeoDimensionCardTab(value)}
              tabs={geoDimensionCardTableTabs}
              rowsByTab={geoDimensionCardRowsForTable}
              loadingByTab={loadingByGeoDimensionCardTab}
              columns={overviewMetricColumns}
              rowAdapter={{
                renderLabel: (row, { tab, source }) => {
                  const rowLocationTarget =
                    source === "search"
                      ? null
                      : geoDimensionRowLocationTarget(tab, row);
                  return (
                    <span
                      className={cn(
                        "inline-flex items-center gap-2 break-words",
                        row.mono && "font-mono",
                      )}
                    >
                      {source === "search" ? (
                        <LabelWithLeadingIcon
                          label={row.rawLabel?.trim() || row.label}
                          iconName={row.iconName}
                        />
                      ) : tab === "region" && row.regionBreadcrumb ? (
                        <LazyGeoRegionBreadcrumbLabel
                          locale={locale}
                          countryLabel={row.regionBreadcrumb.countryLabel}
                          countryIconName={row.regionBreadcrumb.countryIconName}
                          regionLabel={row.regionBreadcrumb.regionLabel}
                          countryCode={row.regionBreadcrumb.countryCode}
                          stateCode={row.regionBreadcrumb.stateCode}
                          hideRegion={row.regionBreadcrumb.hideRegion}
                        />
                      ) : tab === "city" && row.cityBreadcrumb ? (
                        <LazyGeoCityBreadcrumbLabel
                          locale={locale}
                          countryLabel={row.cityBreadcrumb.countryLabel}
                          countryIconName={row.cityBreadcrumb.countryIconName}
                          regionLabel={row.cityBreadcrumb.regionLabel}
                          cityLabel={row.cityBreadcrumb.cityLabel}
                          countryCode={row.cityBreadcrumb.countryCode}
                          stateCode={row.cityBreadcrumb.stateCode}
                          cityNameDefault={row.cityBreadcrumb.cityNameDefault}
                          hideRegion={row.cityBreadcrumb.hideRegion}
                          hideCity={row.cityBreadcrumb.hideCity}
                        />
                      ) : (
                        <LabelWithLeadingIcon
                          label={row.label}
                          iconName={row.iconName}
                        />
                      )}
                      {rowLocationTarget ? (
                        <Clickable
                          className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                          onClick={(event) =>
                            openGeoDimensionLocationTarget(
                              rowLocationTarget,
                              event,
                            )
                          }
                          aria-label={messages.common.search}
                          title={messages.common.search}
                        >
                          <RiSearchLine size="1.2em" />
                        </Clickable>
                      ) : null}
                    </span>
                  );
                },
                getSearchText: (row) => row.rawLabel?.trim() || row.label,
                getExportLabel: (row) => row.rawLabel?.trim() || row.label,
                getActive: (row, tab) => {
                  const activeGeoHighlightValue = isGeoLocationTab(tab)
                    ? resolveGeoLocationHighlightValue(
                        tab,
                        activeGeoDimensionCardFilterValue,
                      )
                    : activeGeoDimensionCardFilterValue;
                  return (
                    activeGeoHighlightValue === (row.filterValue ?? row.label)
                  );
                },
                getInteractive: () => true,
                onClick: (row, { tab }) => {
                  const normalized = (row.filterValue ?? row.label).trim();
                  setGeoDimensionCardFilter(
                    activeGeoDimensionCardFilterValue === normalized
                      ? null
                      : { tab, value: normalized },
                  );
                },
              }}
              filterRows={(rows, tab) => {
                if (!activeGeoDimensionCardFilterValue) return [...rows];
                const activeGeoFilterValue = isGeoLocationTab(tab)
                  ? resolveGeoLocationHighlightValue(
                      tab,
                      activeGeoDimensionCardFilterValue,
                    )
                  : activeGeoDimensionCardFilterValue;
                if (!activeGeoFilterValue) return [...rows];
                return rows.filter(
                  (row) =>
                    (row.filterValue ?? row.label) === activeGeoFilterValue,
                );
              }}
              compareRows={comparePageRows}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={{
                labels: messages.common.tableExport,
              }}
              className="h-full"
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

interface OverviewDataSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

function useOverviewSummaryQuery({
  siteId,
  window: timeWindow,
  filters,
}: Pick<OverviewDataSectionProps, "siteId" | "window" | "filters">) {
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);

  return useQuery({
    queryKey: [
      "dashboard",
      "overview-summary",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const current = await fetchOverview(siteId, timeWindow, filters, {
        includeChange: true,
        includeDetail: true,
        signal,
      }).catch((error) => fallbackUnlessAborted(error, emptyOverviewData));
      const previousTo = Math.max(timeWindow.from - 1, 0);
      const previousFrom = Math.max(
        previousTo - (timeWindow.to - timeWindow.from),
        0,
      );
      const previousWindow: TimeWindow = {
        ...timeWindow,
        from: previousFrom,
        to: previousTo,
      };
      const [previous, trend] = await Promise.all([
        current.previousData
          ? Promise.resolve({
              ok: current.ok,
              data: current.previousData,
            } as OverviewData)
          : fetchOverview(siteId, previousWindow, filters, { signal }).catch(
              (error) => fallbackUnlessAborted(error, emptyOverviewData),
            ),
        current.detail
          ? Promise.resolve({
              ok: current.ok,
              interval: current.detail.interval,
              data: current.detail.data,
            } as TrendData)
          : fetchTrend(siteId, timeWindow, filters, { signal }).catch((error) =>
              fallbackUnlessAborted(error, () =>
                emptyTrendData(timeWindow.interval),
              ),
            ),
      ]);

      return {
        overview: current,
        previousOverview: previous,
        trendData: trend,
        dataWindow: {
          from: timeWindow.from,
          to: timeWindow.to,
          interval: timeWindow.interval,
          timeZone: timeWindow.timeZone,
        },
      };
    },
    enabled: typeof window !== "undefined",
    placeholderData: keepPreviousData,
  });
}

export function OverviewMetricsSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const {
    data: metricsData,
    isFetching,
    isPending,
  } = useOverviewSummaryQuery({ siteId, window, filters });
  const loading = isPending || isFetching;
  const overview = metricsData?.overview ?? emptyOverviewData();
  const previousOverview = metricsData?.previousOverview ?? emptyOverviewData();
  const detailSeries = metricsData?.trendData.data ?? [];

  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );
  const previous = previousOverview.data;
  const currentPagesPerSession =
    overview.data.sessions > 0
      ? overview.data.views / overview.data.sessions
      : 0;
  const previousPagesPerSession =
    previous.sessions > 0 ? previous.views / previous.sessions : 0;

  const viewsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.views,
  }));
  const visitorsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.visitors,
  }));
  const sessionsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.sessions,
  }));
  const bounceRateSeries = detailSeries
    .filter((point) => point.sessions > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.bounces / point.sessions,
    }));
  const pagesPerSessionSeries = detailSeries
    .filter((point) => point.sessions > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.views / point.sessions,
    }));
  const avgDurationSeries = detailSeries
    .filter((point) => point.views > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.avgDurationMs,
    }));
  const metricChartAnimationKey = useMemo(() => {
    const firstTimestamp = detailSeries[0]?.timestampMs ?? 0;
    const lastTimestamp =
      detailSeries[detailSeries.length - 1]?.timestampMs ?? 0;
    return `${detailSeries.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [detailSeries]);

  const metrics = [
    {
      label: messages.common.views,
      value: numberFormat(locale, overview.data.views),
      delta: toDeltaPercent(overview.data.views, previous.views),
      trend: viewsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.visitors,
      value: numberFormat(locale, overview.data.visitors),
      delta: toDeltaPercent(overview.data.visitors, previous.visitors),
      trend: visitorsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.sessions,
      value: numberFormat(locale, overview.data.sessions),
      delta: toDeltaPercent(overview.data.sessions, previous.sessions),
      trend: sessionsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.bounceRate,
      value: percentFormat(locale, overview.data.bounceRate),
      delta: toDeltaPercent(overview.data.bounceRate, previous.bounceRate),
      lowerIsBetter: true,
      trend: bounceRateSeries,
      formatTrendValue: (value: number) => percentFormat(locale, value),
    },
    {
      label: messages.teamManagement.sites.pagesPerSession,
      value: pagesPerSessionFormatter.format(currentPagesPerSession),
      delta: toDeltaPercent(currentPagesPerSession, previousPagesPerSession),
      trend: pagesPerSessionSeries,
      formatTrendValue: (value: number) =>
        pagesPerSessionFormatter.format(value),
    },
    {
      label: messages.common.avgDuration,
      value: durationFormat(locale, overview.data.avgDurationMs),
      delta: toDeltaPercent(
        overview.data.avgDurationMs,
        previous.avgDurationMs,
      ),
      trend: avgDurationSeries,
      formatTrendValue: (value: number) =>
        durationFormat(locale, Math.max(0, Math.round(value))),
    },
  ];

  return (
    <Card className="gap-0 py-0">
      <CardContent className="px-0">
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {metrics.map((item, index) => {
            const hasDelta =
              typeof item.delta === "number" && Number.isFinite(item.delta);
            const effectiveDelta = hasDelta ? (item.delta ?? 0) : null;

            return (
              <div key={item.label} className={metricCellBorderClasses(index)}>
                <div className="relative min-h-[74px]">
                  <div className="absolute inset-y-0 right-0 w-1/2 min-w-0">
                    <MetricAreaMap
                      points={item.trend}
                      color={METRIC_AREA_COLOR}
                      locale={locale}
                      label={item.label}
                      formatValue={item.formatTrendValue}
                      animationKey={metricChartAnimationKey}
                    />
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-h-[74px] min-w-0 flex-col justify-between px-3 py-2.5">
                    <p className="truncate text-xs text-muted-foreground mb-4">
                      {item.label}
                    </p>
                    <div>
                      <AutoResizer initial>
                        <AutoTransition initial>
                          {loading ? (
                            <div
                              key="loading"
                              className="inline-flex h-6 items-center"
                            >
                              <Spinner className="size-5" />
                            </div>
                          ) : (
                            <p
                              key="value"
                              className="inline-flex h-6 items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                            >
                              <span>{item.value}</span>
                              <ChangeRateInline
                                value={effectiveDelta}
                                lowerIsBetter={item.lowerIsBetter}
                              />
                            </p>
                          )}
                        </AutoTransition>
                      </AutoResizer>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
  );
}

export function OverviewTrendSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const currentDataWindow = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.timeZone, window.to],
  );
  const {
    data: trendQueryData,
    isFetching,
    isPending,
  } = useOverviewSummaryQuery({ siteId, window, filters });
  const loading = isPending || isFetching;
  const trendData =
    trendQueryData?.trendData ?? emptyTrendData(window.interval);
  const dataWindow = trendQueryData?.dataWindow ?? currentDataWindow;
  const hasTrendData = Boolean(trendQueryData);

  const trendDisplayData = useMemo(() => {
    if (!hasTrendData && isPending) {
      return buildEmptyTrendData(dataWindow);
    }
    return normalizeTrendData(dataWindow, trendData.data);
  }, [
    dataWindow.from,
    dataWindow.interval,
    dataWindow.timeZone,
    dataWindow.to,
    hasTrendData,
    isPending,
    trendData.data,
  ]);
  const visitorTrendChartData = useMemo(
    () =>
      trendDisplayData.map((point) => ({
        timestampMs: point.timestampMs,
        views: point.views,
        sessions: point.visitors,
      })),
    [trendDisplayData],
  );
  const showTrendOverlayLoading = loading && hasTrendData;

  return (
    <Card className="overflow-visible">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="inline-flex items-center gap-2">
          <RiLineChartLine className="size-4" />
          {messages.overview.trendTitle}
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {messages.common.lastUpdated}:{" "}
          {shortDateTime(locale, Date.now(), dataWindow.timeZone)}
        </span>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div>
            <TrendChart
              locale={locale}
              timeZone={dataWindow.timeZone}
              interval={dataWindow.interval}
              data={visitorTrendChartData}
              viewsLabel={messages.common.views}
              sessionsLabel={messages.common.visitors}
            />
          </div>
          <AutoTransition
            type="fade"
            duration={0.22}
            className="pointer-events-none absolute top-2 right-2"
          >
            {showTrendOverlayLoading ? (
              <span
                key="overview-trend-overlay-loading"
                className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
              >
                <Spinner className="size-3.5" />
                {messages.common.loading}
              </span>
            ) : (
              <div
                key="overview-trend-overlay-idle"
                className="h-0 w-0 overflow-hidden"
              />
            )}
          </AutoTransition>
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
}: OverviewClientPageProps) {
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || pathname;
  const { window } = useDashboardQuery();
  const searchParamsKey = searchParams.toString();
  const requestFilters = useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const selectedGeoValue = dashboardFilterValue(requestFilters, "geo") ?? null;
  const selectedGeoCountry = useMemo(() => {
    return extractGeoCountryCodeFromFilterValue(selectedGeoValue);
  }, [selectedGeoValue]);
  const handleMapCountrySelect = useCallback(
    (countryCode: string | null) => {
      const normalizedCurrent = String(selectedGeoCountry ?? "")
        .trim()
        .toUpperCase();
      const normalizedNext = String(countryCode ?? "")
        .trim()
        .toUpperCase();
      const nextCountry =
        normalizedNext.length > 0 && normalizedNext !== normalizedCurrent
          ? normalizedNext
          : undefined;
      const nextDocument = setDashboardFilterValue(
        requestFilters,
        "geo",
        nextCountry,
      );
      const params = withDashboardFilterSearchParams(
        searchParams,
        nextDocument,
      );
      const nextQuery = serializeDashboardSearchParams(params);
      const target = nextQuery ? `${livePathname}?${nextQuery}` : livePathname;
      const current = serializeDashboardSearchParams(searchParams);
      if (nextQuery !== current) {
        replaceUrlWithoutNavigation(target);
      }
    },
    [livePathname, requestFilters, searchParams, selectedGeoCountry],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
      />
      <OverviewMetricsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={requestFilters}
      />
      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={requestFilters}
      />
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={requestFilters}
      />
      <OverviewGeoPointsMapCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={requestFilters}
        selectedCountryCode={selectedGeoCountry}
        onCountrySelect={handleMapCountrySelect}
      />
    </div>
  );
}
