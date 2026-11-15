import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime, SiteId } from "@/lib/edge/analytics/contract/types";
import { cardLimit } from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  dimensionRollup,
  PAGE_DIMENSION_SELECTIONS,
  pageDimensionReportSource,
  selectedPageDimension,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  aggregateSessionBoundaries,
  selectedSessionBoundaryPair,
} from "@/lib/edge/analytics/engine/session-boundary-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const OUTPUT_FIELDS = [
  "cardType",
  "value",
  "views",
  "sessions",
  "visitors",
] as const;
export const PAGE_TAB_CARDS = [
  {
    cardType: "path",
    selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
    outputId: "page-tabs-path",
  },
  {
    cardType: "title",
    selection: PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed,
    outputId: "page-tabs-title",
  },
  {
    cardType: "hostname",
    selection: PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed,
    outputId: "page-tabs-hostname",
  },
] as const;

export interface PageTabsSourceInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationSemantics?: "whole-original";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly additionalAttributes?: readonly string[];
}

export function createPageTabsReportSources(input: PageTabsSourceInput) {
  const directSessionExpansion =
    !input.scopePlan && input.filters.root !== null;
  const { builder, pages } = pageDimensionReportSource({
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
    selections: PAGE_TAB_CARDS.map(({ selection }) => selection),
    additionalAttributes: [
      ...(input.additionalAttributes ?? []),
      ...(!directSessionExpansion
        ? ["page.report.startedAt", "page.report.localId"]
        : []),
    ],
  });
  let boundaryPages = pages;
  if (directSessionExpansion) {
    const subject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: [input.siteId as SiteId],
    });
    const selection = createSemanticScopedSourceSelection({
      profile: "direct-page-session-compat-v1",
      filters: input.filters,
      subject,
      time: semanticTemporalDomainsFromQueryTime(input.queryTime),
    });
    boundaryPages = builder.source("page", {
      temporalDomain: "candidate",
      attributes: [
        "page.report.sessionId",
        "page.report.visitorId",
        "page.report.startedAt",
        "page.report.localId",
        "page.report.pathname",
      ],
      selection,
    });
  }
  return { builder, pages, boundaryPages };
}

function output(
  builder: LogicalPlanBuilder,
  id: string,
  rows: LogicalRelationHandle,
): void {
  builder.output(
    id,
    rows,
    OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
}

function ordinaryCardRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  card: (typeof PAGE_TAB_CARDS)[number],
  limit: number | null,
): LogicalRelationHandle {
  const rolled = dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, card.selection),
  );
  const value = builder.slot(rolled, "value");
  const nonempty = builder.filter(
    rolled,
    builder.compare(
      "neq",
      builder.normalizeString(value, "trim-ascii-space"),
      builder.literal("", STRING),
    ),
  );
  const rows = builder.project(nonempty, {
    cardType: builder.literal(card.cardType, STRING),
    value: builder.slot(nonempty, "value"),
    views: builder.slot(nonempty, "views"),
    sessions: builder.slot(nonempty, "sessions"),
    visitors: builder.slot(nonempty, "visitors"),
  });
  const sorted = builder.sort(rows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "value", direction: "asc", nulls: "first" },
  ]);
  return limit === null ? sorted : builder.limit(sorted, limit);
}

function boundaryCardRows(
  builder: LogicalPlanBuilder,
  boundaries: LogicalRelationHandle,
  cardType: "entry" | "exit",
  limit: number | null,
): LogicalRelationHandle {
  const rolled = aggregateSessionBoundaries(builder, boundaries);
  const rows = builder.project(rolled, {
    cardType: builder.literal(cardType, STRING),
    value: builder.slot(rolled, "value"),
    views: builder.slot(rolled, "views"),
    sessions: builder.slot(rolled, "sessions"),
    visitors: builder.slot(rolled, "visitors"),
  });
  const sorted = builder.sort(rows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "value", direction: "asc", nulls: "first" },
  ]);
  return limit === null ? sorted : builder.limit(sorted, limit);
}

export function buildPageTabRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  boundaryPages: LogicalRelationHandle,
  requestedLimit: number,
) {
  const limit = cardLimit(requestedLimit);
  const boundaries = selectedSessionBoundaryPair(builder, boundaryPages);
  return {
    path: ordinaryCardRows(builder, pages, PAGE_TAB_CARDS[0], limit),
    title: ordinaryCardRows(builder, pages, PAGE_TAB_CARDS[1], limit),
    hostname: ordinaryCardRows(builder, pages, PAGE_TAB_CARDS[2], limit),
    entry: boundaryCardRows(builder, boundaries.entry, "entry", limit),
    exit: boundaryCardRows(builder, boundaries.exit, "exit", limit),
  };
}

/** Appends the five legacy Page tab outputs for an already selected Page bag. */
export function appendPageTabOutputs(
  builder: LogicalPlanBuilder,
  rows: ReturnType<typeof buildPageTabRows>,
): void {
  for (const card of PAGE_TAB_CARDS)
    output(builder, card.outputId, rows[card.cardType]);
  output(builder, "page-tabs-entry", rows.entry);
  output(builder, "page-tabs-exit", rows.exit);
}

/** Builds the five Page cards while keeping observation and session Page bags distinct. */
export function buildPageTabsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationSemantics?: "whole-original";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly limit: number;
}): ValidatedLogicalPlan {
  const { builder, pages, boundaryPages } = createPageTabsReportSources(input);
  const rows = buildPageTabRows(builder, pages, boundaryPages, input.limit);
  appendPageTabOutputs(builder, rows);
  return builder.finish();
}

export const PAGE_TAB_OUTPUT_IDS: readonly string[] = [
  ...PAGE_TAB_CARDS.map(({ outputId }) => outputId),
  "page-tabs-entry",
  "page-tabs-exit",
];

export const PAGE_TAB_OUTPUT_FIELDS = OUTPUT_FIELDS;

export const PAGE_TAB_OUTPUT_ORDER_BY = [
  { field: "cardType", direction: "asc", nulls: "first" },
  { field: "views", direction: "desc", nulls: "last" },
  { field: "sessions", direction: "desc", nulls: "last" },
  { field: "value", direction: "asc", nulls: "first" },
] as const;
