import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const MILLISECONDS = { kind: "scalar", scalar: "number", unit: "ms" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

export type TechnologyRadarDimension = "browser" | "referrer";

export type TechnologyRadarQualificationConfiguration =
  | { readonly dimension: "browser" }
  | { readonly dimension: "referrer"; readonly limit: number }
  | {
      readonly dimension: "version";
      readonly browserLimit: number;
      readonly versionLimit: number;
    };

export type TechnologyRadarDimensionQualificationConfiguration = Extract<
  TechnologyRadarQualificationConfiguration,
  { readonly dimension: "browser" | "referrer" }
>;

export const TECHNOLOGY_RADAR_OUTPUTS = {
  browser: "technology-browser-radar",
  referrer: "technology-referrer-radar",
} as const;

interface TechnologyRadarPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  /** Select the canonical prepared-scoped Page Source for an already prepared visit relation. */
  readonly pageVisitQualification?: true;
  readonly dimension: TechnologyRadarDimension;
  readonly limit?: number;
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "browser" | "referrerHost" | "sessionId" | "visitorId" | "durationMs",
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
  numerator: ReturnType<LogicalPlanBuilder["slot"]>,
  denominator: ReturnType<LogicalPlanBuilder["slot"]>,
  zero: typeof NUMBER | typeof MILLISECONDS | typeof RATIO,
) {
  return builder.caseWhen(
    [
      {
        when: builder.compare("lte", denominator, builder.literal(0, NUMBER)),
        then: builder.literal(0, zero),
      },
    ],
    builder.arithmetic("divide", numerator, denominator),
  );
}

function appendOutput(
  builder: LogicalPlanBuilder,
  dimension: TechnologyRadarDimension,
  relation: LogicalRelationHandle,
): void {
  const dimensionName = dimension;
  builder.output(TECHNOLOGY_RADAR_OUTPUTS[dimension], relation, [
    { name: dimensionName, slot: dimensionName },
    { name: "sessions", slot: "sessions" },
    { name: "bounces", slot: "bounces" },
    { name: "avgDurationMs", slot: "avgDurationMs" },
    { name: "avgDepth", slot: "avgDepth" },
    { name: "visitors", slot: "visitors" },
    { name: "returningVisitors", slot: "returningVisitors" },
    { name: "avgFrequency", slot: "avgFrequency" },
    { name: "trafficShare", slot: "trafficShare" },
  ]);
}

