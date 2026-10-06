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

function baseSessionPathPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
}) {
  const { builder, pages } = sessionPathSource(input);
  const boundaries = selectedSessionBoundary(builder, pages, input.kind);
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
  result = filterSessionPaths(builder, result, input);
  return { builder, result };
}

export function buildSessionPathTopPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
}): ValidatedLogicalPlan {
  const { builder, result: filtered } = baseSessionPathPlan(input);
  let result = sortedSessionPaths(
    builder,
    filtered,
    input.sortBy,
    input.sortDirection,
  );
  if (input.limit > 0) result = builder.limit(result, input.limit);
  builder.output("session-path-top", result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
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
  const boundaries = selectedSessionPathComparisonBoundary(
    builder,
    pages,
    input.kind,
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
  builder.output("session-path-comparison-rollup", result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

export function buildSessionPathPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: SessionPathCursor | null;
}): ValidatedLogicalPlan {
  const { builder, result: filtered } = baseSessionPathPlan(input);
  let result = filtered;
  if (input.cursor) {
    result = builder.filter(
      result,
      sessionPathCursorPredicate(
        builder,
        result,
        input.cursor,
        input.sortBy,
        input.sortDirection,
      ),
    );
  }
  result = sortedSessionPaths(
    builder,
    result,
    input.sortBy,
    input.sortDirection,
  );
  result = builder.limit(result, input.limit + 1);
  builder.output("session-path-page", result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
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
