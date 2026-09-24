import "@/lib/analytics/time-zone";
import "@/lib/demo/admin/durable-objects";
import "@/lib/demo/admin/system-performance";
import "@/lib/demo/admin/users";
import "@/lib/demo/data/site-profiles";
import "@/lib/demo/generators/utils";
import "@/lib/demo/realtime/dimension-pickers";
import "@/lib/demo/realtime/dimension-pools";
import "@/lib/demo/realtime/path-markov";
import "@/lib/demo/realtime/site-curves";
import "@/lib/demo/realtime/visitor-pool";

import { browserEngineLabel } from "@/lib/browser-engine";
import {
  aggregateDimensionRowsFromVisits,
  applyDemoFilters,
  buildDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  parseDemoFilters,
  parseDemoNumber,
  parseDemoQueryLimit,
} from "@/lib/demo/realtime/filters";
import {
  createDemoShareTrendSeriesKey,
  DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  DEMO_CLIENT_CROSS_UNKNOWN_TOKEN,
  DEMO_SHARE_TREND_OTHER_LABEL,
  type DemoClientDimensionKey,
  demoClientDimensionMeta,
} from "@/lib/demo/realtime/shared";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/demo/realtime/types";
import {
  demoHashFragmentForVisit,
  demoQueryStringForVisit,
} from "@/lib/demo/realtime/visit-helpers";
type DemoCrossDimensionKey =
  | DemoClientDimensionKey
  | "page.path"
  | "page.title"
  | "page.hostname"
  | "page.query"
  | "page.hash"
  | "referrer.domain"
  | "referrer.url"
  | "utm.source"
  | "utm.medium"
  | "utm.campaign"
  | "utm.term"
  | "utm.content"
  | "client.browserVersion"
  | "client.browserEngine"
  | "client.osVersion"
  | "geo.country"
  | "geo.region"
  | "geo.city"
  | "geo.continent"
  | "geo.timeZone"
  | "geo.organization";
type DemoCrossDimensionMeta = {
  fallbackKeyBase: string;
  getLabel: (visit: DemoVisitFact) => string;
};
function parseDemoCrossDimensionKey(
  value: string | number | undefined,
): DemoCrossDimensionKey | null {
  const normalized = String(value ?? "").trim();
  const aliases: Record<string, DemoCrossDimensionKey> = {
    "client.browser": "browser",
    "client.os": "operatingSystem",
    "client.osVersion": "osVersion",
    "client.deviceType": "deviceType",
    "client.language": "language",
    "client.screenSize": "screenSize",
  };
  return (
    aliases[normalized] ??
    (CROSS_DIMENSION_KEYS.has(normalized)
      ? (normalized as DemoCrossDimensionKey)
      : null)
  );
}
const CROSS_DIMENSION_KEYS = new Set<string>([
  "browser",
  "operatingSystem",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "referrer.domain",
  "referrer.url",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browserVersion",
  "client.browserEngine",
  "client.osVersion",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
]);
function demoCrossDimensionMeta(
  dimension: DemoCrossDimensionKey,
): DemoCrossDimensionMeta {
  if (
    dimension === "browser" ||
    dimension === "operatingSystem" ||
    dimension === "osVersion" ||
    dimension === "deviceType" ||
    dimension === "language" ||
    dimension === "screenSize"
  ) {
    return demoClientDimensionMeta(dimension);
  }
  const definitions: Record<
    Exclude<DemoCrossDimensionKey, DemoClientDimensionKey>,
    DemoCrossDimensionMeta
  > = {
    "page.path": {
      fallbackKeyBase: "page",
      getLabel: (visit) => visit.pathname,
    },
    "page.title": {
      fallbackKeyBase: "title",
      getLabel: (visit) => visit.title,
    },
    "page.hostname": {
      fallbackKeyBase: "hostname",
      getLabel: (visit) => visit.hostname,
    },
    "page.query": {
      fallbackKeyBase: "query",
      getLabel: (visit) => demoQueryStringForVisit(visit),
    },
    "page.hash": {
      fallbackKeyBase: "hash",
      getLabel: (visit) => demoHashFragmentForVisit(visit),
    },
    "referrer.domain": {
      fallbackKeyBase: "referrer-domain",
      getLabel: (visit) =>
        visit.referrerHost || DEMO_DIRECT_REFERRER_FILTER_VALUE,
    },
    "referrer.url": {
      fallbackKeyBase: "referrer-url",
      getLabel: (visit) => visit.referrerUrl,
    },
    "utm.source": {
      fallbackKeyBase: "utm-source",
      getLabel: (visit) => visit.utmSource ?? "",
    },
    "utm.medium": {
      fallbackKeyBase: "utm-medium",
      getLabel: (visit) => visit.utmMedium ?? "",
    },
    "utm.campaign": {
      fallbackKeyBase: "utm-campaign",
      getLabel: (visit) => visit.utmCampaign ?? "",
    },
    "utm.term": {
      fallbackKeyBase: "utm-term",
      getLabel: () => "",
    },
    "utm.content": {
      fallbackKeyBase: "utm-content",
      getLabel: () => "",
    },
    "client.browserVersion": {
      fallbackKeyBase: "browser-version",
      getLabel: (visit) => visit.browserVersion,
    },
    "client.browserEngine": {
      fallbackKeyBase: "engine",
      getLabel: (visit) => browserEngineLabel(visit.browser, visit.osVersion),
    },
    "client.osVersion": {
      fallbackKeyBase: "os-version",
      getLabel: (visit) => visit.osVersion,
    },
    "geo.country": {
      fallbackKeyBase: "country",
      getLabel: (visit) => visit.country,
    },
    "geo.region": {
      fallbackKeyBase: "region",
      getLabel: (visit) => visit.region,
    },
    "geo.city": { fallbackKeyBase: "city", getLabel: (visit) => visit.city },
    "geo.continent": {
      fallbackKeyBase: "continent",
      getLabel: (visit) => visit.continent,
    },
    "geo.timeZone": {
      fallbackKeyBase: "timezone",
      getLabel: (visit) => visit.timezone,
    },
    "geo.organization": {
      fallbackKeyBase: "organization",
      getLabel: (visit) => visit.organization,
    },
  };
  return definitions[
    dimension as Exclude<DemoCrossDimensionKey, DemoClientDimensionKey>
  ];
}
function generateDemoClientCrossDimensionData(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  primaryLimit: number,
  secondaryLimit: number,
  primaryDimension: DemoCrossDimensionKey,
  secondaryDimension: DemoCrossDimensionKey,
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
  const primaryMeta = demoCrossDimensionMeta(primaryDimension);
  const secondaryMeta = demoCrossDimensionMeta(secondaryDimension);
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
  const primaryDimension = parseDemoCrossDimensionKey(params.primaryDimension);
  const secondaryDimension = parseDemoCrossDimensionKey(
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
  const primaryLimit = parseDemoQueryLimit(params.primaryLimit, 5, 1, 12);
  const secondaryLimit = parseDemoQueryLimit(params.secondaryLimit, 6, 1, 8);
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
