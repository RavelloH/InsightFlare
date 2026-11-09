import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryAudience } from "@/lib/edge/analytics/contract/types";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
export type ReferrerPageSortKey = "views" | "visitors";
export type ReferrerOverviewTab = "source.domain" | "source.link";
export const REFERRERS_PAGE_REPORT_OUTPUT = "referrers-page";

export interface NormalizedReferrerOverviewTableRequest {
  readonly mode: "overview-tab";
  readonly tab: ReferrerOverviewTab;
  readonly includeFullUrl: boolean;
  readonly limit: number;
  readonly cursorText: string | null;
  readonly sortBy: ReferrerPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly search?: string;
}

export interface DeferredReferrerOverviewTableRequest extends NormalizedReferrerOverviewTableRequest {
  readonly audience: QueryAudience;
}

/** Normalizes only the two single-period overview tabs owned by Referrers. */
export function normalizeReferrerOverviewTableRequest(input: {
  readonly mode?: unknown;
  readonly tab?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly search?: unknown;
}): NormalizedReferrerOverviewTableRequest | null {
  if (
    input.mode !== "overview-tab" ||
    (input.tab !== "source.domain" && input.tab !== "source.link")
  )
    return null;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? input.limit
      : 100;
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  const rawCursor = typeof input.cursor === "string" ? input.cursor : "";
  const rawSearch = typeof input.search === "string" ? input.search : "";
  return {
    mode: "overview-tab",
    tab: input.tab,
    includeFullUrl: input.tab === "source.link",
    limit,
    cursorText: rawCursor || null,
    sortBy: input.sort === "visitors" ? "visitors" : "views",
    sortDirection: input.direction === "asc" ? "asc" : "desc",
    ...(rawSearch ? { search: rawSearch } : {}),
  };
}

export interface ReferrerAggregateCursor {
  readonly primary: number;
  readonly secondary: number;
  readonly referrer: string;
}

export function appendReferrersPageReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  input: {
    readonly limit: number;
    readonly includeFullUrl: boolean;
    readonly search?: string;
    readonly sortBy: ReferrerPageSortKey;
    readonly sortDirection: "asc" | "desc";
    readonly cursor?: ReferrerAggregateCursor | null;
  },
): void {
  let rolled = referrerRollup(
    builder,
    pages,
    selectedReferrer(builder, pages, input.includeFullUrl),
  );
  rolled = applySearch(builder, rolled, input.search);
  if (input.cursor)
    rolled = builder.filter(
      rolled,
      cursorPredicate(
        builder,
        rolled,
        input.cursor,
        input.sortBy,
        input.sortDirection,
      ),
    );
  const sorted = sortedReferrers(
    builder,
    rolled,
    input.sortBy,
    input.sortDirection,
  );
  builder.output(
    REFERRERS_PAGE_REPORT_OUTPUT,
    builder.limit(sorted, input.limit + 1),
    [
      { name: "referrer", slot: "referrer" },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ],
  );
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "referrerHost" | "referrerUrl" | "sessionId" | "visitorId",
): LogicalExpressionHandle {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function selectedReferrer(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  includeFullUrl: boolean,
): LogicalExpressionHandle {
  return builder.coalesce(
    pageAttribute(
      builder,
      pages,
      includeFullUrl ? "referrerUrl" : "referrerHost",
    ),
    builder.literal("", STRING),
  );
}

function referrerRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  referrer: LogicalExpressionHandle,
): LogicalRelationHandle {
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const distinctIfNonempty = (value: LogicalExpressionHandle) =>
    builder.caseWhen(
      [
        {
          when: builder.compare("neq", value, builder.literal("", STRING)),
          then: value,
        },
      ],
      builder.literal(null, STRING),
    );
  return builder.aggregate(pages, { referrer }, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: distinctIfNonempty(sessionId),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: distinctIfNonempty(visitorId),
    },
  ]);
}

