import type {
  BrowserCrossBreakdownDimensionDataRow,
  BrowserCrossBreakdownDimensionRow,
  BrowserCrossBreakdownItemRow,
  ClientCrossAggregateRow,
  DashboardFilters,
  QueryWindow,
} from "@/lib/edge/query/core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  CLIENT_CROSS_UNKNOWN_TOKEN,
  queryD1All,
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
  visitSourceBindings,
} from "@/lib/edge/query/core";
import type { Env } from "@/lib/edge/types";

interface DimensionDefinition {
  labelExpr: string;
  fallbackKeyBase: string;
}

export async function queryCrossDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  primaryLimit: number,
  secondaryLimit: number,
  primaryDimension: DimensionDefinition,
  secondaryDimension: DimensionDefinition,
): Promise<BrowserCrossBreakdownDimensionDataRow> {
  const filter = buildVisitFilterSql(filters);
  const normalizedPrimaryLimit = Math.min(Math.max(1, primaryLimit), 12);
  const normalizedSecondaryLimit = Math.min(Math.max(1, secondaryLimit), 8);
  const primaryExpr = primaryDimension.labelExpr;
  const normalizedSecondaryExpr = `CASE WHEN ${secondaryDimension.labelExpr} != '' THEN ${secondaryDimension.labelExpr} ELSE '${CLIENT_CROSS_UNKNOWN_TOKEN}' END`;

  const topPrimarySql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${primaryExpr} AS primaryValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  primaryValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE primaryValue != ''
GROUP BY primaryValue
ORDER BY visitors DESC, views DESC, sessions DESC, primaryValue ASC
LIMIT ?
`;
  const topPrimaryRows = (
    await queryD1All<Record<string, unknown>>(env, topPrimarySql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      normalizedPrimaryLimit,
    ])
  )
    .map((row) => ({
      value: String(row.primaryValue ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.value.length > 0 && row.visitors > 0);

  if (topPrimaryRows.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topSecondarySql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${primaryExpr} AS primaryValue,
    ${normalizedSecondaryExpr} AS secondaryValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  secondaryValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE primaryValue != ''
GROUP BY secondaryValue
ORDER BY visitors DESC, views DESC, sessions DESC, secondaryValue ASC
LIMIT ?
`;
  const topSecondaryRows = (
    await queryD1All<Record<string, unknown>>(env, topSecondarySql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      normalizedSecondaryLimit,
    ])
  )
    .map((row) => ({
      value:
        String(row.secondaryValue ?? "").trim() || CLIENT_CROSS_UNKNOWN_TOKEN,
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.visitors > 0);

  if (topSecondaryRows.length === 0) {
    return {
      columns: [],
      rows: [],
      totalVisitors: 0,
    };
  }

  const topPrimaryLabels = topPrimaryRows.map((row) => row.value);
  const topSecondaryLabels = topSecondaryRows.map((row) => row.value);
  const topPrimaryPlaceholders = topPrimaryLabels.map(() => "?").join(", ");
  const topSecondaryPlaceholders = topSecondaryLabels.map(() => "?").join(", ");
  const pairsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${primaryExpr} AS primaryValue,
    ${normalizedSecondaryExpr} AS secondaryValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
),
normalized_visits AS (
  SELECT
    CASE
      WHEN primaryValue IN (${topPrimaryPlaceholders}) THEN primaryValue
      ELSE '${CLIENT_CROSS_OTHER_PRIMARY_TOKEN}'
    END AS primaryBucket,
    CASE
      WHEN secondaryValue IN (${topSecondaryPlaceholders}) THEN secondaryValue
      ELSE '${CLIENT_CROSS_OTHER_SECONDARY_TOKEN}'
    END AS secondaryBucket,
    visitorId,
    sessionId
  FROM filtered_visits
  WHERE primaryValue != ''
)
SELECT
  primaryBucket AS primaryValue,
  secondaryBucket AS secondaryValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM normalized_visits
GROUP BY primaryBucket, secondaryBucket
ORDER BY primaryValue ASC, secondaryValue ASC
`;
  const pairRows = (
    await queryD1All<Record<string, unknown>>(env, pairsSql, [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      ...topPrimaryLabels,
      ...topSecondaryLabels,
    ])
  )
    .map(
      (row) =>
        ({
          primary: String(row.primaryValue ?? "").trim(),
          secondary: String(row.secondaryValue ?? "").trim(),
          views: Number(row.views ?? 0),
          visitors: Number(row.visitors ?? 0),
          sessions: Number(row.sessions ?? 0),
        }) satisfies ClientCrossAggregateRow,
    )
    .filter(
      (row) =>
        row.primary.length > 0 && row.secondary.length > 0 && row.visitors > 0,
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
    const rowBucket = rowBuckets.get(row.primary) ?? {
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
    const existingCell = rowBucket.cells.get(row.secondary) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    existingCell.views += row.views;
    existingCell.visitors += row.visitors;
    existingCell.sessions += row.sessions;
    rowBucket.cells.set(row.secondary, existingCell);
    rowBuckets.set(row.primary, rowBucket);

    const columnBucket = columnBuckets.get(row.secondary) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    columnBucket.views += row.views;
    columnBucket.visitors += row.visitors;
    columnBucket.sessions += row.sessions;
    columnBuckets.set(row.secondary, columnBucket);
  }

  const columnKeySet = new Set<string>(["other", "unknown"]);
  const columnDescriptors: Array<{
    bucket: string;
    item: BrowserCrossBreakdownItemRow;
  }> = topSecondaryRows.map((row) => {
    if (row.value === CLIENT_CROSS_UNKNOWN_TOKEN) {
      return {
        bucket: row.value,
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
      bucket: row.value,
      item: {
        key: shareTrendSeriesKey(
          row.value,
          columnKeySet,
          secondaryDimension.fallbackKeyBase,
        ),
        label: row.value,
        views: row.views,
        visitors: row.visitors,
        sessions: row.sessions,
      } satisfies BrowserCrossBreakdownItemRow,
    };
  });

  if (columnBuckets.has(CLIENT_CROSS_OTHER_SECONDARY_TOKEN)) {
    const otherColumn = columnBuckets.get(
      CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
    ) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
    };
    columnDescriptors.push({
      bucket: CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
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
  }> = topPrimaryRows.map((row) => ({
    bucket: row.value,
    item: {
      key: shareTrendSeriesKey(
        row.value,
        rowKeySet,
        primaryDimension.fallbackKeyBase,
      ),
      label: row.value,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    } satisfies BrowserCrossBreakdownItemRow,
  }));

  if (rowBuckets.has(CLIENT_CROSS_OTHER_PRIMARY_TOKEN)) {
    const otherRow = rowBuckets.get(CLIENT_CROSS_OTHER_PRIMARY_TOKEN) ?? {
      views: 0,
      visitors: 0,
      sessions: 0,
      cells: new Map<
        string,
        { views: number; visitors: number; sessions: number }
      >(),
    };
    rowDescriptors.push({
      bucket: CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
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
