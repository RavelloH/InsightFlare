import { browserEngineCaseSql } from "@/lib/browser-engine";
import type {
  BrowserCrossAggregateRow,
  BrowserCrossBreakdownDimensionDataRow,
  BrowserCrossBreakdownDimensionRow,
  BrowserCrossBreakdownItemRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
  BrowserVersionAggregateRow,
  BrowserVersionBreakdownRow,
  BrowserVersionSliceRow,
  DashboardFilters,
  Interval,
  QueryWindow,
} from "@/lib/edge/query/core";
import {
  BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  BROWSER_CROSS_UNKNOWN_TOKEN,
  BROWSER_VERSION_UNKNOWN_TOKEN,
  browserMajorVersionExpr,
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
  visitSourceBindings,
} from "@/lib/edge/query/core";
import type { Env } from "@/lib/edge/types";

import { queryShareTrendFromD1 } from "./share-trend";

export async function queryBrowserTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    "TRIM(COALESCE(browser, ''))",
    "browser",
  );
}

export async function queryBrowserEngineTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    browserEngineCaseSql("browser", "os"),
    "engine",
  );
}

export async function queryBrowserVersionBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  browserLimit: number,
  versionLimit: number,
): Promise<BrowserVersionBreakdownRow[]> {
  const filter = buildVisitFilterSql(filters);
  const normalizedBrowserLimit =
    Number.isFinite(browserLimit) && browserLimit > 0
      ? Math.max(1, Math.floor(browserLimit))
      : null;
  const normalizedVersionLimit = Math.min(Math.max(1, versionLimit), 8);
  const browserLimitClause = normalizedBrowserLimit
    ? "WHERE browserRank <= ?"
    : "WHERE 1 = 1";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    TRIM(COALESCE(browser, '')) AS browser,
    browser_version,
    visitor_id,
    session_id
  FROM visit_source
  ${filter.clause}
),
browser_rollup AS (
  SELECT
    browser,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM filtered_visits
  WHERE browser != ''
  GROUP BY browser
),
ranked_browsers AS (
  SELECT
    browser,
    views,
    visitors,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY visitors DESC, views DESC, sessions DESC, browser ASC
    ) AS browserRank
  FROM browser_rollup
),
top_browsers AS (
  SELECT browser, views, visitors, sessions, browserRank
  FROM ranked_browsers
  ${browserLimitClause}
),
versioned_visits AS (
  SELECT
    fv.browser,
    CASE
      WHEN ${browserMajorVersionExpr("fv")} != ''
        THEN ${browserMajorVersionExpr("fv")}
      ELSE '${BROWSER_VERSION_UNKNOWN_TOKEN}'
    END AS version,
    fv.visitor_id,
    fv.session_id
  FROM filtered_visits fv
  INNER JOIN top_browsers tb ON tb.browser = fv.browser
),
version_rollup AS (
  SELECT
    browser,
    version,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM versioned_visits
  GROUP BY browser, version
  HAVING COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) > 0
)
SELECT
  tb.browser,
  tb.views,
  tb.visitors,
  tb.sessions,
  tb.browserRank,
  vr.version,
  vr.version AS versionLabel,
  vr.views AS versionViews,
  vr.visitors AS versionVisitors,
  vr.sessions AS versionSessions
