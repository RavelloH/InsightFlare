import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import type { QueryTime, SiteId } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  aggregateSessionBoundaries,
  selectedSessionBoundary,
  selectedSessionPathComparisonBoundary,
} from "@/lib/edge/analytics/engine/session-boundary-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export type SessionPathKind = "entry" | "exit";
export type SessionPathSortKey = "views" | "sessions" | "visitors";
export const SESSION_PATH_TOP_REPORT_OUTPUT = "session-path-top";
export const SESSION_PATH_PAGE_REPORT_OUTPUT = "session-path-page";
export const SESSION_PATH_COMPARISON_ROLLUP_OUTPUT =
  "session-path-comparison-rollup";

export interface NormalizedSessionBoundaryDimensionRequest {
  readonly dimension: "session.entryPath" | "session.exitPath";
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}

export function normalizeSessionBoundaryDimensionRequest(input: {
  readonly mode?: unknown;
  readonly dimension: string;
  readonly page?: unknown;
  readonly limit?: unknown;
  readonly search?: unknown;
  readonly sort?: unknown;
  readonly audience: QueryAudience;
}): NormalizedSessionBoundaryDimensionRequest | null {
  if (input.mode === "overview-tab") return null;
  const kind =
    input.dimension === "session.entryPath"
      ? "entry"
      : input.dimension === "session.exitPath"
        ? "exit"
        : null;
  if (!kind) return null;
  const page =
    input.page && typeof input.page === "object"
      ? (input.page as { limit?: unknown })
      : {};
  const sort =
    input.sort && typeof input.sort === "object"
      ? (input.sort as { key?: unknown; direction?: unknown })
      : null;
  const limit =
    typeof page.limit === "number" && Number.isFinite(page.limit)
      ? page.limit
      : typeof input.limit === "number" && Number.isFinite(input.limit)
        ? input.limit
        : 20;
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  const dimension = kind === "entry" ? "session.entryPath" : "session.exitPath";
  return Object.freeze({
    dimension,
    kind,
    limit,
    ...(typeof input.search === "string" ? { search: input.search } : {}),
    sortBy:
      sort?.key === "sessions" || sort?.key === "visitors" ? sort.key : "views",
    sortDirection: sort?.direction === "asc" ? "asc" : "desc",
    audience: input.audience,
  });
}

export interface SessionPathCursor {
  readonly views: number;
  readonly value: string;
  readonly visitors?: number;
}

function sessionPathSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
}) {
  const metadata = scopedFilterMetadata(input.filters);
  const sourceSelection =
    !metadata && input.filters.root !== null
      ? createSemanticScopedSourceSelection({
          profile: "direct-page-session-compat-v1",
          filters: input.filters,
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [input.siteId as SiteId],
          }),
          time: semanticTemporalDomainsFromQueryTime(input.queryTime),
        })
      : undefined;
  return createPageReportSource({
    ...input,
    ...(sourceSelection ? { sourceSelection } : {}),
    attributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.localId",
      "page.report.pathname",
    ],
  });
}

