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
  buildTechnologyBrowserCrossBreakdownPlan,
  buildTechnologyCrossBreakdownPlan,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS,
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
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import type { QualificationExecutionInputs } from "@/lib/edge/analytics/providers/d1/internal/qualification-execution-inputs";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";

import { mapBrowserCrossDimensionRows } from "./browser-cross";
import {
  bindTechnologyPageVisitQualification,
  type TechnologyPageVisitQualification,
} from "./page-visit-qualification";
import { queryShareTrendFromD1 } from "./share-trend";

export { mapBrowserCrossDimensionRows } from "./browser-cross";

export async function queryBrowserTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
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
    qualification,
    ...((wholeOriginalOwner && execution
      ? [wholeOriginalOwner, execution]
      : wholeOriginalOwner
        ? [wholeOriginalOwner]
        : []) as [object?, D1ExecutionOptions?]),
  );
}

export async function queryBrowserEngineTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
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
    qualification,
    ...((wholeOriginalOwner && execution
      ? [wholeOriginalOwner, execution]
      : wholeOriginalOwner
        ? [wholeOriginalOwner]
        : []) as [object?, D1ExecutionOptions?]),
  );
}

export async function queryBrowserVersionBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  browserLimit: number,
  versionLimit: number,
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<BrowserVersionBreakdownRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime = qualification?.queryTime ?? queryWindowToTime(window);
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "radar",
            reader: {
              kind: "technology-browser-version",
              configuration: { browserLimit, versionLimit },
            },
          },
          siteId,
          filters,
          queryTime: metadata?.time ?? queryWindowToTime(window),
          scopePlan: metadata?.plan,
          readerQueryTime: queryWindowToTime(window),
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const plan =
    wholeOriginal?.plan ??
    buildBrowserVersionBreakdownPlan({
      siteId,
      queryTime,
      filters,
      ...(qualification
        ? {
            scopePlan: qualification.scopePlan,
            pageVisitQualification: true as const,
          }
        : metadata
          ? { scopePlan: metadata.plan }
          : {}),
      browserLimit,
    });
  const bound =
    wholeOriginal ??
    bindTechnologyPageVisitQualification({
      siteId,
      filters,
      qualification,
      plan,
    });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    bound.plan,
    BROWSER_VERSION_BREAKDOWN_OUTPUT,
    undefined,
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
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
  wholeOriginal?: {
    readonly owner: object;
    readonly stage: "operatingSystem" | "deviceType";
    readonly configuration: {
      readonly browserLimit: number;
      readonly operatingSystemLimit: number;
      readonly deviceTypeLimit: number;
    };
  },
): Promise<BrowserCrossBreakdownDimensionDataRow> {
  const metadata = scopedFilterMetadata(filters);
  const readerQueryTime = queryWindowToTime(window);
  const wholeOriginalBound = wholeOriginal
    ? bindWholeOriginalReader({
        owner: wholeOriginal.owner,
        consumer: {
          kind: "page",
          family: "cross-dimension",
          reader: {
            kind: "technology-browser-cross-stage",
            stage: wholeOriginal.stage,
            configuration: wholeOriginal.configuration,
          },
        },
        siteId,
        filters,
        queryTime: metadata?.time ?? readerQueryTime,
        ...(metadata ? { scopePlan: metadata.plan } : {}),
        readerQueryTime,
      })
    : undefined;
  const plan =
    wholeOriginalBound?.plan ??
    buildTechnologyCrossBreakdownPlan({
      siteId,
      queryTime: readerQueryTime,
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
  const queryRows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    plan,
    {
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
    },
    ...((wholeOriginalBound
      ? [undefined, wholeOriginalBound.executionInputs]
      : []) as [undefined?, QualificationExecutionInputs?]),
  );
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
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
): Promise<{
  operatingSystem: BrowserCrossBreakdownDimensionDataRow;
  deviceType: BrowserCrossBreakdownDimensionDataRow;
}> {
  if (qualification) {
    const plan = buildTechnologyBrowserCrossBreakdownPlan({
      siteId,
      queryTime: qualification.queryTime,
      filters,
      scopePlan: qualification.scopePlan,
      pageVisitQualification: true,
      browserLimit,
      operatingSystemLimit: osLimit,
      deviceTypeLimit,
    });
    const bound = bindTechnologyPageVisitQualification({
      siteId,
      filters,
      qualification,
      plan,
    });
    const outputIds = [
      ...Object.values(
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem,
      ),
      ...Object.values(TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType),
    ];
    const queryRows = await queryAnalyticsReportOutputSetRowsFromD1(
      env,
      bound.plan,
      {
        outputIds,
        fields: [
          "rowType",
          "browser",
          "dimension",
          "crossFamily",
          "views",
          "visitors",
          "sessions",
          "rowOrder",
        ],
        orderBy: [
          {
            field: "crossFamily",
            direction: "asc",
            nulls: "first",
          },
          {
            field: "rowType",
            direction: "asc",
            nulls: "first",
          },
          {
            field: "rowOrder",
            direction: "asc",
            nulls: "first",
          },
          {
            field: "browser",
            direction: "asc",
            nulls: "first",
          },
          {
            field: "dimension",
            direction: "asc",
            nulls: "first",
          },
        ],
      },
      undefined,
      bound.executionInputs,
    );
    return {
      operatingSystem: mapBrowserCrossDimensionRows(
        queryRows.filter((row) => row.crossFamily === "operatingSystem"),
        "os",
      ),
      deviceType: mapBrowserCrossDimensionRows(
        queryRows.filter((row) => row.crossFamily === "deviceType"),
        "device",
      ),
    };
  }
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
      ...((wholeOriginalOwner
        ? [
            {
              owner: wholeOriginalOwner,
              stage: "operatingSystem" as const,
              configuration: {
                browserLimit,
                operatingSystemLimit: osLimit,
                deviceTypeLimit,
              },
            },
          ]
        : []) as [
        NonNullable<Parameters<typeof queryBrowserCrossDimensionFromD1>[8]>?,
      ]),
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
      ...((wholeOriginalOwner
        ? [
            {
              owner: wholeOriginalOwner,
              stage: "deviceType" as const,
              configuration: {
                browserLimit,
                operatingSystemLimit: osLimit,
                deviceTypeLimit,
              },
            },
          ]
        : []) as [
        NonNullable<Parameters<typeof queryBrowserCrossDimensionFromD1>[8]>?,
      ]),
    ),
  ]);

  return {
    operatingSystem,
    deviceType,
  };
}