FROM top_browsers tb
LEFT JOIN version_rollup vr ON vr.browser = tb.browser
ORDER BY tb.browserRank ASC, versionVisitors DESC, versionViews DESC,
  versionSessions DESC, versionLabel ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
    ...(normalizedBrowserLimit ? [normalizedBrowserLimit] : []),
  ]);
  const topBrowsersByName = new Map<string, BrowserVersionAggregateRow>();
  const versionRows: BrowserVersionAggregateRow[] = [];
  for (const row of rows) {
    const browser = String(row.browser ?? "").trim();
    const browserVisitors = Number(row.visitors ?? 0);
    if (!browser || browserVisitors <= 0) continue;
    if (!topBrowsersByName.has(browser)) {
      topBrowsersByName.set(browser, {
        browser,
        version: "",
        views: Number(row.views ?? 0),
        visitors: browserVisitors,
        sessions: Number(row.sessions ?? 0),
      });
    }
    const version = String(row.version ?? "").trim();
    const versionVisitors = Number(row.versionVisitors ?? 0);
    if (version && versionVisitors > 0) {
      versionRows.push({
        browser,
        version,
        views: Number(row.versionViews ?? 0),
        visitors: versionVisitors,
        sessions: Number(row.versionSessions ?? 0),
      });
    }
  }
  const topBrowsers = [...topBrowsersByName.values()];
  if (topBrowsers.length === 0) return [];

  const versionsByBrowser = new Map<string, BrowserVersionAggregateRow[]>();
  for (const row of versionRows) {
    const bucket = versionsByBrowser.get(row.browser) ?? [];
    bucket.push(row);
    versionsByBrowser.set(row.browser, bucket);
  }

  return topBrowsers.map((browserRow) => {
    const rows = versionsByBrowser.get(browserRow.browser) ?? [];
    const usedKeys = new Set<string>(["other", "unknown"]);
    const versions: BrowserVersionSliceRow[] = [];
    let otherViews = 0;
    let otherVisitors = 0;
    let otherSessions = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (index < normalizedVersionLimit) {
        if (row.version === BROWSER_VERSION_UNKNOWN_TOKEN) {
          versions.push({
            key: "unknown",
            label: "Unknown",
            views: row.views,
            visitors: row.visitors,
            sessions: row.sessions,
            isUnknown: true,
          });
        } else {
          versions.push({
            key: shareTrendSeriesKey(row.version, usedKeys, "version"),
            label: row.version,
            views: row.views,
            visitors: row.visitors,
            sessions: row.sessions,
          });
        }
        continue;
      }

      otherViews += row.views;
      otherVisitors += row.visitors;
      otherSessions += row.sessions;
    }

    if (otherVisitors > 0) {
      versions.push({
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: otherViews,
        visitors: otherVisitors,
        sessions: otherSessions,
        isOther: true,
      });
    }

    return {
      browser: browserRow.browser,
      views: browserRow.views,
      visitors: browserRow.visitors,
      sessions: browserRow.sessions,
      versions,
    };
  });
}

