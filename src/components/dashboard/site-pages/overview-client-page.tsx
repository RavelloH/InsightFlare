"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  RiArrowDownLine,
  RiArrowRightUpLine,
  RiSearchLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiArrowUpSLine,
} from "@remixicon/react";
import { Icon } from "@iconify/react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { TabbedScrollMaskCard } from "@/components/dashboard/tabbed-scroll-mask-card";
import { OverviewGeoPointsMapCard } from "@/components/dashboard/overview-geo-points-map-card";
import { Spinner } from "@/components/ui/spinner";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import {
  emptyReferrersData,
  emptyPageCardTabsData,
  emptyOverviewClientDimensionTabsData,
  emptyOverviewGeoDimensionTabsData,
  fetchOverview,
  fetchOverviewPanels,
  fetchTrend,
  type OverviewClientDimensionTabsData,
  type OverviewGeoDimensionTabsData,
  type PageCardTabsData,
} from "@/lib/dashboard/client-data";
import type { OverviewData, ReferrersData, TrendData } from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import {
  useDashboardQuery,
} from "@/components/dashboard/dashboard-query-provider";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
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
  window: Pick<TimeWindow, "from" | "to" | "interval">,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return [];
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const totalBuckets = toBucket - fromBucket + 1;
  const stride = Math.max(
    1,
    Math.ceil(totalBuckets / MAX_TREND_PLACEHOLDER_POINTS),
  );
  const points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];

  for (let bucket = fromBucket; bucket <= toBucket; bucket += stride) {
    points.push({
      timestampMs: bucket * stepMs,
      views: 0,
      sessions: 0,
    });
  }

  const lastTimestampMs = toBucket * stepMs;
  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      views: 0,
      sessions: 0,
    });
  }

  return points;
}

function normalizeTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval">,
  points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }>,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return points;
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const byBucket = new Map<number, { views: number; sessions: number }>();

  for (const point of points) {
    const bucket = Math.floor(Number(point.timestampMs ?? 0) / stepMs);
    if (!Number.isFinite(bucket) || bucket < fromBucket || bucket > toBucket) {
      continue;
    }
    const prev = byBucket.get(bucket) ?? { views: 0, sessions: 0 };
    byBucket.set(bucket, {
      views: prev.views + Math.max(0, Number(point.views ?? 0)),
      sessions: prev.sessions + Math.max(0, Number(point.sessions ?? 0)),
    });
  }

  const normalized: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];
  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    const value = byBucket.get(bucket);
    normalized.push({
      timestampMs: bucket * stepMs,
      views: value?.views ?? 0,
      sessions: value?.sessions ?? 0,
    });
  }

  return normalized;
}

function metricCellBorderClasses(index: number): string {
  const mobileHasTop = index >= 1;
  const wideHasLeft = index % 3 !== 0;
  const wideHasTop = index >= 3;

  return cn(
    mobileHasTop ? "border-t" : "",
    wideHasLeft ? "sm:border-l" : "sm:border-l-0",
    wideHasTop ? "sm:border-t" : "sm:border-t-0",
  );
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({ value }: { value: number | null }) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
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

type PageCardTab = "path" | "title" | "hostname" | "entry" | "exit";
type PageCardSortKey = "views" | "sessions";
type PageCardNavigableTab = "path" | "hostname" | "entry" | "exit";
type SourceCardTab = "domain" | "link";
type ClientDimensionCardTab = keyof OverviewClientDimensionTabsData;
type GeoDimensionCardTab = keyof OverviewGeoDimensionTabsData;
type GeoLocationTab = Extract<GeoDimensionCardTab, "country" | "region" | "city">;

interface PageCardRow {
  key: string;
  label: string;
  rawLabel?: string;
  views: number;
  sessions: number;
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
  filterValue: string;
  targetUrl: string | null;
  views: number;
  sessions: number;
  mono: boolean;
}

const PAGE_CARD_TABS: PageCardTab[] = [
  "path",
  "title",
  "hostname",
  "entry",
  "exit",
];
const PAGE_CARD_NAVIGABLE_TABS = new Set<PageCardNavigableTab>([
  "path",
  "hostname",
  "entry",
  "exit",
]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const PAGE_CARD_QUERY_PARAM_BY_TAB: Record<PageCardTab, string> = {
  path: "path",
  title: "title",
  hostname: "hostname",
  entry: "entry",
  exit: "exit",
};
const SOURCE_CARD_QUERY_PARAM_BY_TAB: Record<SourceCardTab, string> = {
  domain: "sourceDomain",
  link: "sourceLink",
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
const CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB: Record<
  ClientDimensionCardTab,
  string
> = {
  browser: "clientBrowser",
  osVersion: "clientOsVersion",
  deviceType: "clientDeviceType",
  language: "clientLanguage",
  screenSize: "clientScreenSize",
};
const GEO_QUERY_PARAM = "geo";
const LEGACY_GEO_QUERY_PARAMS = ["geoCountry", "geoRegion", "geoCity"] as const;
const GEO_AUX_QUERY_PARAM_BY_TAB: Record<
  Exclude<GeoDimensionCardTab, GeoLocationTab>,
  string
> = {
  continent: "geoContinent",
  timezone: "geoTimezone",
  organization: "geoOrganization",
};
const DIRECT_REFERRER_FILTER_VALUE = "__direct__";
const PANEL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;
const GEO_REGION_VALUE_SEPARATOR = "::";
const GEO_TRANSLATION_API_BASE_URL = "https://locale.ravelloh.com";
const GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE: Record<Locale, string | null> =
  {
    en: null,
    zh: "zh-CN",
  };
const GEO_STATE_CODE_PATTERN = /^[A-Z0-9-]{1,16}$/;

interface GeoTranslationCity {
  name: string;
  nameDefault: string;
  nativeName: string;
}

interface GeoStateTranslationBundle {
  stateName: string;
  cities: GeoTranslationCity[];
}

const geoStateTranslationCache = new Map<
  string,
  Promise<GeoStateTranslationBundle | null>
>();

function resolveGeoTranslationApiLocale(locale: Locale): string | null {
  return GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE[locale] ?? null;
}

function normalizeGeoTranslationLookupValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSameGeoLabel(left: string, right: string): boolean {
  const normalizedLeft = normalizeGeoTranslationLookupValue(left).replace(
    /\s+/g,
    " ",
  );
  const normalizedRight = normalizeGeoTranslationLookupValue(right).replace(
    /\s+/g,
    " ",
  );
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
}

function parseGeoStateTranslationBundle(
  payload: unknown,
): GeoStateTranslationBundle | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    state?: unknown;
    cities?: unknown;
  };

  const state =
    record.state && typeof record.state === "object"
      ? (record.state as Record<string, unknown>)
      : null;
  const stateName = typeof state?.name === "string" ? state.name.trim() : "";

  const cities = Array.isArray(record.cities)
    ? record.cities.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const city = entry as Record<string, unknown>;
        const name = typeof city.name === "string" ? city.name.trim() : "";
        const nameDefault =
          typeof city.name_default === "string" ? city.name_default.trim() : "";
        const nativeName =
          typeof city.native === "string" ? city.native.trim() : "";
        if (!name && !nameDefault && !nativeName) return [];
        return [{ name, nameDefault, nativeName }];
      })
    : [];

  return {
    stateName,
    cities,
  };
}

async function fetchGeoStateTranslationBundle(
  apiLocale: string,
  countryCode: string,
  stateCode: string,
): Promise<GeoStateTranslationBundle | null> {
  const normalizedCountry = countryCode.trim().toUpperCase();
  const normalizedState = stateCode.trim().toUpperCase();
  if (
    !normalizedCountry ||
    !normalizedState ||
    !GEO_STATE_CODE_PATTERN.test(normalizedState)
  ) {
    return null;
  }

  const cacheKey = `${apiLocale}::${normalizedCountry}::${normalizedState}`;
  const cached = geoStateTranslationCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    `${GEO_TRANSLATION_API_BASE_URL}/${encodeURIComponent(apiLocale)}/${encodeURIComponent(normalizedCountry)}/${encodeURIComponent(normalizedState)}/`,
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      return parseGeoStateTranslationBundle(payload);
    })
    .catch(() => null);

  geoStateTranslationCache.set(cacheKey, request);
  return request;
}

function resolveLocalizedCityName(
  bundle: GeoStateTranslationBundle | null,
  cityNameDefault: string,
): string | null {
  if (!bundle) return null;
  const target = normalizeGeoTranslationLookupValue(cityNameDefault);
  if (!target) return null;

  for (const city of bundle.cities) {
    const localized = normalizeGeoTranslationLookupValue(city.name);
    const fallback = normalizeGeoTranslationLookupValue(city.nameDefault);
    const nativeName = normalizeGeoTranslationLookupValue(city.nativeName);
    if (target === fallback || target === localized || target === nativeName) {
      return city.name || city.nameDefault || city.nativeName || null;
    }
  }

  return null;
}

function useInViewOnce(rootMargin = "0px"): {
  ref: MutableRefObject<HTMLSpanElement | null>;
  isInView: boolean;
} {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    if (isInView) return;
    const target = ref.current;
    if (!target) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const visible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        if (!visible) return;
        setIsInView(true);
        observer.disconnect();
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [isInView, rootMargin]);

  return { ref, isInView };
}

function useGeoStateTranslationBundle({
  locale,
  countryCode,
  stateCode,
  enabled,
}: {
  locale: Locale;
  countryCode: string;
  stateCode: string;
  enabled: boolean;
}): GeoStateTranslationBundle | null {
  const [bundle, setBundle] = useState<GeoStateTranslationBundle | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBundle(null);
      return;
    }
    const apiLocale = resolveGeoTranslationApiLocale(locale);
    if (!apiLocale) {
      setBundle(null);
      return;
    }

    const normalizedCountry = countryCode.trim().toUpperCase();
    const normalizedState = stateCode.trim().toUpperCase();
    if (
      !normalizedCountry ||
      !normalizedState ||
      !GEO_STATE_CODE_PATTERN.test(normalizedState)
    ) {
      setBundle(null);
      return;
    }

    let active = true;
    fetchGeoStateTranslationBundle(
      apiLocale,
      normalizedCountry,
      normalizedState,
    ).then((nextBundle) => {
      if (!active) return;
      setBundle(nextBundle);
    });

    return () => {
      active = false;
    };
  }, [countryCode, enabled, locale, stateCode]);

  return bundle;
}

