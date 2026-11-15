import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPaginatedPageRows,
  type PageAggregateCursor,
} from "@/lib/edge/analytics/engine/page-report-plan";
import {
  buildPageTabRows,
  createPageTabsReportSources,
  PAGE_TAB_CARDS,
} from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const PAGES_WITH_TABS_PAGE_OUTPUT_ID = "pages-with-tabs-page";
export const PAGES_WITH_TABS_OUTPUT_FIELDS = [
  "rowType",
  "cardType",
  "pathname",
  "queryValue",
  "hashValue",
  "value",
  "views",
  "sessions",
  "visitors",
] as const;

export const PAGES_WITH_TABS_OUTPUT_IDS = [
  PAGES_WITH_TABS_PAGE_OUTPUT_ID,
  ...PAGE_TAB_CARDS.map(({ outputId }) => outputId),
  "page-tabs-entry",
  "page-tabs-exit",
] as const;

function output(
  builder: LogicalPlanBuilder,
  outputId: string,
  rows: LogicalRelationHandle,
): void {
  builder.output(
    outputId,
    rows,
    PAGES_WITH_TABS_OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
}

function pageOutputRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  input: {
    readonly limit: number;
    readonly includeDetails: boolean;
    readonly cursor?: PageAggregateCursor | null;
  },
): LogicalRelationHandle {
  const selected = buildPaginatedPageRows(builder, pages, input);
  return builder.project(selected, {
    rowType: builder.literal("page", STRING),
    cardType: builder.literal("", STRING),
    pathname: builder.slot(selected, "pathname"),
    queryValue: builder.slot(selected, "query"),
    hashValue: builder.slot(selected, "hash"),
    value: builder.literal("", STRING),
    views: builder.slot(selected, "views"),
    sessions: builder.slot(selected, "sessions"),
    visitors: builder.literal(0, NUMBER),
  });
}

/** Appends the legacy Page page and five tab outputs for shared Page bags. */
export function appendPagesWithTabsOutputs(
  builder: LogicalPlanBuilder,
  input: {
    readonly pages: LogicalRelationHandle;
    readonly boundaryPages: LogicalRelationHandle;
    readonly limit: number;
    readonly includeDetails: boolean;
    readonly cursor?: PageAggregateCursor | null;
  },
): void {
  output(
    builder,
    PAGES_WITH_TABS_PAGE_OUTPUT_ID,
    pageOutputRows(builder, input.pages, input),
  );
  const cards = buildPageTabRows(
    builder,
    input.pages,
    input.boundaryPages,
    input.limit,
  );
  for (const card of PAGE_TAB_CARDS)
    output(
      builder,
      card.outputId,
      tabOutputRows(builder, cards[card.cardType]),
    );
  output(builder, "page-tabs-entry", tabOutputRows(builder, cards.entry));
  output(builder, "page-tabs-exit", tabOutputRows(builder, cards.exit));
}

function tabOutputRows(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.project(rows, {
    rowType: builder.literal("tab", STRING),
    cardType: builder.slot(rows, "cardType"),
    pathname: builder.literal("", STRING),
    queryValue: builder.literal("", STRING),
    hashValue: builder.literal("", STRING),
    value: builder.slot(rows, "value"),
    views: builder.slot(rows, "views"),
    sessions: builder.slot(rows, "sessions"),
    visitors: builder.slot(rows, "visitors"),
  });
}

/** Builds the single shared Page Source and six paginated Page/tab outputs. */
export function buildPagesWithTabsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationSemantics?: "whole-original";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor?: PageAggregateCursor | null;
}): ValidatedLogicalPlan {
  const { builder, pages, boundaryPages } = createPageTabsReportSources({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.qualificationSemantics
      ? { qualificationSemantics: input.qualificationSemantics }
      : {}),
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    additionalAttributes: [
      "page.report.pathname",
      "page.report.title",
      "page.report.hostname",
      ...(input.includeDetails
        ? ["page.report.queryString", "page.report.hash"]
        : []),
    ],
  });
  appendPagesWithTabsOutputs(builder, {
    pages,
    boundaryPages,
    limit: input.limit,
    includeDetails: input.includeDetails,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  return builder.finish();
}
