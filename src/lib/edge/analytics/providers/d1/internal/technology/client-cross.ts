import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildTechnologyCrossBreakdownPlan,
  TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { queryAnalyticsReportOutputSetRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  BrowserCrossBreakdownDimensionDataRow,
  BrowserCrossBreakdownDimensionRow,
  BrowserCrossBreakdownItemRow,
  ClientCrossAggregateRow,
  FilterDocument,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  CLIENT_CROSS_UNKNOWN_TOKEN,
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

interface DimensionDefinition {
  selection: PageDimensionSelection;
  fallbackKeyBase: string;
}

export async function queryCrossDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  primaryLimit: number,
  secondaryLimit: number,
  primaryDimension: DimensionDefinition,
  secondaryDimension: DimensionDefinition,
): Promise<BrowserCrossBreakdownDimensionDataRow> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildTechnologyCrossBreakdownPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    family: "client",
    primarySelection: primaryDimension.selection,
    secondarySelection: secondaryDimension.selection,
    primaryLimit,
    secondaryLimit,
    tokens: {
      unknown: CLIENT_CROSS_UNKNOWN_TOKEN,
      otherPrimary: CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
      otherSecondary: CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
    },
  });
  const queryRows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: Object.values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS),
    fields: [
      "rowType",
      "primaryValue",
      "secondaryValue",
      "views",
      "visitors",
      "sessions",
      "rowOrder",
    ],
    orderBy: [
      { field: "rowType", direction: "asc", nulls: "first" },
      { field: "rowOrder", direction: "asc", nulls: "first" },
      { field: "primaryValue", direction: "asc", nulls: "first" },
      { field: "secondaryValue", direction: "asc", nulls: "first" },
    ],
  });
  const topPrimaryRows = queryRows
    .filter((row) => row.rowType === "primary")
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

  const topSecondaryRows = queryRows
    .filter((row) => row.rowType === "secondary")
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

  const pairRows = queryRows
    .filter((row) => row.rowType === "pair")
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
