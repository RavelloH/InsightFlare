import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  pageDimensionReportSource,
  type PageDimensionSelection,
  selectedPageDimension,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS = {
  primary: "technology-cross-primary",
  secondary: "technology-cross-secondary",
  pairs: "technology-cross-pairs",
} as const;

export type TechnologyCrossBreakdownFamily = "browser" | "client";

interface TechnologyCrossBreakdownTokens {
  readonly unknown: string;
  readonly otherPrimary: string;
  readonly otherSecondary: string;
}

export interface TechnologyCrossBreakdownPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly family: TechnologyCrossBreakdownFamily;
  readonly primarySelection: PageDimensionSelection;
  readonly secondarySelection: PageDimensionSelection;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
  readonly tokens: TechnologyCrossBreakdownTokens;
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "page.report.visitorId" | "page.report.sessionId",
) {
  return builder.slot(pages, `attribute:${name}`);
}

function distinctNonempty(
  builder: LogicalPlanBuilder,
  identity: LogicalExpressionHandle,
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

function rollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  keyName: "primaryValue" | "secondaryValue",
) {
  const visitors = builder.slot(pages, "visitorId");
  const sessions = builder.slot(pages, "sessionId");
  return builder.aggregate(pages, { [keyName]: builder.slot(pages, keyName) }, [
    { name: "views", kind: "count-rows" },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: distinctNonempty(builder, visitors),
    },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: distinctNonempty(builder, sessions),
    },
  ]);
}

function rankedTop(
  builder: LogicalPlanBuilder,
  aggregate: LogicalRelationHandle,
  keyName: "primaryValue" | "secondaryValue",
  limit: number,
) {
  const ranked = builder.rankedMembers(aggregate, {
    groups: [],
    order: [
      { slot: "visitors", direction: "desc", nulls: "last" },
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "sessions", direction: "desc", nulls: "last" },
      { slot: keyName, direction: "asc", nulls: "first" },
    ],
  });
  return builder.filter(
    ranked,
    builder.compare(
      "lte",
      builder.slot(ranked, "rank"),
      builder.literal(limit, NUMBER),
    ),
  );
}

function legacyLimit(value: number, cap: number): number {
  const normalized = Math.min(Math.max(1, value), cap);
  if (!Number.isInteger(normalized))
    throw new Error("logical_builder_invalid_limit");
  return normalized;
}

function outputFields(family: TechnologyCrossBreakdownFamily) {
  return family === "browser"
    ? ({
        primary: "browser",
        secondary: "dimension",
        rowTypes: { primary: "browser", secondary: "dimension", pairs: "pair" },
      } as const)
    : ({
        primary: "primaryValue",
        secondary: "secondaryValue",
        rowTypes: { primary: "primary", secondary: "secondary", pairs: "pair" },
      } as const);
}

function output(
  builder: LogicalPlanBuilder,
  id: string,
  relation: LogicalRelationHandle,
  fields: readonly string[],
): void {
  builder.output(
    id,
    relation,
    fields.map((name) => ({ name, slot: name })),
  );
}

