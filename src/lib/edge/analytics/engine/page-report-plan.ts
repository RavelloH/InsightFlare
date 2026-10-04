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
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

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
  const builder = new LogicalPlanBuilder({
    subject: selection.subject,
    time: selection.time,
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
  return finishPageOutput(
    builder,
    "pages-page",
    builder.limit(sorted, input.limit + 1),
  );
}