function filterSessionPaths(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  options: { readonly search?: string },
): LogicalRelationHandle {
  let result = input;
  if (options.search) {
    result = builder.filter(
      result,
      builder.stringMatch(
        "contains",
        builder.slot(result, "value"),
        options.search.trim().toLowerCase(),
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );
  }
  return result;
}

function sortedSessionPaths(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  sortBy: SessionPathSortKey,
  sortDirection: "asc" | "desc",
): LogicalRelationHandle {
  const keys: Array<{
    slot: string;
    direction: "asc" | "desc";
    nulls: "first" | "last";
  }> =
    sortBy === "visitors"
      ? [
          { slot: "visitors", direction: sortDirection, nulls: "last" },
          { slot: "views", direction: sortDirection, nulls: "last" },
          { slot: "value", direction: "asc", nulls: "first" },
        ]
      : [
          { slot: sortBy, direction: sortDirection, nulls: "last" },
          { slot: "value", direction: "asc", nulls: "first" },
        ];
  return builder.sort(input, keys);
}

function sessionPathCursorPredicate(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  cursor: SessionPathCursor,
  sortBy: SessionPathSortKey,
  direction: "asc" | "desc",
): LogicalExpressionHandle {
  const operator = direction === "asc" ? "gt" : "lt";
  const value = builder.slot(input, "value");
  const valueCursor = builder.literal(cursor.value, STRING);
  if (sortBy !== "visitors") {
    const primary = builder.slot(input, sortBy);
    const primaryCursor = builder.literal(cursor.views, NUMBER);
    return builder.or(
      builder.compare(operator, primary, primaryCursor),
      builder.and(
        builder.compare("eq", primary, primaryCursor),
        builder.compare("gt", value, valueCursor),
      ),
    );
  }
  const primary = builder.slot(input, "visitors");
  const secondary = builder.slot(input, "views");
  const primaryCursor = builder.literal(
    cursor.visitors ?? cursor.views,
    NUMBER,
  );
  const secondaryCursor = builder.literal(cursor.views, NUMBER);
  const primaryEqual = () => builder.compare("eq", primary, primaryCursor);
  const secondaryEqual = () =>
    builder.compare("eq", secondary, secondaryCursor);
  return builder.or(
    builder.compare(operator, primary, primaryCursor),
    builder.and(
      primaryEqual(),
      builder.compare(operator, secondary, secondaryCursor),
    ),
    builder.and(
      primaryEqual(),
      secondaryEqual(),
      builder.compare("gt", value, valueCursor),
    ),
  );
}

function appendSessionPathAggregate(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: {
    readonly kind: SessionPathKind;
    readonly search?: string;
  },
): LogicalRelationHandle {
  const boundaries = selectedSessionBoundary(builder, pages, options.kind);
  let result = aggregateSessionBoundaries(builder, boundaries);
  result = builder.filter(
    result,
    builder.compare(
      "neq",
      builder.normalizeString(
        builder.slot(result, "value"),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    ),
  );
  return filterSessionPaths(builder, result, options);
}

export function appendSessionPathTopReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: {
    readonly limit: number;
    readonly kind: SessionPathKind;
    readonly search?: string;
    readonly sortBy: SessionPathSortKey;
    readonly sortDirection: "asc" | "desc";
  },
): void {
  let result = appendSessionPathAggregate(builder, pages, options);
  result = sortedSessionPaths(
    builder,
    result,
    options.sortBy,
    options.sortDirection,
  );
  if (options.limit > 0) result = builder.limit(result, options.limit);
  builder.output(SESSION_PATH_TOP_REPORT_OUTPUT, result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

export function buildSessionPathTopPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
}): ValidatedLogicalPlan {
  const { builder, pages } = sessionPathSource(input);
  appendSessionPathTopReport(builder, pages, input);
  return builder.finish();
}

/** Builds an unsorted, unpaged Session edge rollup for cross-period composition. */
export function buildSessionPathComparisonRollupPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly kind: SessionPathKind;
}): ValidatedLogicalPlan {
  const { builder, pages } = sessionPathSource(input);
  appendSessionPathComparisonRollup(builder, pages, input.kind);
  return builder.finish();
}

/** Appends the unpaged Session edge rollup shared by native and qualified comparisons. */
export function appendSessionPathComparisonRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  kind: SessionPathKind,
  outputId = SESSION_PATH_COMPARISON_ROLLUP_OUTPUT,
): void {
  const boundaries = selectedSessionPathComparisonBoundary(
    builder,
    pages,
    kind,
  );
  let result = aggregateSessionBoundaries(builder, boundaries);
  result = builder.filter(
    result,
    builder.compare(
      "neq",
      builder.normalizeString(
        builder.slot(result, "value"),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    ),
  );
  builder.output(outputId, result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

export function buildSessionPathPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: SessionPathCursor | null;
}): ValidatedLogicalPlan {
  const { builder, pages } = sessionPathSource(input);
  appendSessionPathPageReport(builder, pages, input);
  return builder.finish();
}

export function appendSessionPathPageReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: {
    readonly limit: number;
    readonly kind: SessionPathKind;
    readonly search?: string;
    readonly sortBy: SessionPathSortKey;
    readonly sortDirection: "asc" | "desc";
    readonly cursor?: SessionPathCursor | null;
  },
): void {
  let result = appendSessionPathAggregate(builder, pages, options);
  if (options.cursor) {
    result = builder.filter(
      result,
      sessionPathCursorPredicate(
        builder,
        result,
        options.cursor,
        options.sortBy,
        options.sortDirection,
      ),
    );
  }
  result = sortedSessionPaths(
    builder,
    result,
    options.sortBy,
    options.sortDirection,
  );
  result = builder.limit(result, options.limit + 1);
  builder.output(SESSION_PATH_PAGE_REPORT_OUTPUT, result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

export function sessionPathCursorBinding(input: {
  readonly operation: "entry" | "exit";
  readonly siteId: string;
  readonly window: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
    readonly timeZone: string;
    readonly paginationBinding?: string;
  };
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly audience: QueryAudience;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
}): readonly unknown[] {
  return [
    `analytics-session-${input.operation}-v1`,
    input.siteId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    effectiveScopeForPagination(input.filters),
    input.search?.trim().toLowerCase() ?? "",
    input.audience,
    input.sortBy,
    input.sortDirection,
  ];
}