function applySearch(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  search: string | undefined,
): LogicalRelationHandle {
  if (!search) return input;
  const referrer = builder.slot(input, "referrer");
  return builder.filter(
    input,
    builder.stringMatch(
      "contains",
      referrer,
      search.trim().toLowerCase(),
      false,
      undefined,
      "legacy-report-search-v1",
    ),
  );
}

function sortedReferrers(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  sortBy: ReferrerPageSortKey,
  sortDirection: "asc" | "desc",
): LogicalRelationHandle {
  const primary = sortBy === "visitors" ? "visitors" : "views";
  const secondary = sortBy === "visitors" ? "views" : "sessions";
  return builder.sort(input, [
    { slot: primary, direction: sortDirection, nulls: "last" },
    { slot: secondary, direction: sortDirection, nulls: "last" },
    { slot: "referrer", direction: "asc", nulls: "first" },
  ]);
}

function cursorPredicate(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  cursor: ReferrerAggregateCursor,
  sortBy: ReferrerPageSortKey,
  sortDirection: "asc" | "desc",
) {
  const primarySlot = sortBy === "visitors" ? "visitors" : "views";
  const secondarySlot = sortBy === "visitors" ? "views" : "sessions";
  const primary = builder.slot(input, primarySlot);
  const secondary = builder.slot(input, secondarySlot);
  const referrer = builder.slot(input, "referrer");
  const number = (value: number) => builder.literal(value, NUMBER);
  const string = (value: string) => builder.literal(value, STRING);
  const primaryEqual = () =>
    builder.compare("eq", primary, number(cursor.primary));
  const secondaryEqual = () =>
    builder.compare("eq", secondary, number(cursor.secondary));
  const direction = sortDirection === "asc" ? "gt" : "lt";
  return builder.or(
    builder.compare(direction, primary, number(cursor.primary)),
    builder.and(
      primaryEqual(),
      builder.compare(direction, secondary, number(cursor.secondary)),
    ),
    builder.and(
      primaryEqual(),
      secondaryEqual(),
      builder.compare("gt", referrer, string(cursor.referrer)),
    ),
  );
}

export function buildTopReferrersPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
}): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    ...input,
    attributes: [
      input.includeFullUrl
        ? "page.report.referrerUrl"
        : "page.report.referrerHost",
      "page.report.sessionId",
      "page.report.visitorId",
    ],
  });
  let rolled = referrerRollup(
    builder,
    pages,
    selectedReferrer(builder, pages, input.includeFullUrl),
  );
  rolled = applySearch(builder, rolled, input.search);
  const sorted = builder.sort(rolled, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "referrer", direction: "asc", nulls: "first" },
  ]);
  const limited =
    Number.isInteger(input.limit) && input.limit < 0
      ? sorted
      : builder.limit(sorted, input.limit);
  builder.output("referrers-top", limited, [
    { name: "referrer", slot: "referrer" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

export function buildReferrersPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly sortBy: ReferrerPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: ReferrerAggregateCursor | null;
}): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    ...input,
    attributes: [
      input.includeFullUrl
        ? "page.report.referrerUrl"
        : "page.report.referrerHost",
      "page.report.sessionId",
      "page.report.visitorId",
    ],
  });
  appendReferrersPageReport(builder, pages, input);
  return builder.finish();
}

function summaryDistinctKey(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", value, builder.literal("", STRING)),
        then: value,
      },
    ],
    builder.literal(null, STRING),
  );
}

function summaryTotal(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
  direct: boolean,
): LogicalExpressionHandle {
  const isDirect = builder.compare("eq", value, builder.literal("", STRING));
  const indicator = direct ? isDirect : builder.not(isDirect);
  return builder.caseWhen(
    [{ when: indicator, then: builder.literal(1, NUMBER) }],
    builder.literal(0, NUMBER),
  );
}