/** Adds the existing Browser or Referrer metrics to a caller-owned Page bag. */
export function appendTechnologyRadarReport(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly dimension: TechnologyRadarDimension;
  readonly limit?: number;
}): void {
  const { builder, pages } = input;
  const dimensionAttribute =
    input.dimension === "browser" ? "browser" : "referrerHost";
  const rawDimension = pageAttribute(builder, pages, dimensionAttribute);
  const dimension = builder.normalizeString(
    builder.coalesce(rawDimension, builder.literal("", STRING)),
    "trim-ascii-space",
  );
  const eligiblePages =
    input.dimension === "browser"
      ? builder.filter(
          pages,
          builder.compare("neq", dimension, builder.literal("", STRING)),
        )
      : pages;
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const durationMs = pageAttribute(builder, pages, "durationMs");
  const safeDurationMs = builder.caseWhen(
    [
      {
        when: builder.and(
          builder.isNull(durationMs, true),
          builder.compare("gte", durationMs, builder.literal(0, MILLISECONDS)),
        ),
        then: durationMs,
      },
    ],
    builder.literal(0, MILLISECONDS),
  );

  const sessionPages = builder.filter(
    eligiblePages,
    builder.compare("neq", sessionId, builder.literal("", STRING)),
  );
  const sessionLevel = builder.aggregate(
    sessionPages,
    { [input.dimension]: dimension, sessionId },
    [
      { name: "visitCount", kind: "count-rows" },
      { name: "sessionDuration", kind: "sum", expression: safeDurationMs },
    ],
  );
  const sessionDimension = builder.slot(sessionLevel, input.dimension);
  const visitCount = builder.slot(sessionLevel, "visitCount");
  const sessionDuration = builder.slot(sessionLevel, "sessionDuration");
  const sessionAggregate = builder.aggregate(
    sessionLevel,
    { [input.dimension]: sessionDimension },
    [
      { name: "sessions", kind: "count-rows" },
      {
        name: "bounces",
        kind: "sum",
        expression: builder.caseWhen(
          [
            {
              when: builder.compare(
                "eq",
                visitCount,
                builder.literal(1, NUMBER),
              ),
              then: builder.literal(1, NUMBER),
            },
          ],
          builder.literal(0, NUMBER),
        ),
      },
      { name: "totalDurationMs", kind: "sum", expression: sessionDuration },
      { name: "totalDepth", kind: "sum", expression: visitCount },
    ],
  );

  const visitorPages = builder.filter(
    eligiblePages,
    builder.compare("neq", visitorId, builder.literal("", STRING)),
  );
  const visitorSessionId = pageAttribute(builder, visitorPages, "sessionId");
  const visitorLevel = builder.aggregate(
    visitorPages,
    { [input.dimension]: dimension, visitorId },
    [
      {
        name: "sessionCount",
        kind: "count-distinct",
        expression: nonemptyIdentity(builder, visitorSessionId),
      },
    ],
  );
  const sessionCount = builder.slot(visitorLevel, "sessionCount");
  const visitorAggregate = builder.aggregate(
    visitorLevel,
    { [input.dimension]: builder.slot(visitorLevel, input.dimension) },
    [
      { name: "visitors", kind: "count-rows" },
      {
        name: "returningVisitors",
        kind: "sum",
        expression: builder.caseWhen(
          [
            {
              when: builder.compare(
                "gt",
                sessionCount,
                builder.literal(1, NUMBER),
              ),
              then: builder.literal(1, NUMBER),
            },
          ],
          builder.literal(0, NUMBER),
        ),
      },
      { name: "totalFrequency", kind: "sum", expression: sessionCount },
    ],
  );

  const totalVisitorId = pageAttribute(builder, eligiblePages, "visitorId");
  const totalVisitors = builder.aggregate(eligiblePages, {}, [
    {
      name: "totalVisitors",
      kind: "count-distinct",
      expression: nonemptyIdentity(builder, totalVisitorId),
    },
  ]);
  const withVisitors = builder.join(
    sessionAggregate,
    visitorAggregate,
    [{ left: input.dimension, right: input.dimension }],
    "inner",
  );
  const withDenominator = builder.join(
    withVisitors,
    totalVisitors,
    [],
    "inner",
  );

  const sessions = builder.slot(withDenominator, "sessions");
  const visitors = builder.slot(withDenominator, "right.visitors");
  const metrics = builder.project(withDenominator, {
    [input.dimension]: builder.slot(withDenominator, input.dimension),
    sessions,
    bounces: builder.slot(withDenominator, "bounces"),
    avgDurationMs: safeDivision(
      builder,
      builder.slot(withDenominator, "totalDurationMs"),
      sessions,
      MILLISECONDS,
    ),
    avgDepth: safeDivision(
      builder,
      builder.slot(withDenominator, "totalDepth"),
      sessions,
      RATIO,
    ),
    visitors,
    returningVisitors: builder.slot(withDenominator, "right.returningVisitors"),
    avgFrequency: safeDivision(
      builder,
      builder.slot(withDenominator, "right.totalFrequency"),
      visitors,
      RATIO,
    ),
    trafficShare: safeDivision(
      builder,
      visitors,
      builder.slot(withDenominator, "right.totalVisitors"),
      RATIO,
    ),
  });

  const sorted = builder.sort(
    metrics,
    input.dimension === "browser"
      ? [{ slot: "visitors", direction: "desc", nulls: "last" }]
      : [
          { slot: "visitors", direction: "desc", nulls: "last" },
          { slot: "sessions", direction: "desc", nulls: "last" },
          { slot: "referrer", direction: "asc", nulls: "first" },
        ],
  );
  const limited =
    input.dimension === "referrer"
      ? Number.isInteger(input.limit) && (input.limit ?? 0) < 0
        ? sorted
        : builder.limit(sorted, input.limit ?? 0)
      : sorted;

  appendOutput(builder, input.dimension, limited);
}

/** Builds the one-statement Browser or Referrer technology radar report. */
export function buildTechnologyRadarPlan(
  input: TechnologyRadarPlanInput,
): ValidatedLogicalPlan {
  const dimensionAttribute =
    input.dimension === "browser" ? "browser" : "referrerHost";
  const { builder, pages } = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.pageVisitQualification
      ? {
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        }
      : {}),
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          ...(!input.pageVisitQualification
            ? { preparedTimePolicy: "reader-window-v1" as const }
            : {}),
        }
      : {}),
    attributes: [
      `page.report.${dimensionAttribute}`,
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.durationMs",
    ],
  });
  appendTechnologyRadarReport({
    builder,
    pages,
    dimension: input.dimension,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return builder.finish();
}