export async function queryBrowserCrossDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  browserLimit: number,
  dimensionLimit: number,
  dimensionExpr: string,
  fallbackKeyBase: string,
): Promise<BrowserCrossBreakdownDimensionDataRow> {
  const filter = buildVisitFilterSql(filters);
  const normalizedBrowserLimit = Math.min(Math.max(1, browserLimit), 12);
  const normalizedDimensionLimit = Math.min(Math.max(1, dimensionLimit), 8);
  const browserExpr = "TRIM(COALESCE(browser, ''))";
  const normalizedDimensionExpr = `CASE WHEN ${dimensionExpr} != '' THEN ${dimensionExpr} ELSE '${BROWSER_CROSS_UNKNOWN_TOKEN}' END`;
  const topBrowsersSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${browserExpr} AS browser,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  browser,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE browser != ''
GROUP BY browser
ORDER BY visitors DESC, views DESC, sessions DESC, browser ASC
LIMIT ?
`;
  const topBrowsers = (
    await queryD1All<Record<string, unknown>>(env, topBrowsersSql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      normalizedBrowserLimit,
    ])
  )
    .map((row) => ({
      browser: String(row.browser ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.browser.length > 0 && row.visitors > 0);

  if (topBrowsers.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topDimensionsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${browserExpr} AS browser,
    ${normalizedDimensionExpr} AS dimension,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  dimension,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE browser != ''
GROUP BY dimension
ORDER BY visitors DESC, views DESC, sessions DESC, dimension ASC
LIMIT ?
`;
  const topDimensions = (
    await queryD1All<Record<string, unknown>>(env, topDimensionsSql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      normalizedDimensionLimit,
    ])
  )
    .map((row) => ({
      dimension:
        String(row.dimension ?? "").trim() || BROWSER_CROSS_UNKNOWN_TOKEN,
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.visitors > 0);

  if (topDimensions.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topBrowserLabels = topBrowsers.map((row) => row.browser);
  const topDimensionLabels = topDimensions.map((row) => row.dimension);
  const topBrowserPlaceholders = topBrowserLabels.map(() => "?").join(", ");
  const topDimensionPlaceholders = topDimensionLabels.map(() => "?").join(", ");
  const pairsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${browserExpr} AS browser,
    ${normalizedDimensionExpr} AS dimension,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
),
normalized_visits AS (
  SELECT
    CASE
      WHEN browser IN (${topBrowserPlaceholders}) THEN browser
      ELSE '${BROWSER_CROSS_OTHER_BROWSER_TOKEN}'
    END AS browserBucket,
    CASE
      WHEN dimension IN (${topDimensionPlaceholders}) THEN dimension
      ELSE '${BROWSER_CROSS_OTHER_DIMENSION_TOKEN}'
    END AS dimensionBucket,
    visitorId,
    sessionId
  FROM filtered_visits
  WHERE browser != ''
)
SELECT
  browserBucket AS browser,
  dimensionBucket AS dimension,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM normalized_visits
GROUP BY browserBucket, dimensionBucket
ORDER BY browser ASC, dimension ASC
`;
  const pairRows = (
    await queryD1All<Record<string, unknown>>(env, pairsSql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      ...topBrowserLabels,
      ...topDimensionLabels,
    ])
  )
    .map(
      (row) =>
        ({
          browser: String(row.browser ?? "").trim(),
          dimension: String(row.dimension ?? "").trim(),
          views: Number(row.views ?? 0),
          visitors: Number(row.visitors ?? 0),
          sessions: Number(row.sessions ?? 0),
        }) satisfies BrowserCrossAggregateRow,
    )
    .filter(
      (row) =>
        row.browser.length > 0 && row.dimension.length > 0 && row.visitors > 0,
    );

  const rowBuckets = new Map<
    string,
    {
      views: number;
      visitors: number;
      sessions: number;
      cells: Map<string, { views: number; visitors: number; sessions: number }>;
    }
  >();
  const columnBuckets = new Map<
    string,
    { views: number; visitors: number; sessions: number }
  >();

  for (const row of pairRows) {
    const rowBucket = rowBuckets.get(row.browser) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
      cells: new Map<
        string,
        { views: number; visitors: number; sessions: number }
      >(),
    };
    rowBucket.views += row.views;
    rowBucket.visitors += row.visitors;
    rowBucket.sessions += row.sessions;
    const existingCell = rowBucket.cells.get(row.dimension) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    existingCell.views += row.views;
    existingCell.visitors += row.visitors;
    existingCell.sessions += row.sessions;
    rowBucket.cells.set(row.dimension, existingCell);
    rowBuckets.set(row.browser, rowBucket);

    const columnBucket = columnBuckets.get(row.dimension) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    columnBucket.views += row.views;
    columnBucket.visitors += row.visitors;
    columnBucket.sessions += row.sessions;
    columnBuckets.set(row.dimension, columnBucket);
  }

  const columnKeySet = new Set<string>(["other", "unknown"]);
  const columnDescriptors: Array<{
    bucket: string;
    item: BrowserCrossBreakdownItemRow;
  }> = topDimensions.map((row) => {
    if (row.dimension === BROWSER_CROSS_UNKNOWN_TOKEN) {
      return {
        bucket: row.dimension,
        item: {
          key: "unknown",
          label: "Unknown",
          views: row.views,
          visitors: row.visitors,
          sessions: row.sessions,
          isUnknown: true,
        } satisfies BrowserCrossBreakdownItemRow,
      };
    }

    return {
      bucket: row.dimension,
      item: {
        key: shareTrendSeriesKey(row.dimension, columnKeySet, fallbackKeyBase),
        label: row.dimension,
        views: row.views,
        visitors: row.visitors,
        sessions: row.sessions,
      } satisfies BrowserCrossBreakdownItemRow,
    };
  });

  if (columnBuckets.has(BROWSER_CROSS_OTHER_DIMENSION_TOKEN)) {
    const otherColumn = columnBuckets.get(
      BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
    ) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    columnDescriptors.push({
      bucket: BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
      item: {
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: otherColumn.views,
        visitors: otherColumn.visitors,
        sessions: otherColumn.sessions,
        isOther: true,
      } satisfies BrowserCrossBreakdownItemRow,
    });
  }

  const rowKeySet = new Set<string>(["other"]);
  const rowDescriptors: Array<{
    bucket: string;
    item: BrowserCrossBreakdownItemRow;
  }> = topBrowsers.map((row) => ({
    bucket: row.browser,
    item: {
      key: shareTrendSeriesKey(row.browser, rowKeySet, "browser"),
      label: row.browser,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    } satisfies BrowserCrossBreakdownItemRow,
  }));

  if (rowBuckets.has(BROWSER_CROSS_OTHER_BROWSER_TOKEN)) {
    const otherRow = rowBuckets.get(BROWSER_CROSS_OTHER_BROWSER_TOKEN) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
      cells: new Map<
        string,
        { views: number; visitors: number; sessions: number }
      >(),
    };
    rowDescriptors.push({
      bucket: BROWSER_CROSS_OTHER_BROWSER_TOKEN,
      item: {
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: otherRow.views,
        visitors: otherRow.visitors,
        sessions: otherRow.sessions,
        isOther: true,
      } satisfies BrowserCrossBreakdownItemRow,
    });
  }

  const columns = columnDescriptors.map((column) => column.item);
  const rows = rowDescriptors
    .map((row) => {
      const bucket = rowBuckets.get(row.bucket) ?? {
        views: row.item.views,
        visitors: row.item.visitors,
        sessions: row.item.sessions,
        cells: new Map<
          string,
          { views: number; visitors: number; sessions: number }
        >(),
      };
      const cells = columnDescriptors.map((column) => {
        const cell = bucket.cells.get(column.bucket) ?? {
          views: 0,
          visitors: 0,
          sessions: 0,
        };
        return {
          key: column.item.key,
          label: column.item.label,
          views: cell.views,
          visitors: cell.visitors,
          sessions: cell.sessions,
          ...(column.item.isOther ? { isOther: true } : {}),
          ...(column.item.isUnknown ? { isUnknown: true } : {}),
        } satisfies BrowserCrossBreakdownItemRow;
      });

      return {
        ...row.item,
        views: bucket.views,
        visitors: bucket.visitors,
        sessions: bucket.sessions,
        cells,
      } satisfies BrowserCrossBreakdownDimensionRow;
    })
    .filter((row) => row.visitors > 0);

  return {
    columns,
    rows,
    totalVisitors: rows.reduce((sum, row) => sum + row.visitors, 0),
  };
}

export async function queryBrowserCrossBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  browserLimit: number,
  osLimit: number,
  deviceTypeLimit: number,
): Promise<{
  operatingSystem: BrowserCrossBreakdownDimensionDataRow;
  deviceType: BrowserCrossBreakdownDimensionDataRow;
}> {
  const [operatingSystem, deviceType] = await Promise.all([
    queryBrowserCrossDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      browserLimit,
      osLimit,
      "TRIM(COALESCE(os, ''))",
      "os",
    ),
    queryBrowserCrossDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      browserLimit,
      deviceTypeLimit,
      "TRIM(COALESCE(device_type, ''))",
      "device",
    ),
  ]);

  return {
    operatingSystem,
    deviceType,
  };
}