export function buildReferrerSummaryPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly topN: number;
}): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    ...input,
    attributes: ["page.report.referrerHost", "page.report.referrerUrl"],
  });
  appendReferrerSummaryReport(builder, pages, { topN: input.topN });
  return builder.finish();
}

/** Appends the real Referrers summary outputs to an existing Page source. */
export function appendReferrerSummaryReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: { readonly topN: number },
): void {
  const rawHost = selectedReferrer(builder, pages, false);
  const rawUrl = selectedReferrer(builder, pages, true);
  const normalizedHost = builder.normalizeString(rawHost, "trim-ascii-space");
  const normalizedUrl = builder.normalizeString(rawUrl, "trim-ascii-space");

  const summaryAggregate = builder.aggregate(pages, {}, [
    { name: "totalViews", kind: "count-rows" },
    {
      name: "directViews",
      kind: "sum",
      expression: summaryTotal(builder, normalizedHost, true),
    },
    {
      name: "externalViews",
      kind: "sum",
      expression: summaryTotal(builder, normalizedHost, false),
    },
    {
      name: "uniqueDomains",
      kind: "count-distinct",
      expression: summaryDistinctKey(builder, normalizedHost),
    },
    {
      name: "uniqueLinks",
      kind: "count-distinct",
      expression: summaryDistinctKey(builder, normalizedUrl),
    },
  ]);
  const summary = builder.project(summaryAggregate, {
    rowType: builder.literal("summary", STRING),
    referrer: builder.literal("", STRING),
    totalViews: builder.slot(summaryAggregate, "totalViews"),
    directViews: builder.slot(summaryAggregate, "directViews"),
    externalViews: builder.slot(summaryAggregate, "externalViews"),
    uniqueDomains: builder.slot(summaryAggregate, "uniqueDomains"),
    uniqueLinks: builder.slot(summaryAggregate, "uniqueLinks"),
    views: builder.literal(0, NUMBER),
  });
  builder.output("referrer-summary", summary, [
    { name: "rowType", slot: "rowType" },
    { name: "referrer", slot: "referrer" },
    { name: "totalViews", slot: "totalViews" },
    { name: "directViews", slot: "directViews" },
    { name: "externalViews", slot: "externalViews" },
    { name: "uniqueDomains", slot: "uniqueDomains" },
    { name: "uniqueLinks", slot: "uniqueLinks" },
    { name: "views", slot: "views" },
  ]);

  const nonemptyPages = builder.filter(
    pages,
    builder.compare("neq", normalizedHost, builder.literal("", STRING)),
  );
  const topAggregate = builder.aggregate(
    nonemptyPages,
    { referrer: normalizedHost },
    [{ name: "views", kind: "count-rows" }],
  );
  const sortedTop = builder.sort(topAggregate, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "referrer", direction: "asc", nulls: "first" },
  ]);
  const rowLimit = Number.isFinite(options.topN)
    ? Math.max(0, Math.floor(options.topN + 1))
    : 0;
  const limitedTop = builder.limit(sortedTop, rowLimit);
  const top = builder.project(limitedTop, {
    rowType: builder.literal("top", STRING),
    referrer: builder.slot(limitedTop, "referrer"),
    totalViews: builder.literal(null, NUMBER),
    directViews: builder.literal(null, NUMBER),
    externalViews: builder.literal(null, NUMBER),
    uniqueDomains: builder.literal(null, NUMBER),
    uniqueLinks: builder.literal(null, NUMBER),
    views: builder.slot(limitedTop, "views"),
  });
  builder.output("referrer-top-sources", top, [
    { name: "rowType", slot: "rowType" },
    { name: "referrer", slot: "referrer" },
    { name: "totalViews", slot: "totalViews" },
    { name: "directViews", slot: "directViews" },
    { name: "externalViews", slot: "externalViews" },
    { name: "uniqueDomains", slot: "uniqueDomains" },
    { name: "uniqueLinks", slot: "uniqueLinks" },
    { name: "views", slot: "views" },
  ]);
}
