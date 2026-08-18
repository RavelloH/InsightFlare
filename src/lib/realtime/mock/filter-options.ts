import { browserEngineLabel } from "@/lib/browser-engine";
import {
  addZonedInterval,
  normalizeTimeZone,
  resolveReportingTimeZone,
  startOfZonedInterval,
  zonedParts,
} from "@/lib/dashboard/time-zone";
import {
  DEMO_SITE_PROFILES,
  type DemoSiteProfile,
  findSiteProfile,
} from "@/lib/realtime/demo-site-profiles";
import {
  createDemoRng,
  expandPathLabels,
  fnv1a,
  mulberry32,
  normalizePath,
  sFloat,
  sInt,
  sPick,
  sShuffle,
  titleFromPath,
  todayKey,
  uniqueNonEmptyStrings,
  weightedDistribution,
  weightedDistributionFromWeights,
  weightedPickLabel,
  windowBucket,
} from "@/lib/realtime/demo-utils";
import {
  generateDemoDoDiagnostic,
  generateDemoSystemPerformance,
  getDemoMembers,
  getDemoScriptSnippet,
  getDemoSiteConfig,
  getDemoSites,
  getDemoTeams,
  getDemoUser,
} from "@/lib/realtime/mock/admin";
import { generateDemoPages } from "@/lib/realtime/mock/analytics";
import {
  buildCountryPool,
  buildReferrerPool,
  DEMO_CITIES_BY_COUNTRY,
  DEMO_REGIONS_BY_COUNTRY,
  filterGeoLabelsByCountries,
  groupGeoLabelsByCountry,
  isMobileBrowserLabel,
  normalizeLongitude,
  parseDemoCityLabel,
  parseDemoRegionLabel,
  pickCountryGeoCluster,
  pickDemoBrowser,
  pickDemoBrowserVersion,
  pickDemoContinent,
  pickDemoDeviceType,
  pickDemoGeoContext,
  pickDemoLanguage,
  pickDemoOrganization,
  pickDemoOsVersion,
  pickDemoScreenSize,
  pickDemoTimezone,
  pickFromList,
  pickReferrerByCountry,
  randomGaussian,
  sampleGeoPointByCountry,
  weightedPickCountry,
  weightedPickIndex,
} from "@/lib/realtime/mock/dimension-pickers";
import {
  ALL_BROWSERS,
  ALL_CITIES,
  ALL_CONTINENTS,
  ALL_LANGUAGES,
  ALL_ORGS,
  ALL_OS,
  ALL_REGIONS,
  ALL_SCREEN_SIZES,
  ALL_TIMEZONES,
  BROWSER_MARKET_WEIGHTS,
  COUNTRY_COORDINATE_ANCHORS,
  COUNTRY_GEO_CLUSTERS,
  DEMO_COUNTRY_TO_CONTINENT,
  DEMO_COUNTRY_TO_LANGUAGES,
  DEMO_COUNTRY_TO_TIMEZONES,
  DEMO_DESKTOP_OS,
  DEMO_DESKTOP_SCREENS,
  DEMO_GEO_SEGMENT_SEPARATOR,
  DEMO_MOBILE_OS,
  DEMO_MOBILE_SCREENS,
  DEMO_TABLET_SCREENS,
  type GeoCluster,
  GLOBAL_COUNTRY_LONG_TAIL,
  GLOBAL_REFERRER_LONG_TAIL,
} from "@/lib/realtime/mock/dimension-pools";
import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  aggregateSessionEdgeRows,
  applyDemoFilters,
  buildDemoFactDataset,
  buildDemoPathTitleMap,
  collectClientTabs,
  collectGeoTabs,
  collectPageDataAndTabs,
  collectReferrerRows,
  DEMO_FACT_DATASET_CACHE,
  emptyDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/realtime/mock/fact-builder";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  DEMO_INTERVALS,
  demoValuesIncludeSearch,
  normalizeDemoFilterValue,
  normalizeDemoSearch,
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoGeoFilterValue,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
  withoutDemoGeoFilter,
} from "@/lib/realtime/mock/filters";
import {
  buildPathTransitionGraph,
  nextPath,
} from "@/lib/realtime/mock/path-markov";
import {
  buildDemoTimeBuckets,
  buildDemoTrendBuckets,
  createDemoShareTrendSeriesKey,
  DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  DEMO_BROWSER_CROSS_UNKNOWN_TOKEN,
  DEMO_BROWSER_VERSION_UNKNOWN_TOKEN,
  DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  DEMO_CLIENT_CROSS_UNKNOWN_TOKEN,
  DEMO_SHARE_TREND_OTHER_KEY,
  DEMO_SHARE_TREND_OTHER_LABEL,
  type DemoClientDimensionKey,
  demoClientDimensionMeta,
  type DemoSortDirection,
  findDemoTimeBucketIndex,
  parseDemoClientDimensionKey,
  parseDemoScreenSize,
  parseDemoTimeZone,
} from "@/lib/realtime/mock/shared";
import {
  computeMetrics,
  dailyMetricFactor,
  dailyViewCount,
  demoIntervalStepMs,
  integrateViews,
  sampleTimestampByCurve,
  siteDayIntegral,
  siteHourShapeIntegral,
  type SiteMetricRatios,
  siteRatios,
} from "@/lib/realtime/mock/site-curves";
import type {
  DemoDimensionRow,
  DemoFactDataset,
  DemoFilteredFacts,
  DemoQueryFilters,
  DemoSessionFact,
  DemoVisitFact,
  DemoVisitorFact,
  ParsedDemoGeoFilter,
} from "@/lib/realtime/mock/types";
import {
  DEMO_EMPTY_HASH_VALUE,
  DEMO_EMPTY_QUERY_VALUE,
  demoHashFragmentForVisit,
  demoOperatingSystemLabel,
  demoQueryStringForVisit,
  demoStringHash,
} from "@/lib/realtime/mock/visit-helpers";
import {
  getVisitorFingerprint,
  sampleActiveVisitors,
} from "@/lib/realtime/mock/visitor-pool";
function dedupeDemoFilterOptions(
  options: Array<{
    value: string;
    label: string;
    group?: "country" | "region" | "city";
  }>,
): Array<{
  value: string;
  label: string;
  group?: "country" | "region" | "city";
}> {
  const seen = new Set<string>();
  const deduped: Array<{
    value: string;
    label: string;
    group?: "country" | "region" | "city";
  }> = [];

  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push({
      value,
      label: String(option.label ?? value).trim() || value,
      ...(option.group ? { group: option.group } : {}),
    });
  }

  return deduped;
}

