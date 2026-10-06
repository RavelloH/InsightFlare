import type {
  FilterDocument,
  OverviewTableMetric,
  OverviewTableSortBy,
  QueryAudience,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  queryWindowToTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  dimensionRollup,
  pageDimensionReportSource,
  selectedPageDimension,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildSessionPathComparisonRollupPlan } from "@/lib/edge/analytics/engine/session-path-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type { DimensionRow, QueryWindow } from "./core-types";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

export interface ComparisonDimensionCursor {
  readonly sortClass: number;
  readonly primary: number;
  readonly secondary: number;
  readonly key: string;
}

function decodeComparisonCursor(
  value: unknown,
): ComparisonDimensionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "sortClass",
    "primary",
    "secondary",
    "key",
  ]) &&
    typeof candidate.sortClass === "number" &&
    Number.isFinite(candidate.sortClass) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.key === "string"
    ? (candidate as unknown as ComparisonDimensionCursor)
    : null;
}

function comparisonDimensionPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly selection: PageDimensionSelection;
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const selection = validatePageDimensionSelection(input.selection);
  const { builder, pages } = pageDimensionReportSource({
    siteId: input.siteId,
    queryTime: queryWindowToTime(input.window),
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    selections: [selection],
  });
  const rows = dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, selection),
  );
  builder.output("comparison-dimension-rollup", rows, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

function comparisonSessionPathPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly kind: "entry" | "exit";
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  return buildSessionPathComparisonRollupPlan({
    siteId: input.siteId,
    queryTime: queryWindowToTime(input.window),
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    kind: input.kind,
  });
}

function mapComparisonRows(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => {
    const number = (name: string) => Number(row[name] ?? 0);
    const currentViews = number("currentViews");
    const currentSessions = number("currentSessions");
    const currentVisitors = number("currentVisitors");
    const referenceViews = number("referenceViews");
    const referenceSessions = number("referenceSessions");
    const referenceVisitors = number("referenceVisitors");
    const delta = (a: number, b: number) => ({
      absolute: a - b,
      relative: b === 0 ? (a === 0 ? 0 : null) : (a - b) / b,
    });
    const key = String(row.key ?? "");
    return {
      key,
      value: key,
      views: currentViews,
      sessions: currentSessions,
      visitors: currentVisitors,
      reference: {
        views: referenceViews,
        sessions: referenceSessions,
        visitors: referenceVisitors,
      },
      change: {
        views: delta(currentViews, referenceViews),
        sessions: delta(currentSessions, referenceSessions),
        visitors: delta(currentVisitors, referenceVisitors),
      },
    };
  });
}

function metricField(
  metric: OverviewTableMetric,
  side: "current" | "reference",
) {
  return `${side}${metric[0]!.toUpperCase()}${metric.slice(1)}`;
}

function comparisonRelative(
  builder: LogicalPlanBuilder,
  current: ReturnType<LogicalPlanBuilder["slot"]>,
  reference: ReturnType<LogicalPlanBuilder["slot"]>,
) {
  const zero = builder.literal(0, NUMBER);
  const noReference = builder.compare("eq", reference, zero);
  const noCurrent = builder.compare("eq", current, zero);
  const zeroChange = builder.literal(0, RATIO);
  const nullChange = builder.literal(null, RATIO);
  const denominatorNonzero = builder.arithmetic("subtract", current, reference);
  return builder.caseWhen(
    [
      {
        when: noReference,
        then: builder.caseWhen(
          [{ when: noCurrent, then: zeroChange }],
          nullChange,
        ),
      },
    ],
    builder.arithmetic("divide", denominatorNonzero, reference),
  );
}

