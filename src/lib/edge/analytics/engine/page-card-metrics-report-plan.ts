import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const MILLISECONDS = { kind: "scalar", scalar: "number", unit: "ms" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

export type PageCardMetricSort =
  | "views"
  | "visitors"
  | "sessions"
  | "bounceRate"
  | "pagesPerSession"
  | "avgDurationMs";

export interface PageCardMetricsCursor {
  readonly primary: number;
  readonly secondary: number;
  readonly pathname: string;
}

export const PAGE_CARD_METRICS_OUTPUT_ID = "page-card-metrics";
export const PAGE_CARD_METRICS_OUTPUT_FIELDS = [
  "pathname",
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
export const PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID = "page-card-metrics-rollup";
export const PAGE_CARD_METRICS_ROLLUP_OUTPUT_FIELDS = [
  "pathname",
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

export interface PageCardMetricsSourceInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly pathnames?: readonly string[];
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "pathname" | "sessionId" | "visitorId" | "durationMs",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function nonemptyIdentity(
  builder: LogicalPlanBuilder,
  identity: ReturnType<typeof pageAttribute>,
) {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", identity, builder.literal("", STRING)),
        then: identity,
      },
    ],
    builder.literal(null, STRING),
  );
}

function safeDivision(
  builder: LogicalPlanBuilder,
  numerator: ReturnType<typeof pageAttribute>,
  denominator: ReturnType<typeof pageAttribute>,
  zero: typeof RATIO | typeof MILLISECONDS,
) {
  const quotient = builder.arithmetic("divide", numerator, denominator);
  return builder.caseWhen(
    [
      {
        when: builder.compare("lte", denominator, builder.literal(0, NUMBER)),
        then: builder.literal(0, zero),
      },
    ],
    quotient,
  );
}

function cursorOrder(
  builder: LogicalPlanBuilder,
  rows: ReturnType<LogicalPlanBuilder["project"]>,
  input: {
    readonly sort: PageCardMetricSort;
    readonly direction: "asc" | "desc";
    readonly cursor: PageCardMetricsCursor;
  },
) {
  const primaryName = input.sort;
  const secondaryName =
    input.sort === "views" || input.sort === "bounceRate"
      ? "sessions"
      : "views";
  const primary = builder.slot(rows, primaryName);
  const secondary = builder.slot(rows, secondaryName);
  const pathname = builder.slot(rows, "pathname");
  if (primary.type.kind !== "scalar" || secondary.type.kind !== "scalar")
    throw new Error("page_card_metric_cursor_requires_scalar_sort_keys");
  const primaryCursor = builder.literal(input.cursor.primary, primary.type);
  const secondaryCursor = builder.literal(
    input.cursor.secondary,
    secondary.type,
  );
  const equalPrimary = builder.compare("eq", primary, primaryCursor);
  return builder.or(
    builder.compare(
      input.direction === "asc" ? "gt" : "lt",
      primary,
      primaryCursor,
    ),
    builder.and(
      equalPrimary,
      builder.compare(
        input.direction === "asc" ? "gt" : "lt",
        secondary,
        secondaryCursor,
      ),
    ),
    builder.and(
      equalPrimary,
      builder.compare("eq", secondary, secondaryCursor),
      builder.compare(
        "gt",
        pathname,
        builder.literal(input.cursor.pathname, STRING),
      ),
    ),
  );
}

function createPageCardMetricsSource(input: PageCardMetricsSourceInput) {
  return createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    ...(input.preparedTimePolicy
      ? { preparedTimePolicy: input.preparedTimePolicy }
      : {}),
    attributes: [
      "page.report.pathname",
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.durationMs",
    ],
  });
}

