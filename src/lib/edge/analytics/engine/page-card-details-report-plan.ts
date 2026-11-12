import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const PAGE_CARD_DETAILS_OUTPUT_IDS = {
  titles: "page-card-details-titles",
  trend: "page-card-details-trend",
  detailTitles: "page-card-details-title-rows",
  detailTrend: "page-card-details-trend-rows",
} as const;

export const PAGE_CARD_DETAILS_MULTI_OUTPUT_FIELDS = [
  "rowKind",
  "pathname",
  "title",
  "views",
  "bucket",
  "visitors",
  "rowOrder",
] as const;

export const PAGE_CARD_DETAILS_MULTI_OUTPUT_IDS = [
  PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
  PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
] as const;

interface PageCardSourceInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly pathnames: readonly string[];
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "pathname" | "title" | "startedAt" | "visitorId",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function createPageCardSource(
  input: PageCardSourceInput,
  attributes: readonly string[],
) {
  const { builder, pages } = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    ...(input.scopePlan
      ? { preparedTimePolicy: "reader-window-v1" as const }
      : {}),
    attributes,
  });
  const pathname = pageAttribute(builder, pages, "pathname");
  const normalizedPathname = builder.normalizeString(
    builder.coalesce(pathname, builder.literal("", STRING)),
    "trim-ascii-space",
  );
  const filteredPages = builder.filter(
    pages,
    builder.and(
      builder.compare("neq", normalizedPathname, builder.literal("", STRING)),
      builder.in(
        normalizedPathname,
        input.pathnames.map((value) => builder.literal(value, STRING)),
      ),
    ),
  );
  return { builder, pages, filteredPages };
}

/** Appends ranked title rows from a caller-selected Page subrelation. */
export function appendPageCardTitleRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  selectedPages: LogicalRelationHandle,
  titleLimit: number,
) {
  const pathname = pageAttribute(builder, pages, "pathname");
  const normalizedTitle = builder.normalizeString(
    builder.coalesce(
      pageAttribute(builder, pages, "title"),
      builder.literal("", STRING),
    ),
    "trim-ascii-space",
  );
  const rollup = builder.aggregate(
    selectedPages,
    { pathname, title: normalizedTitle },
    [{ name: "views", kind: "count-rows" }],
  );
  const nonempty = builder.filter(
    rollup,
    builder.compare(
      "neq",
      builder.slot(rollup, "title"),
      builder.literal("", STRING),
    ),
  );
  const ranked = builder.rankedMembers(nonempty, {
    groups: ["pathname"],
    order: [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "title", direction: "asc", nulls: "first" },
    ],
  });
  return builder.filter(
    ranked,
    builder.compare(
      "lte",
      builder.slot(ranked, "rank"),
      builder.literal(titleLimit, NUMBER),
    ),
  );
}

/** Declares the standalone titles output on a caller-owned builder. */
export function appendPageCardTitlesOutput(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  outputId = PAGE_CARD_DETAILS_OUTPUT_IDS.titles,
): void {
  const projected = builder.project(rows, {
    pathname: builder.slot(rows, "pathname"),
    title: builder.slot(rows, "title"),
    views: builder.slot(rows, "views"),
    rowOrder: builder.slot(rows, "rank"),
  });
  const sorted = builder.sort(projected, [
    { slot: "pathname", direction: "asc", nulls: "first" },
    { slot: "rowOrder", direction: "asc", nulls: "first" },
  ]);
  builder.output(outputId, sorted, [
    { name: "pathname", slot: "pathname" },
    { name: "title", slot: "title" },
    { name: "views", slot: "views" },
  ]);
}

/** Declares detail-shaped title rows for a caller-owned multi-output plan. */
export function appendPageCardDetailTitlesOutput(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  outputId = PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
): void {
  const projected = builder.project(rows, {
    rowKind: builder.literal("title", STRING),
    pathname: builder.slot(rows, "pathname"),
    title: builder.slot(rows, "title"),
    views: builder.slot(rows, "views"),
    bucket: builder.literal(null, NUMBER),
    visitors: builder.literal(null, NUMBER),
    rowOrder: builder.slot(rows, "rank"),
  });
  builder.output(
    outputId,
    projected,
    PAGE_CARD_DETAILS_MULTI_OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
}

function nonemptyVisitor(
  builder: LogicalPlanBuilder,
  visitorId: ReturnType<typeof pageAttribute>,
) {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", visitorId, builder.literal("", STRING)),
        then: visitorId,
      },
    ],
    builder.literal(null, STRING),
  );
}