/** Builds both ranked dimensions and the re-bucketed pair matrix in one graph. */
export function buildTechnologyCrossBreakdownPlan(
  input: TechnologyCrossBreakdownPlanInput,
): ValidatedLogicalPlan {
  const primaryLimit = legacyLimit(input.primaryLimit, 12);
  const secondaryLimit = legacyLimit(input.secondaryLimit, 8);
  const primarySelection = validatePageDimensionSelection(
    input.primarySelection,
  );
  const secondarySelection = validatePageDimensionSelection(
    input.secondarySelection,
  );
  const { builder, pages } = pageDimensionReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    selections: [primarySelection, secondarySelection],
  });
  const empty = builder.literal("", STRING);
  const primary = builder.coalesce(
    selectedPageDimension(builder, pages, primarySelection),
    empty,
  );
  const rawSecondary = builder.coalesce(
    selectedPageDimension(builder, pages, secondarySelection),
    empty,
  );
  const secondary = builder.caseWhen(
    [
      {
        when: builder.compare("neq", rawSecondary, empty),
        then: rawSecondary,
      },
    ],
    builder.literal(input.tokens.unknown, STRING),
  );
  const projectedPages = builder.project(pages, {
    primaryValue: primary,
    secondaryValue: secondary,
    visitorId: pageAttribute(builder, pages, "page.report.visitorId"),
    sessionId: pageAttribute(builder, pages, "page.report.sessionId"),
  });
  const eligiblePages = builder.filter(
    projectedPages,
    builder.compare("neq", builder.slot(projectedPages, "primaryValue"), empty),
  );

  const primaryTop = rankedTop(
    builder,
    rollup(builder, eligiblePages, "primaryValue"),
    "primaryValue",
    primaryLimit,
  );
  const secondaryTop = rankedTop(
    builder,
    rollup(builder, eligiblePages, "secondaryValue"),
    "secondaryValue",
    secondaryLimit,
  );
  const primaryLookupRows = builder.filter(
    primaryTop,
    builder.compare(
      "gt",
      builder.slot(primaryTop, "visitors"),
      builder.literal(0, NUMBER),
    ),
  );
  const primaryLookup = builder.project(primaryLookupRows, {
    primaryLookupValue: builder.slot(primaryLookupRows, "primaryValue"),
  });
  const secondaryLookupRows = builder.filter(
    secondaryTop,
    builder.compare(
      "gt",
      builder.slot(secondaryTop, "visitors"),
      builder.literal(0, NUMBER),
    ),
  );
  const secondaryLookup = builder.project(secondaryLookupRows, {
    secondaryLookupValue: builder.slot(secondaryLookupRows, "secondaryValue"),
  });

  const primaryJoined = builder.join(
    eligiblePages,
    primaryLookup,
    [{ left: "primaryValue", right: "primaryLookupValue" }],
    "left",
  );
  const fullyJoined = builder.join(
    primaryJoined,
    secondaryLookup,
    [{ left: "secondaryValue", right: "secondaryLookupValue" }],
    "left",
  );
  const bucketedPages = builder.project(fullyJoined, {
    primaryBucket: builder.coalesce(
      builder.slot(fullyJoined, "right.primaryLookupValue"),
      builder.literal(input.tokens.otherPrimary, STRING),
    ),
    secondaryBucket: builder.coalesce(
      builder.slot(fullyJoined, "right.secondaryLookupValue"),
      builder.literal(input.tokens.otherSecondary, STRING),
    ),
    visitorId: builder.slot(fullyJoined, "visitorId"),
    sessionId: builder.slot(fullyJoined, "sessionId"),
  });
  const pairRows = builder.aggregate(
    bucketedPages,
    {
      primaryBucket: builder.slot(bucketedPages, "primaryBucket"),
      secondaryBucket: builder.slot(bucketedPages, "secondaryBucket"),
    },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(bucketedPages, "visitorId"),
        ),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(bucketedPages, "sessionId"),
        ),
      },
    ],
  );

  const schema = outputFields(input.family);
  const fields = [
    "rowType",
    schema.primary,
    schema.secondary,
    "views",
    "visitors",
    "sessions",
    "rowOrder",
  ];
  const primaryRows = builder.project(primaryTop, {
    rowType: builder.literal(schema.rowTypes.primary, STRING),
    [schema.primary]: builder.slot(primaryTop, "primaryValue"),
    [schema.secondary]: builder.literal(null, STRING),
    views: builder.slot(primaryTop, "views"),
    visitors: builder.slot(primaryTop, "visitors"),
    sessions: builder.slot(primaryTop, "sessions"),
    rowOrder: builder.slot(primaryTop, "rank"),
  });
  const secondaryRows = builder.project(secondaryTop, {
    rowType: builder.literal(schema.rowTypes.secondary, STRING),
    [schema.primary]: builder.literal(null, STRING),
    [schema.secondary]: builder.slot(secondaryTop, "secondaryValue"),
    views: builder.slot(secondaryTop, "views"),
    visitors: builder.slot(secondaryTop, "visitors"),
    sessions: builder.slot(secondaryTop, "sessions"),
    rowOrder: builder.slot(secondaryTop, "rank"),
  });
  const pairOutputRows = builder.project(pairRows, {
    rowType: builder.literal(schema.rowTypes.pairs, STRING),
    [schema.primary]: builder.slot(pairRows, "primaryBucket"),
    [schema.secondary]: builder.slot(pairRows, "secondaryBucket"),
    views: builder.slot(pairRows, "views"),
    visitors: builder.slot(pairRows, "visitors"),
    sessions: builder.slot(pairRows, "sessions"),
    rowOrder: builder.literal(0, NUMBER),
  });
  output(
    builder,
    TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.primary,
    primaryRows,
    fields,
  );
  output(
    builder,
    TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.secondary,
    secondaryRows,
    fields,
  );
  output(
    builder,
    TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.pairs,
    pairOutputRows,
    fields,
  );
  return builder.finish();
}
