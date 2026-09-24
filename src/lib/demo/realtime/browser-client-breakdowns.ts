import "@/lib/analytics/time-zone";
import "@/lib/browser-engine";
import "@/lib/demo/admin/durable-objects";
import "@/lib/demo/admin/system-performance";
import "@/lib/demo/admin/users";
import "@/lib/demo/data/site-profiles";
import "@/lib/demo/generators/utils";
import "@/lib/demo/realtime/dimension-pickers";
import "@/lib/demo/realtime/dimension-pools";
import "@/lib/demo/realtime/path-markov";
import "@/lib/demo/realtime/site-curves";
import "@/lib/demo/realtime/visit-helpers";
import "@/lib/demo/realtime/visitor-pool";

import {
  aggregateDimensionRowsFromVisits,
  applyDemoFilters,
  buildDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoFilters,
  parseDemoNumber,
  parseDemoQueryLimit,
} from "@/lib/demo/realtime/filters";
import {
  createDemoShareTrendSeriesKey,
  DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  DEMO_BROWSER_CROSS_UNKNOWN_TOKEN,
  DEMO_BROWSER_VERSION_UNKNOWN_TOKEN,
  DEMO_SHARE_TREND_OTHER_LABEL,
} from "@/lib/demo/realtime/shared";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/demo/realtime/types";
export function generateDemoBrowserVersionBreakdown(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const rawBrowserLimit = parseDemoNumber(params.browserLimit, 0);
  const browserLimit =
    Number.isFinite(rawBrowserLimit) && rawBrowserLimit > 0
      ? Math.max(1, Math.floor(rawBrowserLimit))
      : Number.MAX_SAFE_INTEGER;
  const versionLimit = parseDemoQueryLimit(params.versionLimit, 5, 1, 8);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const browsers = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    browserLimit,
    (visit) => visit.browser,
    "visitors",
  ).map((browserRow) => {
    const versionRows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits.filter((visit) => visit.browser === browserRow.label),
      999,
      (visit) => visit.browserVersion || DEMO_BROWSER_VERSION_UNKNOWN_TOKEN,
      "visitors",
    );
    const versions = [];
    let otherViews = 0;
    let otherVisitors = 0;
    let otherSessions = 0;

    for (let index = 0; index < versionRows.length; index += 1) {
      const row = versionRows[index];
      if (index < versionLimit) {
        versions.push({
          key:
            row.label === DEMO_BROWSER_VERSION_UNKNOWN_TOKEN
              ? "unknown"
              : createDemoShareTrendSeriesKey(
                  row.label,
                  new Set(["other", "unknown"]),
                  "version",
                ),
          label:
            row.label === DEMO_BROWSER_VERSION_UNKNOWN_TOKEN
              ? "Unknown"
              : row.label,
          views: row.views,
          visitors: row.visitors,
          sessions: row.sessions,
          isUnknown:
            row.label === DEMO_BROWSER_VERSION_UNKNOWN_TOKEN || undefined,
        });
      } else {
        otherViews += row.views;
        otherVisitors += row.visitors;
        otherSessions += row.sessions;
      }
    }

    if (otherVisitors > 0) {
      versions.push({
        key: "other",
        label: DEMO_SHARE_TREND_OTHER_LABEL,
        views: otherViews,
        visitors: otherVisitors,
        sessions: otherSessions,
        isOther: true,
      });
    }

    return {
      browser: browserRow.label,
      views: browserRow.views,
      visitors: browserRow.visitors,
      sessions: browserRow.sessions,
      versions,
    };
  });

  return {
    ok: true,
    data: browsers,
  };
}
function generateDemoBrowserCrossDimension(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  browserLimit: number,
  dimensionLimit: number,
  fallbackKeyBase: string,
  getDimension: (visit: DemoVisitFact) => string,
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
  const topBrowsers = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    browserLimit,
    (visit) => visit.browser,
    "visitors",
  ).filter((row) => row.label.trim().length > 0 && row.visitors > 0);

  if (topBrowsers.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topDimensions = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits.filter(
      (visit) => String(visit.browser || "").trim().length > 0,
    ),
    dimensionLimit,
    (visit) => {
      const label = String(getDimension(visit) || "").trim();
      return label || DEMO_BROWSER_CROSS_UNKNOWN_TOKEN;
    },
    "visitors",
  ).filter((row) => row.visitors > 0);

  if (topDimensions.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const browserSet = new Set(topBrowsers.map((row) => row.label));
  const dimensionSet = new Set(topDimensions.map((row) => row.label));
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
    const browser = String(visit.browser || "").trim();
    if (!browser) continue;

    const rawDimension = String(getDimension(visit) || "").trim();
    const dimension = rawDimension || DEMO_BROWSER_CROSS_UNKNOWN_TOKEN;
    const browserBucket = browserSet.has(browser)
      ? browser
      : DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN;
    const dimensionBucket = dimensionSet.has(dimension)
      ? dimension
      : DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN;

    const rowBucket = rowBuckets.get(browserBucket) ?? {
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
    const cellBucket = rowBucket.cells.get(dimensionBucket) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    cellBucket.views += dataset.viewWeight;
    cellBucket.visitors.add(visit.visitorId);
    cellBucket.sessions.add(visit.sessionId);
    rowBucket.cells.set(dimensionBucket, cellBucket);
    rowBuckets.set(browserBucket, rowBucket);

    const columnBucket = columnBuckets.get(dimensionBucket) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    columnBucket.views += dataset.viewWeight;
    columnBucket.visitors.add(visit.visitorId);
    columnBucket.sessions.add(visit.sessionId);
    columnBuckets.set(dimensionBucket, columnBucket);
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
  }> = topDimensions.map((row) => {
    if (row.label === DEMO_BROWSER_CROSS_UNKNOWN_TOKEN) {
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
          fallbackKeyBase,
        ),
        label: row.label,
        views: row.views,
        visitors: row.visitors,
        sessions: row.sessions,
      },
    };
  });

  if (columnBuckets.has(DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN)) {
    const otherColumn = columnBuckets.get(
      DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
    ) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    columnDescriptors.push({
      bucket: DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
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
  }> = topBrowsers.map((row) => ({
    bucket: row.label,
    item: {
      key: createDemoShareTrendSeriesKey(row.label, rowKeySet, "browser"),
      label: row.label,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    },
  }));

  if (rowBuckets.has(DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN)) {
    const otherRow = rowBuckets.get(DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
      cells: new Map<
        string,
        { views: number; visitors: Set<string>; sessions: Set<string> }
      >(),
    };
    rowDescriptors.push({
      bucket: DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN,
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
export function generateDemoBrowserCrossBreakdown(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const browserLimit = parseDemoQueryLimit(params.browserLimit, 8, 1, 12);
  const osLimit = parseDemoQueryLimit(params.osLimit, 6, 1, 8);
  const deviceTypeLimit = parseDemoQueryLimit(params.deviceTypeLimit, 5, 1, 8);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  return {
    ok: true,
    operatingSystem: generateDemoBrowserCrossDimension(
      dataset,
      filtered,
      browserLimit,
      osLimit,
      "os",
      (visit) => visit.osVersion.split(" ")[0] || visit.osVersion,
    ),
    deviceType: generateDemoBrowserCrossDimension(
      dataset,
      filtered,
      browserLimit,
      deviceTypeLimit,
      "device",
      (visit) => visit.deviceType,
    ),
  };
}