/** Appends bucketed trend rows from a caller-selected Page subrelation. */
export function appendPageCardTrendRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  selectedPages: LogicalRelationHandle,
  interval: CalendarGranularity,
) {
  const pathname = pageAttribute(builder, pages, "pathname");
  const bucket = builder.bucketIndex(
    builder.timeBucket(pageAttribute(builder, pages, "startedAt"), interval),
  );
  return builder.aggregate(selectedPages, { pathname, bucket }, [
    { name: "views", kind: "count-rows" },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonemptyVisitor(
        builder,
        pageAttribute(builder, pages, "visitorId"),
      ),
    },
  ]);
}

/** Declares the standalone trend output on a caller-owned builder. */
export function appendPageCardTrendOutput(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  outputId = PAGE_CARD_DETAILS_OUTPUT_IDS.trend,
): void {
  const projected = builder.project(rows, {
    pathname: builder.slot(rows, "pathname"),
    bucket: builder.slot(rows, "bucket"),
    views: builder.slot(rows, "views"),
    visitors: builder.slot(rows, "visitors"),
  });
  const sorted = builder.sort(projected, [
    { slot: "pathname", direction: "asc", nulls: "first" },
    { slot: "bucket", direction: "asc", nulls: "first" },
  ]);
  builder.output(outputId, sorted, [
    { name: "pathname", slot: "pathname" },
    { name: "bucket", slot: "bucket" },
    { name: "views", slot: "views" },
    { name: "visitors", slot: "visitors" },
  ]);
}

/** Declares detail-shaped trend rows for a caller-owned multi-output plan. */
export function appendPageCardDetailTrendOutput(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  outputId = PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
): void {
  const projected = builder.project(rows, {
    rowKind: builder.literal("trend", STRING),
    pathname: builder.slot(rows, "pathname"),
    title: builder.literal(null, STRING),
    views: builder.slot(rows, "views"),
    bucket: builder.slot(rows, "bucket"),
    visitors: builder.slot(rows, "visitors"),
    rowOrder: builder.coalesce(
      builder.slot(rows, "bucket"),
      builder.literal(null, NUMBER),
    ),
  });
  builder.output(
    outputId,
    projected,
    PAGE_CARD_DETAILS_MULTI_OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
}

export function buildPageCardTitlesPlan(
  input: PageCardSourceInput & { readonly titleLimit: number },
) {
  const { builder, pages, filteredPages } = createPageCardSource(input, [
    "page.report.pathname",
    "page.report.title",
  ]);
  const rows = appendPageCardTitleRows(
    builder,
    pages,
    filteredPages,
    input.titleLimit,
  );
  appendPageCardTitlesOutput(builder, rows);
  return builder.finish();
}

export function buildPageCardTrendPlan(
  input: PageCardSourceInput & { readonly interval: CalendarGranularity },
) {
  const { builder, pages, filteredPages } = createPageCardSource(input, [
    "page.report.pathname",
    "page.report.startedAt",
    "page.report.visitorId",
  ]);
  appendPageCardTrendOutput(
    builder,
    appendPageCardTrendRows(builder, pages, filteredPages, input.interval),
  );
  return builder.finish();
}

/** Builds title and trend detail outputs from one shared Page Source. */
export function buildPageCardDetailsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly interval: CalendarGranularity;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly pathnames: readonly string[];
  readonly titleLimit: number;
}) {
  const { builder, pages, filteredPages } = createPageCardSource(input, [
    "page.report.pathname",
    "page.report.title",
    "page.report.startedAt",
    "page.report.visitorId",
  ]);
  appendPageCardDetailTitlesOutput(
    builder,
    appendPageCardTitleRows(builder, pages, filteredPages, input.titleLimit),
  );
  appendPageCardDetailTrendOutput(
    builder,
    appendPageCardTrendRows(builder, pages, filteredPages, input.interval),
  );
  return builder.finish();
}