function comparisonPagePlan(input: {
  readonly current: ValidatedLogicalPlan;
  readonly reference: ValidatedLogicalPlan;
  readonly metric: OverviewTableMetric;
  readonly sortBy: OverviewTableSortBy;
  readonly direction: SortDirection;
  readonly search?: string;
  readonly cursor: ComparisonDimensionCursor | null;
  readonly limit: number;
  readonly childOutputId: string;
}): ValidatedLogicalPlan {
  const builder = new LogicalPlanBuilder(input.current.context);
  const importSide = (plan: ValidatedLogicalPlan) =>
    builder.importAnalysisResult(plan, input.childOutputId, [
      { field: "value", as: "key" },
      { field: "views" },
      { field: "sessions" },
      { field: "visitors" },
    ]);
  const current = importSide(input.current);
  const reference = importSide(input.reference);
  const currentKey = builder.project(current, {
    key: builder.slot(current, "key"),
  });
  const referenceKey = builder.project(reference, {
    key: builder.slot(reference, "key"),
  });
  const keyRows = builder.appendRows([currentKey, referenceKey], ["key"]);
  const keys = builder.aggregate(
    keyRows,
    { key: builder.slot(keyRows, "key") },
    [],
  );
  const currentJoin = builder.join(
    keys,
    current,
    [{ left: "key", right: "key" }],
    "left",
  );
  const zero = builder.literal(0, NUMBER);
  const currentMeasures = builder.project(currentJoin, {
    key: builder.slot(currentJoin, "key"),
    currentViews: builder.coalesce(
      builder.slot(currentJoin, "right.views"),
      zero,
    ),
    currentSessions: builder.coalesce(
      builder.slot(currentJoin, "right.sessions"),
      zero,
    ),
    currentVisitors: builder.coalesce(
      builder.slot(currentJoin, "right.visitors"),
      zero,
    ),
  });
  const referenceJoin = builder.join(
    currentMeasures,
    reference,
    [{ left: "key", right: "key" }],
    "left",
  );
  const measures = builder.project(referenceJoin, {
    key: builder.slot(referenceJoin, "key"),
    currentViews: builder.slot(referenceJoin, "currentViews"),
    currentSessions: builder.slot(referenceJoin, "currentSessions"),
    currentVisitors: builder.slot(referenceJoin, "currentVisitors"),
    referenceViews: builder.coalesce(
      builder.slot(referenceJoin, "right.views"),
      zero,
    ),
    referenceSessions: builder.coalesce(
      builder.slot(referenceJoin, "right.sessions"),
      zero,
    ),
    referenceVisitors: builder.coalesce(
      builder.slot(referenceJoin, "right.visitors"),
      zero,
    ),
  });
  const currentMetric = builder.slot(
    measures,
    metricField(input.metric, "current"),
  );
  const referenceMetric = builder.slot(
    measures,
    metricField(input.metric, "reference"),
  );
  const noReference = builder.compare("eq", referenceMetric, zero);
  const positiveCurrent = builder.compare("gt", currentMetric, zero);
  const changeClass = builder.caseWhen(
    [
      {
        when: builder.and(noReference, positiveCurrent),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  let result = builder.project(measures, {
    key: builder.slot(measures, "key"),
    currentViews: builder.slot(measures, "currentViews"),
    currentSessions: builder.slot(measures, "currentSessions"),
    currentVisitors: builder.slot(measures, "currentVisitors"),
    referenceViews: builder.slot(measures, "referenceViews"),
    referenceSessions: builder.slot(measures, "referenceSessions"),
    referenceVisitors: builder.slot(measures, "referenceVisitors"),
    changeRelative: comparisonRelative(builder, currentMetric, referenceMetric),
    changeClass,
  });
  result = builder.filter(
    result,
    builder.compare(
      "neq",
      builder.slot(result, "key"),
      builder.literal("", STRING),
    ),
  );
  const search = input.search?.trim();
  if (search) {
    result = builder.filter(
      result,
      builder.stringMatch(
        "contains",
        builder.slot(result, "key"),
        search.toLowerCase(),
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );
  }
  if (input.cursor) {
    const cursor = input.cursor;
    const key = builder.slot(result, "key");
    if (input.sortBy === "change") {
      const classValue = builder.slot(result, "changeClass");
      const relative = builder.slot(result, "changeRelative");
      const operator = input.direction === "asc" ? "gt" : "lt";
      result = builder.filter(
        result,
        builder.or(
          builder.compare(
            operator,
            classValue,
            builder.literal(cursor.sortClass, NUMBER),
          ),
          builder.and(
            builder.compare(
              "eq",
              classValue,
              builder.literal(cursor.sortClass, NUMBER),
            ),
            builder.or(
              builder.compare(
                operator,
                relative,
                builder.literal(cursor.primary, RATIO),
              ),
              builder.and(
                builder.compare(
                  "eq",
                  relative,
                  builder.literal(cursor.primary, RATIO),
                ),
                builder.compare("gt", key, builder.literal(cursor.key, STRING)),
              ),
            ),
          ),
        ),
      );
    } else {
      const primaryField = metricField(
        input.metric,
        input.sortBy === "reference" ? "reference" : "current",
      );
      const secondaryField = metricField(
        input.metric,
        input.sortBy === "reference" ? "current" : "reference",
      );
      const primary = builder.slot(result, primaryField);
      const secondary = builder.slot(result, secondaryField);
      const operator = input.direction === "asc" ? "gt" : "lt";
      result = builder.filter(
        result,
        builder.or(
          builder.compare(
            operator,
            primary,
            builder.literal(cursor.primary, NUMBER),
          ),
          builder.and(
            builder.compare(
              "eq",
              primary,
              builder.literal(cursor.primary, NUMBER),
            ),
            builder.compare(
              operator,
              secondary,
              builder.literal(cursor.secondary, NUMBER),
            ),
          ),
          builder.and(
            builder.compare(
              "eq",
              primary,
              builder.literal(cursor.primary, NUMBER),
            ),
            builder.compare(
              "eq",
              secondary,
              builder.literal(cursor.secondary, NUMBER),
            ),
            builder.compare("gt", key, builder.literal(cursor.key, STRING)),
          ),
        ),
      );
    }
  }
  const order =
    input.sortBy === "change"
      ? [
          {
            slot: "changeClass",
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: "changeRelative",
            direction: input.direction,
            nulls:
              input.direction === "asc"
                ? ("first" as const)
                : ("last" as const),
          },
          { slot: "key", direction: "asc" as const, nulls: "first" as const },
        ]
      : [
          {
            slot: metricField(input.metric, input.sortBy),
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: metricField(
              input.metric,
              input.sortBy === "reference" ? "current" : "reference",
            ),
            direction: input.direction,
            nulls: "last" as const,
          },
          { slot: "key", direction: "asc" as const, nulls: "first" as const },
        ];
  result = builder.sort(result, order);
  result = builder.limit(result, input.limit + 1);
  builder.output("comparison-page", result, [
    { name: "key", slot: "key" },
    { name: "currentViews", slot: "currentViews" },
    { name: "currentSessions", slot: "currentSessions" },
    { name: "currentVisitors", slot: "currentVisitors" },
    { name: "referenceViews", slot: "referenceViews" },
    { name: "referenceSessions", slot: "referenceSessions" },
    { name: "referenceVisitors", slot: "referenceVisitors" },
  ]);
  return builder.finish();
}

function comparisonCursorBinding(
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<string> {
  return paginationBindingForWindow(current, [
    "analytics-overview-table-comparison-v1",
    audience,
    siteId,
    current.startMs,
    current.endExclusiveMs,
    current.timeZone,
    reference.startMs,
    reference.endExclusiveMs,
    reference.timeZone,
    filterFingerprint(currentFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(currentFilters),
    filterFingerprint(referenceFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(referenceFilters),
    selectExpr,
    search?.trim().toLowerCase() ?? "",
    metric,
    sortBy,
    direction,
  ]);
}

export async function decodeComparisonDimensionCursor(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  cursor: string | null | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<ComparisonDimensionCursor | null> {
  return decodePageCursor(
    env,
    await comparisonCursorBinding(
      siteId,
      current,
      currentFilters,
      reference,
      referenceFilters,
      selectExpr,
      search,
      audience,
      metric,
      sortBy,
      direction,
    ),
    cursor,
    "overview-table-comparison",
    decodeComparisonCursor,
  );
}

export async function queryComparisonDimensionPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  selectExpr: string,
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
    selection: PageDimensionSelection;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<{
  readonly items: readonly (DimensionRow & {
    readonly key: string;
    readonly reference: {
      readonly views: number;
      readonly sessions: number;
      readonly visitors: number;
    };
    readonly change: {
      readonly views: {
        readonly absolute: number;
        readonly relative: number | null;
      };
      readonly sessions: {
        readonly absolute: number;
        readonly relative: number | null;
      };
      readonly visitors: {
        readonly absolute: number;
        readonly relative: number | null;
      };
    };
  })[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}> {
  const currentPlan = comparisonDimensionPlan({
    siteId,
    window: current,
    filters: currentFilters,
    selection: options.selection,
  });
  const referencePlan = comparisonDimensionPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    selection: options.selection,
  });
  const plan = comparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    childOutputId: "comparison-dimension-rollup",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
  );
  const page = pageResult(mapComparisonRows(rows), limit);
  const binding = await comparisonCursorBinding(
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr,
    options.search,
    audience,
    options.metric,
    options.sortBy,
    options.direction,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          sortClass:
            options.sortBy === "change"
              ? page.last.reference[options.metric] === 0 &&
                page.last[options.metric] > 0
                ? 1
                : 0
              : 0,
          primary:
            options.sortBy === "reference"
              ? page.last.reference[options.metric]
              : options.sortBy === "change"
                ? (page.last.change[options.metric].relative ?? 0)
                : page.last[options.metric],
          secondary:
            options.sortBy === "current"
              ? page.last.reference[options.metric]
              : options.sortBy === "reference"
                ? page.last[options.metric]
                : 0,
          key: page.last.key,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

/** Comparison variant for session entry/exit, where each session contributes
 * only its first/last page rather than every page view. */
export async function queryComparisonSessionPathPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<Awaited<ReturnType<typeof queryComparisonDimensionPageFromD1>>> {
  const currentPlan = comparisonSessionPathPlan({
    siteId,
    window: current,
    filters: currentFilters,
    kind,
  });
  const referencePlan = comparisonSessionPathPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    kind,
  });
  const plan = comparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    childOutputId: "session-path-comparison-rollup",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
  );
  const page = pageResult(mapComparisonRows(rows), limit);
  const binding = await comparisonCursorBinding(
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    `session.${kind}`,
    options.search,
    audience,
    options.metric,
    options.sortBy,
    options.direction,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          sortClass:
            options.sortBy === "change"
              ? page.last.reference[options.metric] === 0 &&
                page.last[options.metric] > 0
                ? 1
                : 0
              : 0,
          primary:
            options.sortBy === "reference"
              ? page.last.reference[options.metric]
              : options.sortBy === "change"
                ? (page.last.change[options.metric].relative ?? 0)
                : page.last[options.metric],
          secondary:
            options.sortBy === "current"
              ? page.last.reference[options.metric]
              : options.sortBy === "reference"
                ? page.last[options.metric]
                : 0,
          key: page.last.key,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}