/** Appends Page-card rollups to a caller-owned builder and Page relation. */
export function appendPageCardMetricsRollup(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly pathnames?: readonly string[];
}) {
  const { builder, pages } = input;
  const pathname = pageAttribute(builder, pages, "pathname");
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const durationMs = pageAttribute(builder, pages, "durationMs");
  const normalizedPathname = builder.normalizeString(
    builder.coalesce(pathname, builder.literal("", STRING)),
    "trim-ascii-space",
  );
  const pathPredicates = [
    builder.compare("neq", normalizedPathname, builder.literal("", STRING)),
  ];
  if (input.pathnames && input.pathnames.length > 0) {
    pathPredicates.push(
      builder.in(
        normalizedPathname,
        input.pathnames.map((value) => builder.literal(value, STRING)),
      ),
    );
  }
  const selectedPages = builder.filter(
    pages,
    builder.and(
      ...(pathPredicates as [
        (typeof pathPredicates)[number],
        ...(typeof pathPredicates)[number][],
      ]),
    ),
  );
  const durationValid = builder.and(
    builder.isNull(durationMs, true),
    builder.compare("gte", durationMs, builder.literal(0, MILLISECONDS)),
  );
  const validDuration = builder.caseWhen(
    [{ when: durationValid, then: durationMs }],
    builder.literal(0, MILLISECONDS),
  );
  const pathRows = builder.aggregate(selectedPages, { pathname }, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonemptyIdentity(builder, sessionId),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonemptyIdentity(builder, visitorId),
    },
    {
      name: "totalDuration",
      kind: "sum",
      expression: validDuration,
    },
  ]);
  const pathSessions = builder.aggregate(
    builder.filter(
      selectedPages,
      builder.compare("neq", sessionId, builder.literal("", STRING)),
    ),
    { pathname, sessionId },
    [{ name: "visitCount", kind: "count-rows" }],
  );
  const singleVisitPaths = builder.filter(
    pathSessions,
    builder.compare(
      "eq",
      builder.slot(pathSessions, "visitCount"),
      builder.literal(1, NUMBER),
    ),
  );
  const bounceRows = builder.aggregate(
    singleVisitPaths,
    { pathname: builder.slot(singleVisitPaths, "pathname") },
    [{ name: "bounces", kind: "count-rows" }],
  );
  const joined = builder.join(
    pathRows,
    bounceRows,
    [{ left: "pathname", right: "pathname" }],
    "left",
  );
  const bounces = builder.coalesce(
    builder.slot(joined, "right.bounces"),
    builder.literal(0, NUMBER),
  );
  const sessions = builder.slot(joined, "sessions");
  const views = builder.slot(joined, "views");
  const totalDuration = builder.coalesce(
    builder.slot(joined, "totalDuration"),
    builder.literal(0, MILLISECONDS),
  );
  const metrics = builder.project(joined, {
    pathname: builder.slot(joined, "pathname"),
    views,
    sessions,
    visitors: builder.slot(joined, "visitors"),
    bounces,
    totalDuration,
    durationViews: builder.literal(0, NUMBER),
    bounceRate: safeDivision(builder, bounces, sessions, RATIO),
    pagesPerSession: safeDivision(builder, views, sessions, RATIO),
    avgDurationMs: safeDivision(builder, totalDuration, sessions, MILLISECONDS),
  });

  return metrics;
}

/** Appends the legacy metric search, cursor, sort, and limit stages. */
export function appendPageCardMetricsPage(
  builder: LogicalPlanBuilder,
  metrics: LogicalRelationHandle,
  input: {
    readonly limit?: number;
    readonly cursor?: PageCardMetricsCursor | null;
    readonly search?: string;
    readonly sort?: PageCardMetricSort;
    readonly direction?: "asc" | "desc";
  },
): LogicalRelationHandle {
  let rows = metrics;
  if (input.search) {
    rows = builder.filter(
      rows,
      builder.stringMatch(
        "contains",
        builder.slot(rows, "pathname"),
        input.search,
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );
  }
  const sort = input.sort ?? "views";
  const direction = input.direction ?? "desc";
  if (input.cursor)
    rows = builder.filter(
      rows,
      cursorOrder(builder, rows, {
        sort,
        direction,
        cursor: input.cursor,
      }),
    );
  const secondary =
    sort === "views" || sort === "bounceRate" ? "sessions" : "views";
  rows = builder.sort(rows, [
    { slot: sort, direction, nulls: "last" },
    { slot: secondary, direction, nulls: "last" },
    { slot: "pathname", direction: "asc", nulls: "first" },
  ]);
  if (typeof input.limit === "number") {
    if (!Number.isInteger(input.limit))
      throw new Error("logical_builder_invalid_limit");
    if (input.limit >= 0) rows = builder.limit(rows, input.limit);
  }
  return rows;
}

/** Declares the legacy unsorted rollup output on a caller-owned builder. */
export function appendPageCardMetricsRollupOutput(
  builder: LogicalPlanBuilder,
  metrics: LogicalRelationHandle,
  outputId = PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
): void {
  builder.output(
    outputId,
    metrics,
    PAGE_CARD_METRICS_ROLLUP_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );
}

/** Declares the legacy sorted Page-card output on a caller-owned builder. */
export function appendPageCardMetricsPageOutput(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  outputId = PAGE_CARD_METRICS_OUTPUT_ID,
): void {
  builder.output(
    outputId,
    rows,
    PAGE_CARD_METRICS_OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
}

/** Builds complete, unsorted Page-card aggregates for a caller-owned parent. */
export function buildPageCardMetricsRollupPlan(
  input: PageCardMetricsSourceInput,
): ValidatedLogicalPlan {
  const { builder, pages } = createPageCardMetricsSource(input);
  const metrics = appendPageCardMetricsRollup({
    builder,
    pages,
    pathnames: input.pathnames,
  });
  appendPageCardMetricsRollupOutput(builder, metrics);
  return builder.finish();
}

/** Builds the selected-Page grain rollups and the legacy page-card metrics. */
export function buildPageCardMetricsPlan(
  input: PageCardMetricsSourceInput & {
    readonly limit?: number;
    readonly cursor?: PageCardMetricsCursor | null;
    readonly search?: string;
    readonly sort?: PageCardMetricSort;
    readonly direction?: "asc" | "desc";
  },
): ValidatedLogicalPlan {
  const { builder, pages } = createPageCardMetricsSource(input);
  const metrics = appendPageCardMetricsRollup({
    builder,
    pages,
    pathnames: input.pathnames,
  });
  const rows = appendPageCardMetricsPage(builder, metrics, input);
  appendPageCardMetricsPageOutput(builder, rows);
  return builder.finish();
}