function withoutDemoFilterKey(
  filters: DemoQueryFilters,
  key: keyof DemoQueryFilters,
): DemoQueryFilters {
  const { [key]: _, ...next } = filters;
  return next;
}

function parseDemoFilterKey(
  params: Record<string, string | number>,
): keyof DemoQueryFilters | null {
  const raw = normalizeDemoFilterValue(params.filterKey);
  if (!raw) return null;
  const keys: Array<keyof DemoQueryFilters> = [
    "country",
    "device",
    "browser",
    "path",
    "title",
    "hostname",
    "entry",
    "exit",
    "sourceDomain",
    "sourceLink",
    "clientBrowser",
    "clientOsVersion",
    "clientDeviceType",
    "clientLanguage",
    "clientScreenSize",
    "geo",
    "geoContinent",
    "geoTimezone",
    "geoOrganization",
  ];
  return keys.includes(raw as keyof DemoQueryFilters)
    ? (raw as keyof DemoQueryFilters)
    : null;
}

export function generateDemoFilterOptions(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const filterKey = parseDemoFilterKey(params);
  if (!filterKey) {
    return { ok: false, data: [] };
  }
  const limit = parseDemoLimit(params.limit, 200, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = withoutDemoFilterKey(parseDemoFilters(params), filterKey);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  if (filterKey === "country") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.country,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (filterKey === "device") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.deviceType,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (filterKey === "browser") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.browser,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (
    filterKey === "path" ||
    filterKey === "title" ||
    filterKey === "hostname" ||
    filterKey === "entry" ||
    filterKey === "exit"
  ) {
    const pages = collectPageDataAndTabs(dataset, filtered, limit);
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        (pages.tabs[filterKey] ?? []).map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }
  if (filterKey === "sourceDomain" || filterKey === "sourceLink") {
    const rows = collectReferrerRows(dataset, filtered, limit, {
      includeFullUrl: filterKey === "sourceLink",
      directValue: "",
    });
    const hasDirectReferrer = filtered.visits.some((visit) =>
      filterKey === "sourceLink"
        ? !visit.referrerUrl.trim()
        : !visit.referrerHost.trim(),
    );
    const options =
      rows.length === 0 && hasDirectReferrer
        ? [
            {
              value: DEMO_DIRECT_REFERRER_FILTER_VALUE,
              label: "Direct",
            },
          ]
        : rows.map((row) => {
            const value = String(row.referrer ?? "").trim();
            return value
              ? { value, label: value }
              : {
                  value: DEMO_DIRECT_REFERRER_FILTER_VALUE,
                  label: "Direct",
                };
          });
    return {
      ok: true,
      data: dedupeDemoFilterOptions(options),
    };
  }

  const clientTabs = collectClientTabs(dataset, filtered, limit);
  if (
    filterKey === "clientBrowser" ||
    filterKey === "clientOsVersion" ||
    filterKey === "clientDeviceType" ||
    filterKey === "clientLanguage" ||
    filterKey === "clientScreenSize"
  ) {
    const keyMap = {
      clientBrowser: "browser",
      clientOsVersion: "osVersion",
      clientDeviceType: "deviceType",
      clientLanguage: "language",
      clientScreenSize: "screenSize",
    } as const;
    const rows = clientTabs[keyMap[filterKey]] ?? [];
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }

  const geoTabs = collectGeoTabs(dataset, filtered, limit);
  if (filterKey === "geo") {
    return {
      ok: true,
      data: dedupeDemoFilterOptions([
        ...(geoTabs.country ?? []).map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
          group: "country" as const,
        })),
        ...(geoTabs.region ?? []).map((row) => {
          const value = String(row.label ?? "").trim();
          const segments = value.split("::").map((segment) => segment.trim());
          return {
            value,
            label: segments[2] || segments[1] || segments[0] || value,
            group: "region" as const,
          };
        }),
        ...(geoTabs.city ?? []).map((row) => {
          const value = String(row.label ?? "").trim();
          const segments = value.split("::").map((segment) => segment.trim());
          return {
            value,
            label:
              segments[3] || segments[2] || segments[1] || segments[0] || value,
            group: "city" as const,
          };
        }),
      ]),
    };
  }

  if (
    filterKey === "geoContinent" ||
    filterKey === "geoTimezone" ||
    filterKey === "geoOrganization"
  ) {
    const keyMap = {
      geoContinent: "continent",
      geoTimezone: "timezone",
      geoOrganization: "organization",
    } as const;
    const rows = geoTabs[keyMap[filterKey]] ?? [];
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }

  return { ok: true, data: [] };
}