function isPageCardNavigableTab(tab: PageCardTab): tab is PageCardNavigableTab {
  return PAGE_CARD_NAVIGABLE_TABS.has(tab as PageCardNavigableTab);
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

interface SearchParamsLike {
  get: (name: string) => string | null;
}

function normalizeOverviewFilterValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 160);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveGeoQueryValueFromSearchParams(searchParams: SearchParamsLike): string | undefined {
  const primary = normalizeOverviewFilterValue(searchParams.get(GEO_QUERY_PARAM));
  if (primary) return primary;
  for (const key of LEGACY_GEO_QUERY_PARAMS) {
    const fallback = normalizeOverviewFilterValue(searchParams.get(key));
    if (fallback) return fallback;
  }
  return undefined;
}

function clearLegacyGeoQueryParams(params: URLSearchParams): void {
  for (const key of LEGACY_GEO_QUERY_PARAMS) {
    params.delete(key);
  }
}

function extractGeoCountryCodeFromFilterValue(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const country = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())[0]
    ?.toUpperCase();
  if (!country) return null;
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function parseOverviewCardFilters(searchParams: SearchParamsLike): DashboardFilters {
  return {
    country: normalizeOverviewFilterValue(searchParams.get("country")),
    device: normalizeOverviewFilterValue(searchParams.get("device")),
    browser: normalizeOverviewFilterValue(searchParams.get("browser")),
    path: normalizeOverviewFilterValue(searchParams.get(PAGE_CARD_QUERY_PARAM_BY_TAB.path)),
    title: normalizeOverviewFilterValue(searchParams.get(PAGE_CARD_QUERY_PARAM_BY_TAB.title)),
    hostname: normalizeOverviewFilterValue(searchParams.get(PAGE_CARD_QUERY_PARAM_BY_TAB.hostname)),
    entry: normalizeOverviewFilterValue(searchParams.get(PAGE_CARD_QUERY_PARAM_BY_TAB.entry)),
    exit: normalizeOverviewFilterValue(searchParams.get(PAGE_CARD_QUERY_PARAM_BY_TAB.exit)),
    sourceDomain: normalizeOverviewFilterValue(searchParams.get(SOURCE_CARD_QUERY_PARAM_BY_TAB.domain)),
    sourceLink: normalizeOverviewFilterValue(searchParams.get(SOURCE_CARD_QUERY_PARAM_BY_TAB.link)),
    clientBrowser: normalizeOverviewFilterValue(
      searchParams.get(CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB.browser),
    ),
    clientOsVersion: normalizeOverviewFilterValue(
      searchParams.get(CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB.osVersion),
    ),
    clientDeviceType: normalizeOverviewFilterValue(
      searchParams.get(CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB.deviceType),
    ),
    clientLanguage: normalizeOverviewFilterValue(
      searchParams.get(CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB.language),
    ),
    clientScreenSize: normalizeOverviewFilterValue(
      searchParams.get(CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB.screenSize),
    ),
    geoContinent: normalizeOverviewFilterValue(
      searchParams.get(GEO_AUX_QUERY_PARAM_BY_TAB.continent),
    ),
    geoTimezone: normalizeOverviewFilterValue(
      searchParams.get(GEO_AUX_QUERY_PARAM_BY_TAB.timezone),
    ),
    geoOrganization: normalizeOverviewFilterValue(
      searchParams.get(GEO_AUX_QUERY_PARAM_BY_TAB.organization),
    ),
    geo:
      canonicalizeGeoFilterValue(
        resolveGeoQueryValueFromSearchParams(searchParams),
      ) ?? undefined,
  };
}

function isGeoLocationTab(tab: GeoDimensionCardTab): tab is GeoLocationTab {
  return tab === "country" || tab === "region" || tab === "city";
}

function canonicalizeGeoFilterValue(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return null;
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const country = segments[0]?.toUpperCase();
  if (!country) return null;
  if (segments.length === 1) return country;
  return [country, ...segments.slice(1)].join(GEO_REGION_VALUE_SEPARATOR);
}

