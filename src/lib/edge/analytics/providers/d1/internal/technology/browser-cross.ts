import {
  TECHNOLOGY_CROSS_BROWSER_OTHER_PRIMARY_TOKEN as BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_OTHER_SECONDARY_TOKEN as BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_UNKNOWN_TOKEN as BROWSER_CROSS_UNKNOWN_TOKEN,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import type {
  BrowserCrossAggregateRow,
  BrowserCrossBreakdownDimensionDataRow,
  BrowserCrossBreakdownDimensionRow,
  BrowserCrossBreakdownItemRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";

export function mapBrowserCrossDimensionRows(
  queryRows: readonly Record<string, unknown>[],
  fallbackKeyBase: string,
): BrowserCrossBreakdownDimensionDataRow {
  const topBrowsers = queryRows
    .filter((row) => row.rowType === "browser")
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

  const topDimensions = queryRows
    .filter((row) => row.rowType === "dimension")
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

  const pairRows = queryRows
    .filter((row) => row.rowType === "pair")
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
