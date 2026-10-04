import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime, SiteId } from "@/lib/edge/analytics/contract/types";
import {
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
  snapshotSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

function sameSelectionValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSelectionValue(value, right[index]))
    );
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameSelectionValue(leftRecord[key], rightRecord[key]),
    )
  );
}

export interface PageAggregateCursor {
  readonly views: number;
  readonly sessions: number;
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
}

export function createPageReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly sourceSelection?: SemanticScopedSourceSelection;
  readonly attributes: readonly string[];
}) {
  const time = semanticTemporalDomainsFromQueryTime(input.queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const selection =
    input.sourceSelection ??
    createSemanticScopedSourceSelection({
      profile: input.scopePlan
        ? "prepared-scoped-v1"
        : "direct-page-analytics-v1",
      filters: input.filters,
      subject,
      time,
      ...(input.scopePlan ? { expectedPlan: input.scopePlan } : {}),
    });
  if (input.sourceSelection) {
    if (input.scopePlan)
      throw new Error(
        "invalid_page_report_source_selection:override_with_prepared_scope_plan",
      );
    if (selection.profile !== "direct-page-session-compat-v1")
      throw new Error(
        "invalid_page_report_source_selection:override_profile_not_allowed",
      );
    const expectedSelection = createSemanticScopedSourceSelection({
      profile: "direct-page-session-compat-v1",
      filters: input.filters,
      subject,
      time,
    });
    const normalizedSelection = snapshotSemanticScopedSourceSelection(
      selection,
      {
        subject,
        time,
        scope: resolveAnalyticsScope(expectedSelection.scope),
        originOperation: "pages",
      },
    );
    if (!sameSelectionValue(normalizedSelection, expectedSelection))
      throw new Error("invalid_page_report_source_selection:override_mismatch");
  }
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(selection.scope),
    originOperation: "pages",
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: input.attributes,
    selection,
  });
  return { builder, pages };
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function pageRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  includeDetails: boolean,
): LogicalRelationHandle {
  const pathname = pageAttribute(builder, pages, "pathname");
  const query = includeDetails
    ? pageAttribute(builder, pages, "queryString")
    : builder.literal("", STRING);
  const hash = includeDetails
    ? pageAttribute(builder, pages, "hash")
    : builder.literal("", STRING);
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const nonemptySession = builder.compare(
    "neq",
    sessionId,
    builder.literal("", STRING),
  );
  const distinctSession = builder.caseWhen(
    [{ when: nonemptySession, then: sessionId }],
    builder.literal(null, STRING),
  );
  return builder.aggregate(pages, { pathname, query, hash }, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: distinctSession,
    },
  ]);
}

function finishPageOutput(
  builder: LogicalPlanBuilder,
  id: string,
  relation: LogicalRelationHandle,
): ValidatedLogicalPlan {
  builder.output(id, relation, [
    { name: "pathname", slot: "pathname" },
    { name: "queryValue", slot: "query" },
    { name: "hashValue", slot: "hash" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
  ]);
  return builder.finish();
}

/** Builds the shared typed Page report Source and exact legacy Top-N rollup. */
export function buildTopPagesPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly includeDetails: boolean;
}): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    ...input,
    attributes: [
      "page.report.pathname",
      "page.report.sessionId",
      ...(input.includeDetails
        ? ["page.report.queryString", "page.report.hash"]
        : []),
    ],
  });
  const rolled = pageRollup(builder, pages, input.includeDetails);
  const sorted = builder.sort(rolled, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "pathname", direction: "asc", nulls: "first" },
  ]);
  // SQLite's legacy LIMIT accepts negative integers as unbounded. Keep that
  // behavior by omitting the Limit node instead of clamping or widening it.
  const limited =
    Number.isInteger(input.limit) && input.limit < 0
      ? sorted
      : builder.limit(sorted, input.limit);
  return finishPageOutput(builder, "top-pages", limited);
}

function cursorPredicate(
  builder: LogicalPlanBuilder,
  rolled: LogicalRelationHandle,
  cursor: PageAggregateCursor,
): ReturnType<LogicalPlanBuilder["or"]> {
  const views = builder.slot(rolled, "views");
  const sessions = builder.slot(rolled, "sessions");
  const pathname = builder.slot(rolled, "pathname");
  const query = builder.slot(rolled, "query");
  const hash = builder.slot(rolled, "hash");
  const number = (value: number) => builder.literal(value, NUMBER);
  const string = (value: string) => builder.literal(value, STRING);
  const viewsEqual = () => builder.compare("eq", views, number(cursor.views));
  const sessionsEqual = () =>
    builder.compare("eq", sessions, number(cursor.sessions));
  const pathnameEqual = () =>
    builder.compare("eq", pathname, string(cursor.pathname));
  const queryEqual = () => builder.compare("eq", query, string(cursor.query));
  return builder.or(
    builder.compare("lt", views, number(cursor.views)),
    builder.and(
      viewsEqual(),
      builder.compare("lt", sessions, number(cursor.sessions)),
    ),
    builder.and(
      viewsEqual(),
      sessionsEqual(),
      builder.compare("gt", pathname, string(cursor.pathname)),
    ),
    builder.and(
      viewsEqual(),
      sessionsEqual(),
      pathnameEqual(),
      builder.compare("gt", query, string(cursor.query)),
    ),
    builder.and(
      viewsEqual(),
      sessionsEqual(),
      pathnameEqual(),
      queryEqual(),
      builder.compare("gt", hash, string(cursor.hash)),
    ),
  );
}

/** Builds the full keyset predicate, legacy sort and limit+1 Page query. */
export function buildPaginatedPageRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  input: {
    readonly limit: number;
    readonly includeDetails: boolean;
    readonly cursor?: PageAggregateCursor | null;
  },
): LogicalRelationHandle {
  let rolled = pageRollup(builder, pages, input.includeDetails);
  if (input.cursor)
    rolled = builder.filter(
      rolled,
      cursorPredicate(builder, rolled, input.cursor),
    );
  const sorted = builder.sort(rolled, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "pathname", direction: "asc", nulls: "first" },
    { slot: "query", direction: "asc", nulls: "first" },
    { slot: "hash", direction: "asc", nulls: "first" },
  ]);
  return builder.limit(sorted, input.limit + 1);
}

export function buildPagesPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor?: PageAggregateCursor | null;
}): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    ...input,
    attributes: [
      "page.report.pathname",
      "page.report.sessionId",
      ...(input.includeDetails
        ? ["page.report.queryString", "page.report.hash"]
        : []),
    ],
  });
  return finishPageOutput(
    builder,
    "pages-page",
    buildPaginatedPageRows(builder, pages, input),
  );
}
