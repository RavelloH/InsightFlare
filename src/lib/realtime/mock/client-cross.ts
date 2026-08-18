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
function generateDemoClientCrossDimensionData(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  primaryLimit: number,
  secondaryLimit: number,
  primaryDimension: DemoClientDimensionKey,
  secondaryDimension: DemoClientDimensionKey,
): {
  columns: Array<{
    key: string;
    label: string;
    views: number;
    visitors: number;
    sessions: number;
    isOther?: boolean;
    isUnknown?: boolean;
  }>;
  rows: Array<{
    key: string;
    label: string;
    views: number;
    visitors: number;
    sessions: number;
    isOther?: boolean;
    cells: Array<{
      key: string;
      label: string;
      views: number;
      visitors: number;
      sessions: number;
      isOther?: boolean;
      isUnknown?: boolean;
    }>;
  }>;
  totalVisitors: number;
} {
  const primaryMeta = demoClientDimensionMeta(primaryDimension);
  const secondaryMeta = demoClientDimensionMeta(secondaryDimension);
  const topPrimary = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    primaryLimit,
    (visit) => primaryMeta.getLabel(visit),
    "visitors",
  ).filter((row) => row.label.trim().length > 0 && row.visitors > 0);

  if (topPrimary.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topSecondary = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits.filter(
      (visit) => String(primaryMeta.getLabel(visit) || "").trim().length > 0,
    ),
    secondaryLimit,
    (visit) => {
      const label = String(secondaryMeta.getLabel(visit) || "").trim();
      return label || DEMO_CLIENT_CROSS_UNKNOWN_TOKEN;
    },
    "visitors",
  ).filter((row) => row.visitors > 0);

  if (topSecondary.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const primarySet = new Set(topPrimary.map((row) => row.label));
  const secondarySet = new Set(topSecondary.map((row) => row.label));
  const rowBuckets = new Map<
    string,
    {
      views: number;
      visitors: Set<string>;
      sessions: Set<string>;
      cells: Map<
        string,
        { views: number; visitors: Set<string>; sessions: Set<string> }
      >;
    }
  >();
  const columnBuckets = new Map<
    string,
    { views: number; visitors: Set<string>; sessions: Set<string> }
  >();

  for (const visit of filtered.visits) {
    const rawPrimary = String(primaryMeta.getLabel(visit) || "").trim();
    if (!rawPrimary) continue;

    const rawSecondary = String(secondaryMeta.getLabel(visit) || "").trim();
    const secondary = rawSecondary || DEMO_CLIENT_CROSS_UNKNOWN_TOKEN;
    const primaryBucket = primarySet.has(rawPrimary)
      ? rawPrimary
      : DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN;
    const secondaryBucket = secondarySet.has(secondary)
      ? secondary
      : DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN;

    const rowBucket = rowBuckets.get(primaryBucket) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
      cells: new Map<
        string,
        { views: number; visitors: Set<string>; sessions: Set<string> }
      >(),
    };
    rowBucket.views += dataset.viewWeight;
    rowBucket.visitors.add(visit.visitorId);
    rowBucket.sessions.add(visit.sessionId);
    const cellBucket = rowBucket.cells.get(secondaryBucket) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    cellBucket.views += dataset.viewWeight;
    cellBucket.visitors.add(visit.visitorId);
    cellBucket.sessions.add(visit.sessionId);
    rowBucket.cells.set(secondaryBucket, cellBucket);
    rowBuckets.set(primaryBucket, rowBucket);

    const columnBucket = columnBuckets.get(secondaryBucket) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    columnBucket.views += dataset.viewWeight;
    columnBucket.visitors.add(visit.visitorId);
    columnBucket.sessions.add(visit.sessionId);
    columnBuckets.set(secondaryBucket, columnBucket);
  }

  const columnKeySet = new Set<string>(["other", "unknown"]);
  const columnDescriptors: Array<{
    bucket: string;
    item: {
      key: string;
      label: string;
      views: number;
      visitors: number;
      sessions: number;
      isOther?: boolean;
      isUnknown?: boolean;
    };
  }> = topSecondary.map((row) => {
    if (row.label === DEMO_CLIENT_CROSS_UNKNOWN_TOKEN) {
      return {
        bucket: row.label,
        item: {
          key: "unknown",
          label: "Unknown",
          views: row.views,
          visitors: row.visitors,
          sessions: row.sessions,
          isUnknown: true,
        },
      };
    }

    return {
      bucket: row.label,
      item: {
        key: createDemoShareTrendSeriesKey(
          row.label,
          columnKeySet,
          secondaryMeta.fallbackKeyBase,
        ),
        label: row.label,
        views: row.views,
        visitors: row.visitors,
        sessions: row.sessions,
      },
    };
  });

  if (columnBuckets.has(DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN)) {
    const otherColumn = columnBuckets.get(
      DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
    ) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    columnDescriptors.push({
      bucket: DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
      item: {
        key: "other",
        label: DEMO_SHARE_TREND_OTHER_LABEL,
        views: Math.max(0, Math.round(otherColumn.views)),
        visitors: Math.max(
          0,
          Math.round(weightedVisitorCount(dataset, otherColumn.visitors)),
        ),
        sessions: Math.max(
          0,
          Math.round(weightedSessionCount(dataset, otherColumn.sessions)),
        ),
        isOther: true,
      },
    });
  }

  const rowKeySet = new Set<string>(["other"]);
  const rowDescriptors: Array<{
    bucket: string;
    item: {
      key: string;
      label: string;
      views: number;
      visitors: number;
      sessions: number;
      isOther?: boolean;
    };
  }> = topPrimary.map((row) => ({
    bucket: row.label,
    item: {
      key: createDemoShareTrendSeriesKey(
        row.label,
        rowKeySet,
        primaryMeta.fallbackKeyBase,
      ),
      label: row.label,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    },
  }));

  if (rowBuckets.has(DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN)) {
    const otherRow = rowBuckets.get(DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
      cells: new Map<
        string,
        { views: number; visitors: Set<string>; sessions: Set<string> }
      >(),
    };
    rowDescriptors.push({
      bucket: DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
      item: {
        key: "other",
        label: DEMO_SHARE_TREND_OTHER_LABEL,
        views: Math.max(0, Math.round(otherRow.views)),
        visitors: Math.max(
          0,
          Math.round(weightedVisitorCount(dataset, otherRow.visitors)),
        ),
        sessions: Math.max(
          0,
          Math.round(weightedSessionCount(dataset, otherRow.sessions)),
        ),
        isOther: true,
      },
    });
  }

  const columns = columnDescriptors.map((column) => column.item);
  const rows = rowDescriptors
    .map((row) => {
      const rowBucket = rowBuckets.get(row.bucket);
      const cells = columnDescriptors.map((column) => {
        const cell = rowBucket?.cells.get(column.bucket);
        return {
          key: column.item.key,
          label: column.item.label,
          views: Math.max(0, Math.round(cell?.views ?? 0)),
          visitors: Math.max(
            0,
            Math.round(
              weightedVisitorCount(
                dataset,
                cell?.visitors ?? new Set<string>(),
              ),
            ),
          ),
          sessions: Math.max(
            0,
            Math.round(
              weightedSessionCount(
                dataset,
                cell?.sessions ?? new Set<string>(),
              ),
            ),
          ),
          ...(column.item.isOther ? { isOther: true } : {}),
          ...(column.item.isUnknown ? { isUnknown: true } : {}),
        };
      });

      return {
        ...row.item,
        views: Math.max(0, Math.round(rowBucket?.views ?? row.item.views)),
        visitors: rowBucket
          ? Math.max(
              0,
              Math.round(weightedVisitorCount(dataset, rowBucket.visitors)),
            )
          : row.item.visitors,
        sessions: rowBucket
          ? Math.max(
              0,
              Math.round(weightedSessionCount(dataset, rowBucket.sessions)),
            )
          : row.item.sessions,
        cells,
      };
    })
    .filter((row) => row.visitors > 0);

  return {
    columns,
    rows,
    totalVisitors: rows.reduce((sum, row) => sum + row.visitors, 0),
  };
}

type DemoClientCrossData = ReturnType<
  typeof generateDemoClientCrossDimensionData
>;

function wrapDemoClientCrossData(data: DemoClientCrossData): {
  ok: true;
  data: DemoClientCrossData;
} {
  return { ok: true, data };
}

export function generateDemoClientCrossBreakdown(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const primaryDimension = parseDemoClientDimensionKey(params.primaryDimension);
  const secondaryDimension = parseDemoClientDimensionKey(
    params.secondaryDimension,
  );
  if (
    !primaryDimension ||
    !secondaryDimension ||
    primaryDimension === secondaryDimension
  ) {
    return wrapDemoClientCrossData({
      columns: [],
      rows: [],
      totalVisitors: 0,
    });
  }

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const primaryLimit = parseDemoLimit(params.primaryLimit, 5, 1, 12);
  const secondaryLimit = parseDemoLimit(params.secondaryLimit, 6, 1, 8);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  return wrapDemoClientCrossData(
    generateDemoClientCrossDimensionData(
      dataset,
      filtered,
      primaryLimit,
      secondaryLimit,
      primaryDimension,
      secondaryDimension,
    ),
  );
}

// ---------------------------------------------------------------------------
//  Data generators (integration-based)
// ---------------------------------------------------------------------------
