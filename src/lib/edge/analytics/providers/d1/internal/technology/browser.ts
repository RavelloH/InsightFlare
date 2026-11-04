import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  BROWSER_VERSION_BREAKDOWN_OUTPUT,
  buildBrowserVersionBreakdownPlan,
  normalizeBrowserVersionBreakdownVersionLimit,
} from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import {
  PAGE_DIMENSION_SELECTIONS,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildTechnologyCrossBreakdownPlan,
  TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  BrowserCrossBreakdownDimensionDataRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
  BrowserVersionAggregateRow,
  BrowserVersionBreakdownRow,
  BrowserVersionSliceRow,
  FilterDocument,
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  BROWSER_CROSS_UNKNOWN_TOKEN,
  BROWSER_VERSION_UNKNOWN_TOKEN,
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

import { mapBrowserCrossDimensionRows } from "./browser-cross";
import { queryShareTrendFromD1 } from "./share-trend";

export { mapBrowserCrossDimensionRows } from "./browser-cross";

export async function queryBrowserTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
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
    "browser",
  );
}

export async function queryBrowserEngineTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
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
    "browserEngine",
  );
}

export async function queryBrowserVersionBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  browserLimit: number,
  versionLimit: number,
): Promise<BrowserVersionBreakdownRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    buildBrowserVersionBreakdownPlan({
      siteId,
      queryTime: queryWindowToTime(window),
      filters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
      browserLimit,
    }),
    BROWSER_VERSION_BREAKDOWN_OUTPUT,
  );
  return mapBrowserVersionBreakdownRows(rows, versionLimit);
}

/** Maps the legacy Browser-version report rows for both qualified and plain paths. */
export function mapBrowserVersionBreakdownRows(
  rows: readonly Record<string, unknown>[],
  versionLimit: number,
): BrowserVersionBreakdownRow[] {
  const normalizedVersionLimit =
    normalizeBrowserVersionBreakdownVersionLimit(versionLimit);
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
  filters: FilterDocument,
  browserLimit: number,
  dimensionLimit: number,
  dimensionSelection: PageDimensionSelection,
  fallbackKeyBase: string,
): Promise<BrowserCrossBreakdownDimensionDataRow> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildTechnologyCrossBreakdownPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    family: "browser",
    primarySelection: PAGE_DIMENSION_SELECTIONS.browser,
    secondarySelection: dimensionSelection,
    primaryLimit: browserLimit,
    secondaryLimit: dimensionLimit,
    tokens: {
      unknown: BROWSER_CROSS_UNKNOWN_TOKEN,
      otherPrimary: BROWSER_CROSS_OTHER_BROWSER_TOKEN,
      otherSecondary: BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
    },
  });
  const queryRows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: Object.values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS),
    fields: [
      "rowType",
      "browser",
      "dimension",
      "views",
      "visitors",
      "sessions",
      "rowOrder",
    ],
    orderBy: [
      { field: "rowType", direction: "asc", nulls: "first" },
      { field: "rowOrder", direction: "asc", nulls: "first" },
      { field: "browser", direction: "asc", nulls: "first" },
      { field: "dimension", direction: "asc", nulls: "first" },
    ],
  });
  return mapBrowserCrossDimensionRows(queryRows, fallbackKeyBase);
}

export async function queryBrowserCrossBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
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
      PAGE_DIMENSION_SELECTIONS.operatingSystem,
      "os",
    ),
    queryBrowserCrossDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      browserLimit,
      deviceTypeLimit,
      PAGE_DIMENSION_SELECTIONS.deviceType,
      "device",
    ),
  ]);

  return {
    operatingSystem,
    deviceType,
  };
}