function resolveGeoLocationHighlightValue(tab: GeoLocationTab, geoFilterValue: string | null): string | null {
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
      ? `${countryCode}${GEO_REGION_VALUE_SEPARATOR}${effectiveStateCode}${GEO_REGION_VALUE_SEPARATOR}${effectiveStateName}`
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
  const hideCity =
    isSameGeoLabel(rawStateName, rawCity) ||
    (hideRegion && isSameGeoLabel(countryLabel, cityLabel));

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
        ? `${countryCode}${GEO_REGION_VALUE_SEPARATOR}${effectiveStateCode}${GEO_REGION_VALUE_SEPARATOR}${effectiveStateName}${GEO_REGION_VALUE_SEPARATOR}${effectiveCity}`
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
      return `${segments[0].toUpperCase()}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments.slice(2).join(GEO_REGION_VALUE_SEPARATOR)}`;
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
    return `${breadcrumb.countryCode.toUpperCase()}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.stateCode}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.regionLabel}`;
  }

  if (segments.length >= 4) {
    return `${segments[0].toUpperCase()}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments[2]}${GEO_REGION_VALUE_SEPARATOR}${segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR)}`;
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
    return `${country}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.cityNameDefault}`;
  }
  if (
    normalizeGeoTranslationLookupValue(breadcrumb.cityNameDefault) ===
      unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.regionLabel) === unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.countryCode) === unknown
  ) {
    return null;
  }
  return `${breadcrumb.countryCode.toUpperCase()}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.stateCode}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.regionLabel}${GEO_REGION_VALUE_SEPARATOR}${breadcrumb.cityNameDefault}`;
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
  } else if (normalized.includes("ucbrowser") || normalized.includes("uc browser")) {
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

function RegionBreadcrumbLabel({
  locale,
  countryLabel,
  countryIconName,
  regionLabel,
  countryCode,
  stateCode,
  hideRegion,
}: {
  locale: Locale;
  countryLabel: string;
  countryIconName: string | null;
  regionLabel: string;
  countryCode: string;
  stateCode: string;
  hideRegion: boolean;
}) {
  const { ref: visibilityRef, isInView } = useInViewOnce();
  const translationBundle = useGeoStateTranslationBundle({
    locale,
    countryCode,
    stateCode,
    enabled: isInView && !hideRegion,
  });
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;

  return (
    <span ref={visibilityRef} className="block">
      <Breadcrumb className="max-w-full">
        <BreadcrumbList className="flex-nowrap gap-1">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="inline-flex min-w-0 items-center gap-2">
              {countryIconName ? (
                <Icon
                  icon={countryIconName}
                  style={{
                    width: 16,
                    height: 12,
                  }}
                  className="block shrink-0"
                />
              ) : null}
              <span className="truncate leading-5">{countryLabel}</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
          {hideRegion ? null : (
            <BreadcrumbItem className="min-w-0">
              <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                {">"}
              </span>
              <BreadcrumbPage className="block truncate leading-5">
                <AutoTransition>{localizedRegionLabel}</AutoTransition>
              </BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </span>
  );
}

function CityBreadcrumbLabel({
  locale,
  countryLabel,
  countryIconName,
  regionLabel,
  cityLabel,
  countryCode,
  stateCode,
  cityNameDefault,
  hideRegion,
  hideCity,
}: {
  locale: Locale;
  countryLabel: string;
  countryIconName: string | null;
  regionLabel: string;
  cityLabel: string;
  countryCode: string;
  stateCode: string;
  cityNameDefault: string;
  hideRegion: boolean;
  hideCity: boolean;
}) {
  const { ref: visibilityRef, isInView } = useInViewOnce();
  const translationBundle = useGeoStateTranslationBundle({
    locale,
    countryCode,
    stateCode,
    enabled: isInView && !hideRegion,
  });
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;
  const localizedCityLabel =
    resolveLocalizedCityName(translationBundle, cityNameDefault) || cityLabel;
  const shouldHideCity =
    hideCity ||
    (!hideRegion && isSameGeoLabel(localizedRegionLabel, localizedCityLabel)) ||
    (hideRegion && isSameGeoLabel(countryLabel, localizedCityLabel));

  return (
    <span ref={visibilityRef} className="block">
      <Breadcrumb className="max-w-full">
        <BreadcrumbList className="flex-nowrap gap-1">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="inline-flex min-w-0 items-center gap-2">
              {countryIconName ? (
                <Icon
                  icon={countryIconName}
                  style={{
                    width: 16,
                    height: 12,
                  }}
                  className="block shrink-0"
                />
              ) : null}
              <span className="truncate">{countryLabel}</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
          <AutoTransition className="flex gap-1">
            {hideRegion ? null : (
              <BreadcrumbItem className="min-w-0" key={localizedRegionLabel}>
                <span
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  {">"}
                </span>
                <BreadcrumbPage className="block truncate leading-5">
                  {localizedRegionLabel}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
            {shouldHideCity ? null : (
              <BreadcrumbItem className="min-w-0">
                <span
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  {">"}
                </span>
                <BreadcrumbPage className="block truncate leading-5">
                  {localizedCityLabel}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </AutoTransition>
        </BreadcrumbList>
      </Breadcrumb>
    </span>
  );
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
  locale: Locale,
): string {
  const sign = deltaMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(deltaMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  const delta = `${sign}${hours}:${minutes}`;
  if (locale === "zh") {
    return `较本地 ${delta}`;
  }
  return `${delta} vs local`;
}

function resolveTimezoneDisplayLabel(params: {
  value: string;
  locale: Locale;
  unknownLabel: string;
  timestampMs: number;
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
    return `${prefix} (${formatUtcOffset(offsetMinutes)}, ${formatLocalTimeDeltaLabel(localDelta, params.locale)})`;
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

function PanelScrollbar({
  children,
  className,
  syncKey,
}: {
  children: ReactNode;
  className?: string;
  syncKey?: string | number | boolean | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;
    instance.update(true);

    return () => {
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    scrollbarRef.current?.update(true);
  }, [syncKey]);

  return (
    <div
      ref={hostRef}
      className={cn("overflow-hidden", className)}
      data-overlayscrollbars-initialize
    >
      {children}
    </div>
  );
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
          <AreaChart data={chartData} margin={{ top: 12, right: 0, left: 0, bottom: 0 }}>
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

function OverviewPagesSection({
  locale,
  messages,
  siteId,
  pathname,
  filters,
}: OverviewClientPageProps & { filters: DashboardFilters }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const livePathname = usePathname() || pathname;
  const isMobile = useIsMobile();
  const { window } = useDashboardQuery();
  const timezoneReferenceTimestampMs = useMemo(() => {
    const from = Number(window.from ?? 0);
    const to = Number(window.to ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Date.now();
    if (to <= from) return Math.max(0, Math.floor(from));
    return Math.floor(from + (to - from) / 2);
  }, [window.from, window.to]);
  const [pageCardTabsData, setPageCardTabsData] = useState<PageCardTabsData>(
    emptyPageCardTabsData(),
  );
  const [pageCardLoading, setPageCardLoading] = useState(true);
  const [sourceCardData, setSourceCardData] =
    useState<ReferrersData>(emptyReferrersData());
  const [sourceCardLoading, setSourceCardLoading] = useState(true);
  const [overviewClientDimensionTabsData, setOverviewClientDimensionTabsData] =
    useState<OverviewClientDimensionTabsData>(
      emptyOverviewClientDimensionTabsData(),
    );
  const [overviewGeoDimensionTabsData, setOverviewGeoDimensionTabsData] =
    useState<OverviewGeoDimensionTabsData>(emptyOverviewGeoDimensionTabsData());
  const [dimensionCardsLoading, setDimensionCardsLoading] = useState(true);
  const [pageCardTab, setPageCardTab] = useState<PageCardTab>("path");
  const [sourceCardTab, setSourceCardTab] = useState<SourceCardTab>("domain");
  const [clientDimensionCardTab, setClientDimensionCardTab] =
    useState<ClientDimensionCardTab>("browser");
  const [geoDimensionCardTab, setGeoDimensionCardTab] =
    useState<GeoDimensionCardTab>("country");
  const [pageCardSort, setPageCardSort] = useState<{
    key: PageCardSortKey;
    direction: "asc" | "desc";
  }>({
    key: "views",
    direction: "desc",
  });
  const [sourceCardSort, setSourceCardSort] = useState<{
    key: PageCardSortKey;
    direction: "asc" | "desc";
  }>({
    key: "views",
    direction: "desc",
  });
  const [clientDimensionCardSort, setClientDimensionCardSort] = useState<{
    key: PageCardSortKey;
    direction: "asc" | "desc";
  }>({
    key: "views",
    direction: "desc",
  });
  const [geoDimensionCardSort, setGeoDimensionCardSort] = useState<{
    key: PageCardSortKey;
    direction: "asc" | "desc";
  }>({
    key: "views",
    direction: "desc",
  });
  const [pageCardSearchOpen, setPageCardSearchOpen] = useState(false);
  const [pageCardSearchTerm, setPageCardSearchTerm] = useState("");
  const [sourceCardSearchOpen, setSourceCardSearchOpen] = useState(false);
  const [sourceCardSearchTerm, setSourceCardSearchTerm] = useState("");
  const [clientDimensionCardSearchOpen, setClientDimensionCardSearchOpen] =
    useState(false);
  const [clientDimensionCardSearchTerm, setClientDimensionCardSearchTerm] =
    useState("");
  const [geoDimensionCardSearchOpen, setGeoDimensionCardSearchOpen] =
    useState(false);
  const [geoDimensionCardSearchTerm, setGeoDimensionCardSearchTerm] =
    useState("");

  useEffect(() => {
    let active = true;
    setPageCardLoading(true);
    setSourceCardLoading(true);
    setDimensionCardsLoading(true);
    setPageCardTabsData(emptyPageCardTabsData());
    setSourceCardData(emptyReferrersData());
    setOverviewClientDimensionTabsData(emptyOverviewClientDimensionTabsData());
    setOverviewGeoDimensionTabsData(emptyOverviewGeoDimensionTabsData());

    fetchOverviewPanels(siteId, window, filters, {
      limit: 100,
    })
      .then((payload) => {
        if (!active) return;
        setPageCardTabsData(payload.pageTabs ?? emptyPageCardTabsData());
        setSourceCardData({
          ok: payload.ok,
          data: payload.referrers ?? emptyReferrersData().data,
        });
        setOverviewClientDimensionTabsData(
          payload.clientTabs ?? emptyOverviewClientDimensionTabsData(),
        );
        setOverviewGeoDimensionTabsData(
          payload.geoTabs ?? emptyOverviewGeoDimensionTabsData(),
        );
      })
      .finally(() => {
        if (!active) return;
        setPageCardLoading(false);
        setSourceCardLoading(false);
        setDimensionCardsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    siteId,
    window.from,
    window.to,
    window.interval,
    filters,
  ]);

  useEffect(() => {
    if (!pageCardSearchOpen) {
      setPageCardSearchTerm("");
    }
  }, [pageCardSearchOpen]);
  useEffect(() => {
    if (!sourceCardSearchOpen) {
      setSourceCardSearchTerm("");
    }
  }, [sourceCardSearchOpen]);
  useEffect(() => {
    if (!clientDimensionCardSearchOpen) {
      setClientDimensionCardSearchTerm("");
    }
  }, [clientDimensionCardSearchOpen]);
  useEffect(() => {
    if (!geoDimensionCardSearchOpen) {
      setGeoDimensionCardSearchTerm("");
    }
  }, [geoDimensionCardSearchOpen]);

  const noDataText = messages.common.noData;

  const pageCardTabMeta: Record<
    PageCardTab,
    { label: string; columnLabel: string; mono: boolean; showIcon: boolean }
  > = {
    path: {
      label: messages.common.path,
      columnLabel: messages.common.path,
      mono: true,
      showIcon: false,
    },
    title: {
      label: messages.common.title,
      columnLabel: messages.common.title,
      mono: false,
      showIcon: false,
    },
    hostname: {
      label: messages.common.hostname,
      columnLabel: messages.common.hostname,
      mono: true,
      showIcon: true,
    },
    entry: {
      label: messages.common.entryPage,
      columnLabel: messages.common.entryPage,
      mono: true,
      showIcon: false,
    },
    exit: {
      label: messages.common.exitPage,
      columnLabel: messages.common.exitPage,
      mono: true,
      showIcon: false,
    },
  };
  const pathRows = useMemo<PageCardRow[]>(
    () =>
      pageCardTabsData.path.map((item) => ({
        key: String(item.label || "/"),
        label: String(item.label || "/"),
        views: Math.max(0, Number(item.views || 0)),
        sessions: Math.max(0, Number(item.sessions || 0)),
        mono: true,
      })),
    [pageCardTabsData.path],
  );
  const titleRows = useMemo<PageCardRow[]>(
    () =>
      pageCardTabsData.title.map((item) => {
        const normalized = String(item.label || "").trim();
        const label =
          normalized.length > 0 ? normalized : messages.common.unknown;
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: false,
        };
      }),
    [messages.common.unknown, pageCardTabsData.title],
  );
  const hostnameRows = useMemo<PageCardRow[]>(
    () =>
      pageCardTabsData.hostname.map((item) => {
        const normalized = String(item.label || "").trim();
        const label =
          normalized.length > 0 ? normalized : messages.common.unknown;
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: true,
        };
      }),
    [messages.common.unknown, pageCardTabsData.hostname],
  );
  const entryRows = useMemo<PageCardRow[]>(
    () =>
      pageCardTabsData.entry.map((item) => {
        const label = String(item.label || "").trim() || "/";
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: true,
        };
      }),
    [pageCardTabsData.entry],
  );
  const exitRows = useMemo<PageCardRow[]>(
    () =>
      pageCardTabsData.exit.map((item) => {
        const label = String(item.label || "").trim() || "/";
        return {
          key: label,
          label,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: true,
        };
      }),
    [pageCardTabsData.exit],
  );
  const pageCardRows = useMemo<Record<PageCardTab, PageCardRow[]>>(
    () => ({
      path: pathRows,
      title: titleRows,
      hostname: hostnameRows,
      entry: entryRows,
      exit: exitRows,
    }),
    [pathRows, titleRows, hostnameRows, entryRows, exitRows],
  );
  const activePageTabMeta = pageCardTabMeta[pageCardTab];
  const sortedPageCardRows = useMemo(() => {
    const source = pageCardRows[pageCardTab];
    const direction = pageCardSort.direction === "asc" ? 1 : -1;

    return [...source].sort((left, right) => {
      const primary =
        (left[pageCardSort.key] - right[pageCardSort.key]) * direction;
      if (primary !== 0) return primary;
      return left.label.localeCompare(right.label);
    });
  }, [pageCardRows, pageCardSort.direction, pageCardSort.key, pageCardTab]);
  const pageCardProgressTotal = useMemo(
    () =>
      sortedPageCardRows.reduce(
        (sum, item) => sum + Math.max(0, Number(item[pageCardSort.key] ?? 0)),
        0,
      ),
    [sortedPageCardRows, pageCardSort.key],
  );
  const activePageCardQueryValue = useMemo(() => {
    const queryParamKey = PAGE_CARD_QUERY_PARAM_BY_TAB[pageCardTab];
    const raw = searchParams.get(queryParamKey);
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [pageCardTab, searchParams]);
  const visiblePageCardRows = useMemo(
    () =>
      activePageCardQueryValue
        ? sortedPageCardRows.filter(
            (row) => row.label === activePageCardQueryValue,
          )
        : sortedPageCardRows,
    [activePageCardQueryValue, sortedPageCardRows],
  );
  const normalizedPageCardSearchTerm = pageCardSearchTerm
    .trim()
    .toLocaleLowerCase();
  const searchedPageCardRows = useMemo(() => {
    if (!normalizedPageCardSearchTerm) return sortedPageCardRows;
    return sortedPageCardRows.filter((row) =>
      row.label.toLocaleLowerCase().includes(normalizedPageCardSearchTerm),
    );
  }, [normalizedPageCardSearchTerm, sortedPageCardRows]);
  const pageCardDefaultHostname = useMemo(() => {
    for (const row of hostnameRows) {
      const hostname = sanitizeHostname(row.label);
      if (hostname.length > 0) return hostname;
    }
    if (typeof globalThis.window !== "undefined") {
      return sanitizeHostname(globalThis.window.location.hostname);
    }
    return "";
  }, [hostnameRows]);
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
  };
  const sourceCardDirectLabel = messages.overview.direct;
  const sourceDomainRows = useMemo<SourceCardRow[]>(() => {
    const aggregate = new Map<
      string,
      { label: string; views: number; sessions: number; targetUrl: string | null }
    >();

    for (const item of sourceCardData.data) {
      const raw = String(item.referrer || "").trim();
      const absolute = raw.length > 0 ? toAbsoluteHttpsUrl(raw) : null;

      let domain = "";
      if (absolute) {
        try {
          domain = sanitizeHostname(new URL(absolute).hostname || "");
        } catch {
          domain = "";
        }
      }
      if (!domain && raw.length > 0) {
        domain = sanitizeHostname(raw);
      }

      const filterValue = domain || DIRECT_REFERRER_FILTER_VALUE;
      const label = domain || sourceCardDirectLabel;
      const nextViews = Math.max(0, Number(item.views || 0));
      const nextSessions = Math.max(0, Number(item.sessions || 0));
      const prev = aggregate.get(filterValue) ?? {
        label,
        views: 0,
        sessions: 0,
        targetUrl: null,
      };

      aggregate.set(filterValue, {
        label: prev.label || label,
        views: prev.views + nextViews,
        sessions: prev.sessions + nextSessions,
        targetUrl:
          prev.targetUrl ?? (domain ? toAbsoluteHttpsUrl(domain) : null),
      });
    }

    return Array.from(aggregate.entries()).map(([filterValue, value], index) => ({
      key: `domain-${filterValue}-${index}`,
      label: value.label,
      filterValue,
      targetUrl: value.targetUrl,
      views: value.views,
      sessions: value.sessions,
      mono: true,
    }));
  }, [sourceCardData.data, sourceCardDirectLabel]);
  const sourceLinkRows = useMemo<SourceCardRow[]>(() => {
    const aggregate = new Map<
      string,
      { label: string; views: number; sessions: number; targetUrl: string | null }
    >();

    for (const item of sourceCardData.data) {
      const raw = String(item.referrer || "").trim();
      const targetUrl = raw.length > 0 ? toAbsoluteHttpsUrl(raw) : null;
      const filterValue = raw.length > 0 ? raw : DIRECT_REFERRER_FILTER_VALUE;
      const label = raw.length > 0 ? (targetUrl ?? raw) : sourceCardDirectLabel;
      const nextViews = Math.max(0, Number(item.views || 0));
      const nextSessions = Math.max(0, Number(item.sessions || 0));
      const prev = aggregate.get(filterValue) ?? {
        label,
        views: 0,
        sessions: 0,
        targetUrl: null,
      };

      aggregate.set(filterValue, {
        label: prev.label || label,
        views: prev.views + nextViews,
        sessions: prev.sessions + nextSessions,
        targetUrl: prev.targetUrl ?? targetUrl,
      });
    }

    return Array.from(aggregate.entries()).map(([filterValue, value], index) => ({
      key: `link-${filterValue}-${index}`,
      label: value.label,
      filterValue,
      targetUrl: value.targetUrl,
      views: value.views,
      sessions: value.sessions,
      mono: true,
    }));
  }, [sourceCardData.data, sourceCardDirectLabel]);
  const sourceCardRows = useMemo<Record<SourceCardTab, SourceCardRow[]>>(
    () => ({
      domain: sourceDomainRows,
      link: sourceLinkRows,
    }),
    [sourceDomainRows, sourceLinkRows],
  );
  const activeSourceTabMeta = sourceCardTabMeta[sourceCardTab];
  const sortedSourceCardRows = useMemo(() => {
    const direction = sourceCardSort.direction === "asc" ? 1 : -1;
    return [...sourceCardRows[sourceCardTab]].sort((left, right) => {
      const primary =
        (left[sourceCardSort.key] - right[sourceCardSort.key]) * direction;
      if (primary !== 0) return primary;
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions)
        return right.sessions - left.sessions;
      return left.label.localeCompare(right.label);
    });
  }, [
    sourceCardRows,
    sourceCardSort.direction,
    sourceCardSort.key,
    sourceCardTab,
  ]);
  const activeSourceCardQueryValue = useMemo(() => {
    const queryParamKey = SOURCE_CARD_QUERY_PARAM_BY_TAB[sourceCardTab];
    const raw = searchParams.get(queryParamKey);
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [searchParams, sourceCardTab]);
  const visibleSourceCardRows = useMemo(
    () =>
      activeSourceCardQueryValue
        ? sortedSourceCardRows.filter(
            (row) => row.filterValue === activeSourceCardQueryValue,
          )
        : sortedSourceCardRows,
    [activeSourceCardQueryValue, sortedSourceCardRows],
  );
  const normalizedSourceCardSearchTerm = sourceCardSearchTerm
    .trim()
    .toLocaleLowerCase();
  const searchedSourceCardRows = useMemo(() => {
    if (!normalizedSourceCardSearchTerm) return sortedSourceCardRows;
    return sortedSourceCardRows.filter((row) =>
      row.label.toLocaleLowerCase().includes(normalizedSourceCardSearchTerm),
    );
  }, [normalizedSourceCardSearchTerm, sortedSourceCardRows]);
  const sourceCardProgressTotal = useMemo(
    () =>
      sortedSourceCardRows.reduce(
        (sum, item) => sum + Math.max(0, Number(item[sourceCardSort.key] ?? 0)),
        0,
      ),
    [sortedSourceCardRows, sourceCardSort.key],
  );
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
      label: locale === "zh" ? "国家/地区" : messages.common.country,
      columnLabel: locale === "zh" ? "国家/地区" : messages.common.country,
      mono: false,
    },
    region: {
      label: locale === "zh" ? "州/省" : messages.common.region,
      columnLabel: locale === "zh" ? "州/省" : messages.common.region,
      mono: false,
    },
    city: {
      label: locale === "zh" ? "市/县" : messages.common.city,
      columnLabel: locale === "zh" ? "市/县" : messages.common.city,
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
      rows: Array<{ label: string; views: number; sessions: number }>,
      options?: {
        mono?: boolean;
        screenSize?: boolean;
        transformLabel?: (value: string) => string;
        resolveIconName?: (value: string) => string | null;
        resolveFilterValue?: (rawValue: string, normalizedLabel: string) => string;
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
        const filterValue = options?.resolveFilterValue?.(rawValue, rawLabel) ?? rawLabel;
        return {
          key: `${label}-${index}`,
          label,
          rawLabel: rawValue.trim() || rawLabel,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: options?.mono ?? false,
          iconName: options?.resolveIconName?.(rawLabel) ?? null,
          filterValue,
        };
      });

    return {
      browser: toRows(overviewClientDimensionTabsData.browser, {
        resolveIconName: resolveBrowserLogoIconName,
      }),
      osVersion: toRows(overviewClientDimensionTabsData.osVersion, {
        resolveIconName: resolveOsLogoIconName,
      }),
      deviceType: toRows(overviewClientDimensionTabsData.deviceType),
      language: toRows(overviewClientDimensionTabsData.language, {
        transformLabel: (value) =>
          resolveLanguageLabel(value, locale, messages.common.unknown).label,
        resolveFilterValue: (rawValue, normalizedLabel) =>
          rawValue.trim() || normalizedLabel,
      }),
      screenSize: toRows(overviewClientDimensionTabsData.screenSize, {
        mono: true,
        screenSize: true,
      }),
    };
  }, [locale, messages.common.unknown, overviewClientDimensionTabsData]);
  const geoDimensionCardRows = useMemo<
    Record<GeoDimensionCardTab, PageCardRow[]>
  >(() => {
    const toRows = (
      rows: Array<{ label: string; views: number; sessions: number }>,
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
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: false,
          iconName: options?.resolveIconName?.(rawLabel) ?? null,
          filterValue: options?.resolveFilterValue?.(originalValue) ?? rawLabel,
        };
      });

    const regionRows: PageCardRow[] = overviewGeoDimensionTabsData.region.map(
      (item, index) => {
        const value = String(item.label || "");
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
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: false,
          iconName: null,
          filterValue: regionData.filterValue,
          regionBreadcrumb: regionData.breadcrumb,
        };
      },
    );
    const cityRows: PageCardRow[] = overviewGeoDimensionTabsData.city.map(
      (item, index) => {
        const value = String(item.label || "");
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
          sessions: Math.max(0, Number(item.sessions || 0)),
          mono: false,
          iconName: null,
          filterValue: cityData.filterValue,
          cityBreadcrumb: cityData.breadcrumb ?? undefined,
        };
      },
    );

    return {
      country: toRows(overviewGeoDimensionTabsData.country, {
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
      continent: toRows(overviewGeoDimensionTabsData.continent, {
        transformLabel: (value) =>
          resolveContinentLabel(
            value,
            messages.common.unknown,
            messages.common.continentLabels,
          ),
      }),
      timezone: toRows(overviewGeoDimensionTabsData.timezone, {
        transformLabel: (value) =>
          resolveTimezoneDisplayLabel({
            value,
            locale,
            unknownLabel: messages.common.unknown,
            timestampMs: timezoneReferenceTimestampMs,
          }),
      }),
      organization: toRows(overviewGeoDimensionTabsData.organization),
    };
  }, [
    locale,
    messages.common.continentLabels,
    messages.common.unknown,
    overviewGeoDimensionTabsData,
    timezoneReferenceTimestampMs,
  ]);
  const activeClientDimensionTabMeta =
    clientDimensionCardTabMeta[clientDimensionCardTab];
  const activeGeoDimensionTabMeta =
    geoDimensionCardTabMeta[geoDimensionCardTab];
  const sortedClientDimensionCardRows = useMemo(() => {
    const direction = clientDimensionCardSort.direction === "asc" ? 1 : -1;
    return [...clientDimensionCardRows[clientDimensionCardTab]].sort(
      (left, right) => {
        const primary =
          (left[clientDimensionCardSort.key] -
            right[clientDimensionCardSort.key]) *
          direction;
        if (primary !== 0) return primary;
        if (right.views !== left.views) return right.views - left.views;
        if (right.sessions !== left.sessions)
          return right.sessions - left.sessions;
        return left.label.localeCompare(right.label);
      },
    );
  }, [
    clientDimensionCardRows,
    clientDimensionCardSort.direction,
    clientDimensionCardSort.key,
    clientDimensionCardTab,
  ]);
  const sortedGeoDimensionCardRows = useMemo(() => {
    const direction = geoDimensionCardSort.direction === "asc" ? 1 : -1;
    return [...geoDimensionCardRows[geoDimensionCardTab]].sort(
      (left, right) => {
        const primary =
          (left[geoDimensionCardSort.key] - right[geoDimensionCardSort.key]) *
          direction;
        if (primary !== 0) return primary;
        if (right.views !== left.views) return right.views - left.views;
        if (right.sessions !== left.sessions)
          return right.sessions - left.sessions;
        return left.label.localeCompare(right.label);
      },
    );
  }, [
    geoDimensionCardRows,
    geoDimensionCardSort.direction,
    geoDimensionCardSort.key,
    geoDimensionCardTab,
  ]);
  const activeClientDimensionCardQueryValue = useMemo(() => {
    const queryParamKey =
      CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB[clientDimensionCardTab];
    const raw = searchParams.get(queryParamKey);
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [clientDimensionCardTab, searchParams]);
  const activeGeoDimensionCardQueryValue = useMemo(() => {
    if (isGeoLocationTab(geoDimensionCardTab)) {
      return (
        canonicalizeGeoFilterValue(
          resolveGeoQueryValueFromSearchParams(searchParams),
        ) ?? null
      );
    }
    const queryKey = GEO_AUX_QUERY_PARAM_BY_TAB[geoDimensionCardTab];
    const raw = searchParams.get(queryKey);
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [geoDimensionCardTab, searchParams]);
  const visibleClientDimensionCardRows = useMemo(
    () =>
      activeClientDimensionCardQueryValue
        ? sortedClientDimensionCardRows.filter(
            (row) =>
              (row.filterValue ?? row.label) ===
              activeClientDimensionCardQueryValue,
          )
        : sortedClientDimensionCardRows,
    [activeClientDimensionCardQueryValue, sortedClientDimensionCardRows],
  );
  const visibleGeoDimensionCardRows = useMemo(
    () => {
      if (!activeGeoDimensionCardQueryValue) return sortedGeoDimensionCardRows;
      if (isGeoLocationTab(geoDimensionCardTab)) return sortedGeoDimensionCardRows;
      return sortedGeoDimensionCardRows.filter(
        (row) =>
          (row.filterValue ?? row.label) === activeGeoDimensionCardQueryValue,
      );
    },
    [activeGeoDimensionCardQueryValue, geoDimensionCardTab, sortedGeoDimensionCardRows],
  );
  const normalizedClientDimensionCardSearchTerm = clientDimensionCardSearchTerm
    .trim()
    .toLocaleLowerCase();
  const normalizedGeoDimensionCardSearchTerm = geoDimensionCardSearchTerm
    .trim()
    .toLocaleLowerCase();
  const searchedClientDimensionCardRows = useMemo(() => {
    if (!normalizedClientDimensionCardSearchTerm)
      return sortedClientDimensionCardRows;
    return sortedClientDimensionCardRows.filter((row) =>
      row.label
        .toLocaleLowerCase()
        .includes(normalizedClientDimensionCardSearchTerm),
    );
  }, [normalizedClientDimensionCardSearchTerm, sortedClientDimensionCardRows]);
  const searchedGeoDimensionCardRows = useMemo(() => {
    if (!normalizedGeoDimensionCardSearchTerm)
      return sortedGeoDimensionCardRows;
    return sortedGeoDimensionCardRows.filter((row) => {
      const normalizedLabel = row.label.toLocaleLowerCase();
      if (normalizedLabel.includes(normalizedGeoDimensionCardSearchTerm)) {
        return true;
      }
      const normalizedRawLabel = (row.rawLabel || "").toLocaleLowerCase();
      return normalizedRawLabel.includes(normalizedGeoDimensionCardSearchTerm);
    });
  }, [normalizedGeoDimensionCardSearchTerm, sortedGeoDimensionCardRows]);
  const clientDimensionCardProgressTotal = useMemo(
    () =>
      sortedClientDimensionCardRows.reduce(
        (sum, item) =>
          sum + Math.max(0, Number(item[clientDimensionCardSort.key] ?? 0)),
        0,
      ),
    [sortedClientDimensionCardRows, clientDimensionCardSort.key],
  );
  const geoDimensionCardProgressTotal = useMemo(
    () =>
      sortedGeoDimensionCardRows.reduce(
        (sum, item) =>
          sum + Math.max(0, Number(item[geoDimensionCardSort.key] ?? 0)),
        0,
      ),
    [sortedGeoDimensionCardRows, geoDimensionCardSort.key],
  );

  const togglePageCardSort = (key: PageCardSortKey) => {
    setPageCardSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };
  const toggleSourceCardSort = (key: PageCardSortKey) => {
    setSourceCardSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };
  const toggleClientDimensionCardSort = (key: PageCardSortKey) => {
    setClientDimensionCardSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };
  const toggleGeoDimensionCardSort = (key: PageCardSortKey) => {
    setGeoDimensionCardSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };
  const setPageCardQueryFilter = (
    next: { tab: PageCardTab; value: string } | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    const activeTab = next?.tab ?? pageCardTab;
    const queryKey = PAGE_CARD_QUERY_PARAM_BY_TAB[activeTab];
    params.delete(queryKey);
    if (next) {
      const normalized = next.value.trim();
      if (normalized.length > 0) params.set(queryKey, normalized);
    }
    const current = searchParams.toString();
    const updated = params.toString();
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    router.replace(target, { scroll: false });
  };
  const setSourceCardQueryFilter = (
    next: { tab: SourceCardTab; value: string } | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    const activeTab = next?.tab ?? sourceCardTab;
    const queryKey = SOURCE_CARD_QUERY_PARAM_BY_TAB[activeTab];
    params.delete(queryKey);
    if (next) {
      const normalized = next.value.trim();
      if (normalized.length > 0) params.set(queryKey, normalized);
    }
    const current = searchParams.toString();
    const updated = params.toString();
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    router.replace(target, { scroll: false });
  };
  const setClientDimensionCardQueryFilter = (
    next: { tab: ClientDimensionCardTab; value: string } | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    const activeTab = next?.tab ?? clientDimensionCardTab;
    const queryKey = CLIENT_DIMENSION_CARD_QUERY_PARAM_BY_TAB[activeTab];
    params.delete(queryKey);
    if (next) {
      const normalized = next.value.trim();
      if (normalized.length > 0) params.set(queryKey, normalized);
    }
    const current = searchParams.toString();
    const updated = params.toString();
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    router.replace(target, { scroll: false });
  };
  const setGeoDimensionCardQueryFilter = (
    next: { tab: GeoDimensionCardTab; value: string } | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    const activeTab = next?.tab ?? geoDimensionCardTab;
    if (isGeoLocationTab(activeTab)) {
      params.delete(GEO_QUERY_PARAM);
      clearLegacyGeoQueryParams(params);
    } else {
      params.delete(GEO_AUX_QUERY_PARAM_BY_TAB[activeTab]);
    }
    if (next) {
      const normalized = next.value.trim();
      if (normalized.length > 0) {
        if (isGeoLocationTab(next.tab)) {
          const geoValue = canonicalizeGeoFilterValue(normalized);
          if (geoValue) params.set(GEO_QUERY_PARAM, geoValue);
        } else {
          params.set(GEO_AUX_QUERY_PARAM_BY_TAB[next.tab], normalized);
        }
      }
    }
    const current = searchParams.toString();
    const updated = params.toString();
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    router.replace(target, { scroll: false });
  };
  const handlePageCardTabChange = (tab: PageCardTab) => {
    if (tab !== pageCardTab) {
      setPageCardTab(tab);
    }
  };
  const togglePageCardRowFilter = (rowKey: string) => {
    const normalized = rowKey.trim();
    const isActive = activePageCardQueryValue === normalized;
    setPageCardQueryFilter(
      isActive ? null : { tab: pageCardTab, value: normalized },
    );
  };
  const toggleSourceCardRowFilter = (rowKey: string) => {
    const normalized = rowKey.trim();
    const isActive = activeSourceCardQueryValue === normalized;
    setSourceCardQueryFilter(
      isActive ? null : { tab: sourceCardTab, value: normalized },
    );
  };
  const toggleClientDimensionCardRowFilter = (rowKey: string) => {
    const normalized = rowKey.trim();
    const isActive = activeClientDimensionCardQueryValue === normalized;
    setClientDimensionCardQueryFilter(
      isActive ? null : { tab: clientDimensionCardTab, value: normalized },
    );
  };
  const toggleGeoDimensionCardRowFilter = (rowKey: string) => {
    const normalized = rowKey.trim();
    const isActive = activeGeoDimensionCardQueryValue === normalized;
    setGeoDimensionCardQueryFilter(
      isActive ? null : { tab: geoDimensionCardTab, value: normalized },
    );
  };
  const openPageCardRowTarget = (
    targetUrl: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    globalThis.window.open(targetUrl, "_blank", "noopener,noreferrer");
  };
  const openGeoDimensionLocationTarget = (
    targetUrl: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    router.push(targetUrl);
  };
  const renderSortIndicator = (key: PageCardSortKey) => {
    if (pageCardSort.key === key) {
      return pageCardSort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="inline-flex flex-col leading-none text-muted-foreground">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };
  const renderSourceSortIndicator = (key: PageCardSortKey) => {
    if (sourceCardSort.key === key) {
      return sourceCardSort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="inline-flex flex-col leading-none text-muted-foreground">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };
  const renderClientDimensionSortIndicator = (key: PageCardSortKey) => {
    if (clientDimensionCardSort.key === key) {
      return clientDimensionCardSort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="inline-flex flex-col leading-none text-muted-foreground">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };
  const renderGeoDimensionSortIndicator = (key: PageCardSortKey) => {
    if (geoDimensionCardSort.key === key) {
      return geoDimensionCardSort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="inline-flex flex-col leading-none text-muted-foreground">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };
  const pageCardSearchLabel = messages.common.search;
  const pageCardSearchPlaceholder = formatI18nTemplate(
    messages.overview.searchInTab,
    { tab: activePageTabMeta.label },
  );
  const pageCardSearchTitle = pageCardSearchPlaceholder;
  const sourceCardSearchLabel = messages.common.search;
  const sourceCardSearchPlaceholder = formatI18nTemplate(
    messages.overview.searchInTab,
    { tab: activeSourceTabMeta.label },
  );
  const sourceCardSearchTitle = sourceCardSearchPlaceholder;
  const clientDimensionCardSearchLabel = messages.common.search;
  const clientDimensionCardSearchPlaceholder = formatI18nTemplate(
    messages.overview.searchInTab,
    { tab: activeClientDimensionTabMeta.label },
  );
  const clientDimensionCardSearchTitle = clientDimensionCardSearchPlaceholder;
  const geoDimensionCardSearchLabel = messages.common.search;
  const geoDimensionCardSearchPlaceholder = formatI18nTemplate(
    messages.overview.searchInTab,
    { tab: activeGeoDimensionTabMeta.label },
  );
  const geoDimensionCardSearchTitle = geoDimensionCardSearchPlaceholder;
  const pageCardTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{activePageTabMeta.columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              pageCardSort.key === "views"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => togglePageCardSort("views")}
          >
            {messages.common.views}
            {renderSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              pageCardSort.key === "sessions"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => togglePageCardSort("sessions")}
          >
            {messages.common.sessions}
            {renderSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );
  const renderPageCardRows = (rows: PageCardRow[]) =>
    rows.map((item) => {
      const rowValue = Math.max(0, Number(item[pageCardSort.key] ?? 0));
      const progressPercent =
        pageCardProgressTotal > 0
          ? Math.min(100, (rowValue / pageCardProgressTotal) * 100)
          : 0;
      const progressWidth = `${progressPercent.toFixed(2)}%`;
      const rowTargetUrl = isPageCardNavigableTab(pageCardTab)
        ? resolvePageCardTargetUrl({
            tab: pageCardTab,
            value: item.label,
            unknownLabel: messages.common.unknown,
            fallbackHostname: pageCardDefaultHostname,
          })
        : null;
      const rowFilterActive = activePageCardQueryValue === item.label;

      return (
        <TableRow
          key={`${pageCardTab}-${item.key}`}
          className={cn(
            "group/row cursor-pointer bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95",
            rowFilterActive && "brightness-95",
          )}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
            backgroundSize: `${progressWidth} 100%`,
            backgroundPosition: "left top",
          }}
          onClick={() => togglePageCardRowFilter(item.label)}
        >
          <TableCell className="p-0 whitespace-normal align-top">
            <div
              className={cn(
                "px-4 py-2 leading-5 whitespace-normal break-words",
                activePageTabMeta.mono && "font-mono",
              )}
            >
              <span className="inline-flex items-center gap-2 break-words">
                <LabelWithOptionalIcon
                  label={item.label}
                  showIcon={activePageTabMeta.showIcon}
                  unknownLabel={messages.common.unknown}
                />
                {rowTargetUrl ? (
                  <Clickable
                    className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) =>
                      openPageCardRowTarget(rowTargetUrl, event)
                    }
                    aria-label={item.label}
                    title={item.label}
                  >
                    <RiArrowRightUpLine size="1.4em" />
                  </Clickable>
                ) : null}
              </span>
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-2 py-2 text-right">
              {numberFormat(locale, item.views)}
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-4 py-2 text-right">
              {numberFormat(locale, item.sessions)}
            </div>
          </TableCell>
        </TableRow>
      );
    });
  const sourceCardTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{activeSourceTabMeta.columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sourceCardSort.key === "views"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleSourceCardSort("views")}
          >
            {messages.common.views}
            {renderSourceSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sourceCardSort.key === "sessions"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleSourceCardSort("sessions")}
          >
            {messages.common.sessions}
            {renderSourceSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );
  const renderSourceCardRows = (rows: SourceCardRow[]) =>
    rows.map((item) => {
      const rowValue = Math.max(0, Number(item[sourceCardSort.key] ?? 0));
      const progressPercent =
        sourceCardProgressTotal > 0
          ? Math.min(100, (rowValue / sourceCardProgressTotal) * 100)
          : 0;
      const progressWidth = `${progressPercent.toFixed(2)}%`;
      const targetUrl = item.targetUrl;
      const rowFilterActive = activeSourceCardQueryValue === item.filterValue;

      return (
        <TableRow
          key={item.key}
          className={cn(
            "group/row cursor-pointer bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95",
            rowFilterActive && "brightness-95",
          )}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
            backgroundSize: `${progressWidth} 100%`,
            backgroundPosition: "left top",
          }}
          onClick={() => toggleSourceCardRowFilter(item.filterValue)}
        >
          <TableCell className="p-0 whitespace-normal align-top">
            <div
              className={cn(
                "px-4 py-2 leading-5 whitespace-normal break-words",
                item.mono && "font-mono",
              )}
            >
              <span className="inline-flex items-center gap-2 break-words">
                <LabelWithOptionalIcon
                  label={item.label}
                  showIcon={activeSourceTabMeta.showIcon}
                  unknownLabel={sourceCardDirectLabel}
                />
                {targetUrl ? (
                  <Clickable
                    className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) => openPageCardRowTarget(targetUrl, event)}
                    aria-label={item.label}
                    title={item.label}
                  >
                    <RiArrowRightUpLine size="1.4em" />
                  </Clickable>
                ) : null}
              </span>
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-2 py-2 text-right">
              {numberFormat(locale, item.views)}
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-4 py-2 text-right">
              {numberFormat(locale, item.sessions)}
            </div>
          </TableCell>
        </TableRow>
      );
    });
  const sourceCardSearchContent = (
    <div className="space-y-3">
      <Input
        value={sourceCardSearchTerm}
        onChange={(event) => setSourceCardSearchTerm(event.target.value)}
        placeholder={sourceCardSearchPlaceholder}
      />
      <PanelScrollbar
        className="max-h-[60vh] pr-1"
        syncKey={`${sourceCardTab}-${sourceCardSort.key}-${sourceCardSort.direction}-${sourceCardSearchTerm}-${searchedSourceCardRows.length}-${sourceCardLoading}`}
      >
        <DataTableSwitch
          loading={sourceCardLoading}
          hasContent={searchedSourceCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          header={sourceCardTableHeader}
          rows={renderSourceCardRows(searchedSourceCardRows)}
        />
      </PanelScrollbar>
    </div>
  );
  const sourceCardSearchPanel = isMobile ? (
    <Drawer open={sourceCardSearchOpen} onOpenChange={setSourceCardSearchOpen}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>{sourceCardSearchTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">{sourceCardSearchContent}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={sourceCardSearchOpen} onOpenChange={setSourceCardSearchOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{sourceCardSearchTitle}</DialogTitle>
        </DialogHeader>
        {sourceCardSearchContent}
      </DialogContent>
    </Dialog>
  );
  const sourceCardSearchAction = (
    <Clickable
      className="size-6 text-muted-foreground hover:text-foreground"
      onClick={() => setSourceCardSearchOpen(true)}
      aria-label={sourceCardSearchLabel}
      title={sourceCardSearchLabel}
    >
      <RiSearchLine className="size-4" />
    </Clickable>
  );
  const clientDimensionCardTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{activeClientDimensionTabMeta.columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              clientDimensionCardSort.key === "views"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleClientDimensionCardSort("views")}
          >
            {messages.common.views}
            {renderClientDimensionSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              clientDimensionCardSort.key === "sessions"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleClientDimensionCardSort("sessions")}
          >
            {messages.common.sessions}
            {renderClientDimensionSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );
  const renderClientDimensionCardRows = (rows: PageCardRow[]) =>
    rows.map((item) => {
      const rowValue = Math.max(
        0,
        Number(item[clientDimensionCardSort.key] ?? 0),
      );
      const progressPercent =
        clientDimensionCardProgressTotal > 0
          ? Math.min(100, (rowValue / clientDimensionCardProgressTotal) * 100)
          : 0;
      const progressWidth = `${progressPercent.toFixed(2)}%`;
      const rowFilterActive =
        activeClientDimensionCardQueryValue ===
        (item.filterValue ?? item.label);

      return (
        <TableRow
          key={item.key}
          className={cn(
            "group/row cursor-pointer bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95",
            rowFilterActive && "brightness-95",
          )}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
            backgroundSize: `${progressWidth} 100%`,
            backgroundPosition: "left top",
          }}
          onClick={() =>
            toggleClientDimensionCardRowFilter(item.filterValue ?? item.label)
          }
        >
          <TableCell className="p-0 whitespace-normal align-top">
            <div
              className={cn(
                "px-4 py-2 leading-5 whitespace-normal break-words",
                item.mono && "font-mono",
              )}
            >
              <LabelWithLeadingIcon
                label={item.label}
                iconName={item.iconName}
              />
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-2 py-2 text-right">
              {numberFormat(locale, item.views)}
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-4 py-2 text-right">
              {numberFormat(locale, item.sessions)}
            </div>
          </TableCell>
        </TableRow>
      );
    });
  const clientDimensionCardSearchContent = (
    <div className="space-y-3">
      <Input
        value={clientDimensionCardSearchTerm}
        onChange={(event) =>
          setClientDimensionCardSearchTerm(event.target.value)
        }
        placeholder={clientDimensionCardSearchPlaceholder}
      />
      <PanelScrollbar
        className="max-h-[60vh] pr-1"
        syncKey={`${clientDimensionCardTab}-${clientDimensionCardSort.key}-${clientDimensionCardSort.direction}-${clientDimensionCardSearchTerm}-${searchedClientDimensionCardRows.length}-${dimensionCardsLoading}`}
      >
        <DataTableSwitch
          loading={dimensionCardsLoading}
          hasContent={searchedClientDimensionCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          header={clientDimensionCardTableHeader}
          rows={renderClientDimensionCardRows(searchedClientDimensionCardRows)}
        />
      </PanelScrollbar>
    </div>
  );
  const clientDimensionCardSearchPanel = isMobile ? (
    <Drawer
      open={clientDimensionCardSearchOpen}
      onOpenChange={setClientDimensionCardSearchOpen}
    >
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>{clientDimensionCardSearchTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">{clientDimensionCardSearchContent}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog
      open={clientDimensionCardSearchOpen}
      onOpenChange={setClientDimensionCardSearchOpen}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{clientDimensionCardSearchTitle}</DialogTitle>
        </DialogHeader>
        {clientDimensionCardSearchContent}
      </DialogContent>
    </Dialog>
  );
  const clientDimensionCardSearchAction = (
    <Clickable
      className="size-6 text-muted-foreground hover:text-foreground"
      onClick={() => setClientDimensionCardSearchOpen(true)}
      aria-label={clientDimensionCardSearchLabel}
      title={clientDimensionCardSearchLabel}
    >
      <RiSearchLine className="size-4" />
    </Clickable>
  );
  const geoDimensionCardTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{activeGeoDimensionTabMeta.columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              geoDimensionCardSort.key === "views"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleGeoDimensionCardSort("views")}
          >
            {messages.common.views}
            {renderGeoDimensionSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              geoDimensionCardSort.key === "sessions"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => toggleGeoDimensionCardSort("sessions")}
          >
            {messages.common.sessions}
            {renderGeoDimensionSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );
  const renderGeoDimensionCardRows = (
    rows: PageCardRow[],
    options?: {
      showRawLabel?: boolean;
    },
  ) =>
    rows.map((item) => {
      const showRawLabel = options?.showRawLabel ?? false;
      const rowValue = Math.max(0, Number(item[geoDimensionCardSort.key] ?? 0));
      const progressPercent =
        geoDimensionCardProgressTotal > 0
          ? Math.min(100, (rowValue / geoDimensionCardProgressTotal) * 100)
          : 0;
      const progressWidth = `${progressPercent.toFixed(2)}%`;
      const rowFilterValue = item.filterValue ?? item.label;
      const activeGeoHighlightValue = isGeoLocationTab(geoDimensionCardTab)
        ? resolveGeoLocationHighlightValue(
            geoDimensionCardTab,
            activeGeoDimensionCardQueryValue,
          )
        : activeGeoDimensionCardQueryValue;
      const rowFilterActive = activeGeoHighlightValue === rowFilterValue;
      const rowLocationValue = resolveGeoLocationQueryValue(
        geoDimensionCardTab,
        item,
        messages.common.unknown,
      );
      const rowLocationTarget = rowLocationValue
        ? `${buildGeoPagePath(livePathname)}?${new URLSearchParams({
            location: rowLocationValue,
          }).toString()}`
        : null;

      return (
        <TableRow
          key={item.key}
          className={cn(
            "group/row cursor-pointer bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95",
            rowFilterActive && "brightness-95",
          )}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
            backgroundSize: `${progressWidth} 100%`,
            backgroundPosition: "left top",
          }}
          onClick={() => toggleGeoDimensionCardRowFilter(rowFilterValue)}
        >
          <TableCell
            className={cn(
              "p-0 whitespace-normal",
              geoDimensionCardTab === "region" || geoDimensionCardTab === "city"
                ? "align-middle"
                : "align-top",
            )}
          >
            <div
              className={cn(
                "px-4 py-2 leading-5 whitespace-normal break-words",
                (geoDimensionCardTab === "region" ||
                  geoDimensionCardTab === "city") &&
                  "flex min-h-8 items-center",
                item.mono && "font-mono",
              )}
            >
              <span className="inline-flex items-center gap-2 break-words">
                {showRawLabel ? (
                  <LabelWithLeadingIcon
                    label={item.rawLabel?.trim() || item.label}
                    iconName={item.iconName}
                  />
                ) : geoDimensionCardTab === "region" &&
                  item.regionBreadcrumb ? (
                  <RegionBreadcrumbLabel
                    locale={locale}
                    countryLabel={item.regionBreadcrumb.countryLabel}
                    countryIconName={item.regionBreadcrumb.countryIconName}
                    regionLabel={item.regionBreadcrumb.regionLabel}
                    countryCode={item.regionBreadcrumb.countryCode}
                    stateCode={item.regionBreadcrumb.stateCode}
                    hideRegion={item.regionBreadcrumb.hideRegion}
                  />
                ) : geoDimensionCardTab === "city" && item.cityBreadcrumb ? (
                  <CityBreadcrumbLabel
                    locale={locale}
                    countryLabel={item.cityBreadcrumb.countryLabel}
                    countryIconName={item.cityBreadcrumb.countryIconName}
                    regionLabel={item.cityBreadcrumb.regionLabel}
                    cityLabel={item.cityBreadcrumb.cityLabel}
                    countryCode={item.cityBreadcrumb.countryCode}
                    stateCode={item.cityBreadcrumb.stateCode}
                    cityNameDefault={item.cityBreadcrumb.cityNameDefault}
                    hideRegion={item.cityBreadcrumb.hideRegion}
                    hideCity={item.cityBreadcrumb.hideCity}
                  />
                ) : (
                  <LabelWithLeadingIcon
                    label={item.label}
                    iconName={item.iconName}
                  />
                )}
                {rowLocationTarget ? (
                  <Clickable
                    className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) =>
                      openGeoDimensionLocationTarget(rowLocationTarget, event)
                    }
                    aria-label={messages.common.search}
                    title={messages.common.search}
                  >
                    <RiSearchLine size="1.2em" />
                  </Clickable>
                ) : null}
              </span>
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-2 py-2 text-right">
              {numberFormat(locale, item.views)}
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div className="px-4 py-2 text-right">
              {numberFormat(locale, item.sessions)}
            </div>
          </TableCell>
        </TableRow>
      );
    });
  const geoDimensionCardSearchContent = (
    <div className="space-y-3">
      <Input
        value={geoDimensionCardSearchTerm}
        onChange={(event) => setGeoDimensionCardSearchTerm(event.target.value)}
        placeholder={geoDimensionCardSearchPlaceholder}
      />
      <PanelScrollbar
        className="max-h-[60vh] pr-1"
        syncKey={`${geoDimensionCardTab}-${geoDimensionCardSort.key}-${geoDimensionCardSort.direction}-${geoDimensionCardSearchTerm}-${searchedGeoDimensionCardRows.length}-${dimensionCardsLoading}`}
      >
        <DataTableSwitch
          loading={dimensionCardsLoading}
          hasContent={searchedGeoDimensionCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          header={geoDimensionCardTableHeader}
          rows={renderGeoDimensionCardRows(searchedGeoDimensionCardRows, {
            showRawLabel: true,
          })}
        />
      </PanelScrollbar>
    </div>
  );
  const geoDimensionCardSearchPanel = isMobile ? (
    <Drawer
      open={geoDimensionCardSearchOpen}
      onOpenChange={setGeoDimensionCardSearchOpen}
    >
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>{geoDimensionCardSearchTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">{geoDimensionCardSearchContent}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog
      open={geoDimensionCardSearchOpen}
      onOpenChange={setGeoDimensionCardSearchOpen}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{geoDimensionCardSearchTitle}</DialogTitle>
        </DialogHeader>
        {geoDimensionCardSearchContent}
      </DialogContent>
    </Dialog>
  );
  const geoDimensionCardSearchAction = (
    <Clickable
      className="size-6 text-muted-foreground hover:text-foreground"
      onClick={() => setGeoDimensionCardSearchOpen(true)}
      aria-label={geoDimensionCardSearchLabel}
      title={geoDimensionCardSearchLabel}
    >
      <RiSearchLine className="size-4" />
    </Clickable>
  );
  const pageCardSearchContent = (
    <div className="space-y-3">
      <Input
        value={pageCardSearchTerm}
        onChange={(event) => setPageCardSearchTerm(event.target.value)}
        placeholder={pageCardSearchPlaceholder}
      />
      <PanelScrollbar
        className="max-h-[60vh] pr-1"
        syncKey={`${pageCardTab}-${pageCardSearchTerm}-${searchedPageCardRows.length}-${pageCardLoading}`}
      >
        <DataTableSwitch
          loading={pageCardLoading}
          hasContent={searchedPageCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          header={pageCardTableHeader}
          rows={renderPageCardRows(searchedPageCardRows)}
        />
      </PanelScrollbar>
    </div>
  );
  const pageCardSearchPanel = isMobile ? (
    <Drawer open={pageCardSearchOpen} onOpenChange={setPageCardSearchOpen}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>{pageCardSearchTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">{pageCardSearchContent}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={pageCardSearchOpen} onOpenChange={setPageCardSearchOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{pageCardSearchTitle}</DialogTitle>
        </DialogHeader>
        {pageCardSearchContent}
      </DialogContent>
    </Dialog>
  );
  const pageCardSearchAction = (
    <Clickable
      className="size-6 text-muted-foreground hover:text-foreground"
      onClick={() => setPageCardSearchOpen(true)}
      aria-label={pageCardSearchLabel}
      title={pageCardSearchLabel}
    >
      <RiSearchLine className="size-4" />
    </Clickable>
  );

  return (
    <>
      <section className="grid items-stretch gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <TabbedScrollMaskCard
            value={pageCardTab}
            onValueChange={(value) => handlePageCardTabChange(value)}
            tabs={PAGE_CARD_TABS.map((tab) => ({
              value: tab,
              label: pageCardTabMeta[tab].label,
            }))}
            headerRight={pageCardSearchAction}
            className="h-full"
            syncKey={`${pageCardLoading}-${pageCardTab}-${pageCardSort.key}-${pageCardSort.direction}-${sortedPageCardRows.length}-${activePageCardQueryValue ?? "all"}-${visiblePageCardRows.length}`}
          >
            <DataTableSwitch
              loading={pageCardLoading}
              hasContent={visiblePageCardRows.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              contentKey={`${pageCardTab}-${activePageCardQueryValue ?? "all"}`}
              header={pageCardTableHeader}
              rows={renderPageCardRows(visiblePageCardRows)}
            />
          </TabbedScrollMaskCard>
        </div>

        <div className="min-w-0">
          <TabbedScrollMaskCard
            value={sourceCardTab}
            onValueChange={(value) => setSourceCardTab(value)}
            tabs={(Object.keys(sourceCardTabMeta) as SourceCardTab[]).map(
              (tab) => ({
                value: tab,
                label: sourceCardTabMeta[tab].label,
              }),
            )}
            headerRight={sourceCardSearchAction}
            className="h-full"
            syncKey={`${sourceCardLoading}-${sourceCardTab}-${sourceCardSort.key}-${sourceCardSort.direction}-${sortedSourceCardRows.length}-${activeSourceCardQueryValue ?? "all"}-${visibleSourceCardRows.length}`}
          >
            <DataTableSwitch
              loading={sourceCardLoading}
              hasContent={visibleSourceCardRows.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              contentKey={`${sourceCardTab}-${activeSourceCardQueryValue ?? "all"}`}
              header={sourceCardTableHeader}
              rows={renderSourceCardRows(visibleSourceCardRows)}
            />
          </TabbedScrollMaskCard>
        </div>

        <div className="min-w-0">
          <TabbedScrollMaskCard
            value={clientDimensionCardTab}
            onValueChange={(value) => setClientDimensionCardTab(value)}
            tabs={CLIENT_DIMENSION_CARD_TABS.map((tab) => ({
              value: tab,
              label: clientDimensionCardTabMeta[tab].label,
            }))}
            headerRight={clientDimensionCardSearchAction}
            className="h-full"
            syncKey={`${dimensionCardsLoading}-${clientDimensionCardTab}-${clientDimensionCardSort.key}-${clientDimensionCardSort.direction}-${sortedClientDimensionCardRows.length}-${activeClientDimensionCardQueryValue ?? "all"}-${visibleClientDimensionCardRows.length}`}
          >
            <DataTableSwitch
              loading={dimensionCardsLoading}
              hasContent={visibleClientDimensionCardRows.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              contentKey={`${clientDimensionCardTab}-${activeClientDimensionCardQueryValue ?? "all"}`}
              header={clientDimensionCardTableHeader}
              rows={renderClientDimensionCardRows(
                visibleClientDimensionCardRows,
              )}
            />
          </TabbedScrollMaskCard>
        </div>

        <div className="min-w-0">
          <TabbedScrollMaskCard
            value={geoDimensionCardTab}
            onValueChange={(value) => setGeoDimensionCardTab(value)}
            tabs={GEO_DIMENSION_CARD_TABS.map((tab) => ({
              value: tab,
              label: geoDimensionCardTabMeta[tab].label,
            }))}
            headerRight={geoDimensionCardSearchAction}
            className="h-full"
            syncKey={`${dimensionCardsLoading}-${geoDimensionCardTab}-${geoDimensionCardSort.key}-${geoDimensionCardSort.direction}-${sortedGeoDimensionCardRows.length}-${activeGeoDimensionCardQueryValue ?? "all"}-${visibleGeoDimensionCardRows.length}`}
          >
            <DataTableSwitch
              loading={dimensionCardsLoading}
              hasContent={visibleGeoDimensionCardRows.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              contentKey={`${geoDimensionCardTab}-${activeGeoDimensionCardQueryValue ?? "all"}`}
              header={geoDimensionCardTableHeader}
              rows={renderGeoDimensionCardRows(visibleGeoDimensionCardRows)}
            />
          </TabbedScrollMaskCard>
        </div>
      </section>
      {geoDimensionCardSearchPanel}
      {clientDimensionCardSearchPanel}
      {sourceCardSearchPanel}
      {pageCardSearchPanel}
    </>
  );
}

interface OverviewDataSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

function OverviewMetricsSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewData>(emptyOverviewData);
  const [previousOverview, setPreviousOverview] =
    useState<OverviewData>(emptyOverviewData);
  const [detailSeries, setDetailSeries] = useState<TrendData["data"]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setOverview(emptyOverviewData());
    setPreviousOverview(emptyOverviewData());

    const previousTo = Math.max(window.from - 1, 0);
    const previousFrom = Math.max(previousTo - (window.to - window.from), 0);
    const previousWindow: TimeWindow = {
      ...window,
      from: previousFrom,
      to: previousTo,
    };

    (async () => {
      const current = await fetchOverview(siteId, window, filters, {
        includeChange: true,
        includeDetail: true,
      }).catch(() => emptyOverviewData());
      if (!active) return;
      setOverview(current);

      const [previous, trend] = await Promise.all([
        current.previousData
          ? Promise.resolve({
              ok: current.ok,
              data: current.previousData,
            } as OverviewData)
          : fetchOverview(siteId, previousWindow, filters).catch(() =>
              emptyOverviewData(),
            ),
        current.detail
          ? Promise.resolve({
              ok: current.ok,
              interval: current.detail.interval,
              data: current.detail.data,
            } as TrendData)
          : fetchTrend(siteId, window, filters).catch(() =>
              emptyTrendData(window.interval),
            ),
      ]);

      if (!active) return;
      setPreviousOverview(previous);
      setDetailSeries(trend.data);
    })().finally(() => {
      if (!active) return;
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [
    filters,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

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
    const lastTimestamp = detailSeries[detailSeries.length - 1]?.timestampMs ?? 0;
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
      inverted: true,
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
        <section className="grid grid-cols-1 sm:grid-cols-3">
          {metrics.map((item, index) => {
            const hasDelta =
              typeof item.delta === "number" && Number.isFinite(item.delta);
            const effectiveDelta = hasDelta
              ? item.inverted
                ? -(item.delta ?? 0)
                : (item.delta ?? 0)
              : null;

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
                              className="inline-flex items-center"
                            >
                              <Spinner className="size-5" />
                            </div>
                          ) : (
                            <p
                              key="value"
                              className="inline-flex items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                            >
                              <span>{item.value}</span>
                              <ChangeRateInline value={effectiveDelta} />
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

function OverviewTrendSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const [loading, setLoading] = useState(true);
  const [trendHydrated, setTrendHydrated] = useState(false);
  const [trendData, setTrendData] = useState<TrendData>(() =>
    emptyTrendData(window.interval),
  );
  const [dataWindow, setDataWindow] = useState<
    Pick<TimeWindow, "from" | "to" | "interval">
  >(() => ({
    from: window.from,
    to: window.to,
    interval: window.interval,
  }));

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchTrend(siteId, window, filters)
      .catch(() => emptyTrendData(window.interval))
      .then((nextTrend) => {
        if (!active) return;
        setTrendData(nextTrend);
        setDataWindow({
          from: window.from,
          to: window.to,
          interval: window.interval,
        });
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setTrendHydrated(true);
      });

    return () => {
      active = false;
    };
  }, [
    filters,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

  const trendDisplayData = useMemo(() => {
    if (!trendHydrated && loading) {
      return buildEmptyTrendData(dataWindow);
    }
    return normalizeTrendData(dataWindow, trendData.data);
  }, [
    dataWindow.from,
    dataWindow.interval,
    dataWindow.to,
    loading,
    trendHydrated,
    trendData.data,
  ]);
  const showTrendOverlayLoading = loading && trendHydrated;

  return (
    <Card className="overflow-visible">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{messages.overview.trendTitle}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {messages.common.lastUpdated}: {shortDateTime(locale, Date.now())}
        </span>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div>
            <TrendChart
              locale={locale}
              interval={dataWindow.interval}
              data={trendDisplayData}
              viewsLabel={messages.common.views}
              sessionsLabel={messages.common.sessions}
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
  pathname,
}: OverviewClientPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const livePathname = usePathname() || pathname;
  const { window } = useDashboardQuery();
  const searchParamsKey = searchParams.toString();
  const requestFilters = useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const selectedGeoValue = requestFilters.geo ?? null;
  const selectedGeoCountry = useMemo(() => {
    return extractGeoCountryCodeFromFilterValue(selectedGeoValue);
  }, [selectedGeoValue]);
  const handleMapCountrySelect = useCallback(
    (countryCode: string | null) => {
      const normalizedCurrent = String(selectedGeoCountry ?? "")
        .trim()
        .toUpperCase();
      const normalizedNext = String(countryCode ?? "").trim().toUpperCase();
      const nextCountry =
        normalizedNext.length > 0 && normalizedNext !== normalizedCurrent
          ? normalizedNext
          : undefined;
      const params = new URLSearchParams(searchParams.toString());
      params.delete(GEO_QUERY_PARAM);
      clearLegacyGeoQueryParams(params);
      if (nextCountry) {
        params.set(GEO_QUERY_PARAM, nextCountry);
      }
      const nextQuery = params.toString();
      const target = nextQuery ? `${livePathname}?${nextQuery}` : livePathname;
      const current = searchParams.toString();
      if (nextQuery !== current) {
        router.replace(target, { scroll: false });
      }
    },
    [livePathname, router, searchParams, selectedGeoCountry],
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

