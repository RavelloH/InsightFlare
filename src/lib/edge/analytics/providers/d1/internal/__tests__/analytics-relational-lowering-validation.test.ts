import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query } from "@/lib/db";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalComparisonExpression } from "@/lib/edge/analytics/engine/logical/expression";
import {
  type RelationId,
  relationId,
  type SlotId,
  slotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE_ID = "relational-lowering-validation-site";
const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

function createBuilder(): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: { startMs: 0 as never, endExclusiveMs: 1 as never },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 0 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function withNode(
  plan: ValidatedLogicalPlan,
  relationId: RelationId,
  update: (node: LogicalNode) => LogicalNode,
): ValidatedLogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) =>
      node.id === relationId ? update(node) : node,
    ),
  } as ValidatedLogicalPlan;
}

function withSlotType(
  plan: ValidatedLogicalPlan,
  id: SlotId,
  type:
    | { readonly kind: "scalar"; readonly scalar: "string" }
    | {
        readonly kind: "entity";
        readonly entity: "page";
      },
): ValidatedLogicalPlan {
  return {
    ...plan,
    slots: plan.slots.map((slot) =>
      slot.id === id ? { ...slot, type } : slot,
    ),
  } as ValidatedLogicalPlan;
}

function lower(plan: ValidatedLogicalPlan): void {
  new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_ID,
    time: plan.context.time,
  }).lower(plan.outputs[0]!);
}

function createComparisonPlan(numeric: boolean): ValidatedLogicalPlan {
  const builder = createBuilder();
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.localId",
      "page.report.status",
      "page.report.durationMs",
    ],
  });
  const predicate = numeric
    ? builder.compare(
        "eq",
        builder.slot(pages, "attribute:page.report.durationMs"),
        builder.literal(1, NUMBER_MS),
      )
    : builder.compare(
        "eq",
        builder.slot(pages, "attribute:page.report.status"),
        builder.literal("open", STRING),
      );
  const filtered = builder.filter(pages, predicate);
  builder.output("comparison", filtered, [
    { name: "localId", slot: "attribute:page.report.localId" },
  ]);
  return builder.finish();
}

function createOrderedPlan(): {
  readonly plan: ValidatedLogicalPlan;
  readonly memberId: RelationId;
  readonly entitySlot: SlotId;
} {
  const builder = createBuilder();
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.localId",
      "page.report.status",
      "page.report.durationMs",
    ],
  });
  const projected = builder.project(pages, {
    localId: builder.slot(pages, "attribute:page.report.localId"),
    statusAlias: builder.slot(pages, "attribute:page.report.status"),
    durationAlias: builder.slot(pages, "attribute:page.report.durationMs"),
    entityAlias: builder.slot(pages, "entity"),
  });
  const entitySlot = projected.slots.entityAlias!;
  const member = builder.orderedMember(projected, {
    groups: ["statusAlias"],
    order: [
      {
        slot: "durationAlias",
        direction: "asc",
        nulls: "first",
      },
    ],
  });
  builder.output("ordered", member, [{ name: "localId", slot: "localId" }]);
  return {
    plan: builder.finish(),
    memberId: member.id,
    entitySlot,
  };
}

function createKeyedJoinPlan(): {
  readonly plan: ValidatedLogicalPlan;
  readonly joinId: RelationId;
} {
  const builder = createBuilder();
  const leftSource = builder.source("page", {
    temporalDomain: "read",
    attributes: ["page.report.visitorId", "page.report.userId"],
  });
  const left = builder.aggregate(
    leftSource,
    {
      visitorId: builder.slot(leftSource, "attribute:page.report.visitorId"),
      userId: builder.slot(leftSource, "attribute:page.report.userId"),
    },
    [{ name: "leftRows", kind: "count-rows" }],
  );
  const rightSource = builder.source("page", {
    temporalDomain: "read",
    attributes: ["page.report.visitorId", "page.report.userId"],
  });
  const right = builder.aggregate(
    rightSource,
    {
      visitorId: builder.slot(rightSource, "attribute:page.report.visitorId"),
      userId: builder.slot(rightSource, "attribute:page.report.userId"),
    },
    [{ name: "rightRows", kind: "count-rows" }],
  );
  const joined = builder.join(
    left,
    right,
    [
      { left: "visitorId", right: "visitorId" },
      { left: "userId", right: "userId" },
    ],
    "left",
  );
  builder.output("join", joined, [
    { name: "leftRows", slot: "leftRows" },
    { name: "rightRows", slot: "right.rightRows" },
  ]);
  return {
    plan: builder.finish(),
    joinId: joined.id,
  };
}

function createReportSearchPlan(
  semantics: "legacy-record-search-v1" | "legacy-report-search-v1",
): ValidatedLogicalPlan {
  const builder = createBuilder();
  const pages = builder.source("page", {
    attributes: ["page.report.status"],
  });
  const search = builder.stringMatch(
    "contains",
    builder.slot(pages, "attribute:page.report.status"),
    "needle",
    false,
    undefined,
    semantics,
  );
  const filtered = builder.filter(pages, search);
  builder.output("search", filtered, [{ name: "localId", slot: "entity" }]);
  return builder.finish();
}

function createPageDimensionPlan(): {
  readonly plan: ValidatedLogicalPlan;
  readonly projectId: RelationId;
  readonly numericSlot: ReturnType<LogicalPlanBuilder["slot"]>["expression"];
} {
  const builder = createBuilder();
  const pages = builder.source("page", {
    attributes: [
      "page.report.browser",
      "page.report.os",
      "page.report.durationMs",
    ],
  });
  const dimension = builder.pageDimension("browserEngine", {
    "page.report.browser": builder.slot(pages, "attribute:page.report.browser"),
    "page.report.os": builder.slot(pages, "attribute:page.report.os"),
  });
  const projected = builder.project(pages, { value: dimension });
  const numericSlot = builder.slot(
    pages,
    "attribute:page.report.durationMs",
  ).expression;
  builder.output("page-dimension", projected, [
    { name: "value", slot: "value" },
  ]);
  return { plan: builder.finish(), projectId: projected.id, numericSlot };
}

describe("relational lowerer validation guards", () => {
  it("rechecks forged ROUND precision at the D1 lowering boundary", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.report.latitude"],
    });
    const rounded = builder.round(
      builder.slot(pages, "attribute:page.report.latitude"),
      3,
    );
    const projected = builder.project(pages, { rounded });
    builder.output("rounded-latitude", projected, [
      { name: "rounded", slot: "rounded" },
    ]);
    const plan = builder.finish();
    const forged = withNode(plan, projected.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "round"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      decimalPlaces: 16,
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(forged)).toThrow(
      "ROUND precision must be a static integer from 0 through 15.",
    );
  });

  it("rejects normalization metadata on non-string and ordered comparisons", () => {
    const numericPlan = createComparisonPlan(true);
    const numericFilter = numericPlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const nonStringNormalized = withNode(
      numericPlan,
      numericFilter.id,
      (node) =>
        node.kind === "filter"
          ? {
              ...node,
              predicate: {
                ...(node.predicate as LogicalComparisonExpression),
                stringNormalization: "ascii-case-fold",
              },
            }
          : node,
    );
    expect(() => lower(nonStringNormalized)).toThrow(
      "String normalization is supported only for string values.",
    );

    const stringPlan = createComparisonPlan(false);
    const stringFilter = stringPlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const orderedNormalized = withNode(stringPlan, stringFilter.id, (node) =>
      node.kind === "filter"
        ? {
            ...node,
            predicate: {
              ...(node.predicate as LogicalComparisonExpression),
              operator: "gt",
              stringNormalization: "ascii-case-fold",
            },
          }
        : node,
    );
    expect(() => lower(orderedNormalized)).toThrow(
      "ASCII normalization is supported only for equality comparisons.",
    );
  });

  it("rejects forged search and string-normalization contracts", () => {
    const reportPlan = createReportSearchPlan("legacy-report-search-v1");
    const reportFilter = reportPlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const malformedReport = withNode(reportPlan, reportFilter.id, (node) =>
      node.kind === "filter"
        ? {
            ...node,
            predicate: { ...node.predicate, value: " Needle " } as never,
          }
        : node,
    );
    expect(() => lower(malformedReport)).toThrow(
      "The legacy report-search expression is malformed.",
    );

    const recordPlan = createReportSearchPlan("legacy-record-search-v1");
    const recordFilter = recordPlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const malformedRecord = withNode(recordPlan, recordFilter.id, (node) =>
      node.kind === "filter"
        ? {
            ...node,
            predicate: {
              ...node.predicate,
              operator: "starts-with",
            } as never,
          }
        : node,
    );
    expect(() => lower(malformedRecord)).toThrow(
      "The legacy record-search expression is malformed.",
    );

    const normalizationBuilder = createBuilder();
    const stringPages = normalizationBuilder.source("page", {
      attributes: ["page.report.status"],
    });
    const normalized = normalizationBuilder.normalizeString(
      normalizationBuilder.slot(stringPages, "attribute:page.report.status"),
      "trim-ascii-space",
    );
    const normalizedProjection = normalizationBuilder.project(stringPages, {
      value: normalized,
    });
    normalizationBuilder.output("normalized", normalizedProjection, [
      { name: "value", slot: "value" },
    ]);
    const normalizationPlan = normalizationBuilder.finish();
    const invalidMode = withNode(
      normalizationPlan,
      normalizedProjection.id,
      (node) =>
        node.kind === "project"
          ? {
              ...node,
              projections: node.projections.map((projection) =>
                projection.expression.kind === "string-normalize"
                  ? {
                      ...projection,
                      expression: {
                        ...projection.expression,
                        normalization: "ascii-case-fold" as never,
                      },
                    }
                  : projection,
              ),
            }
          : node,
    );
    expect(() => lower(invalidMode)).toThrow(
      "The string normalization mode is unsupported.",
    );

    const numericPlan = createComparisonPlan(true);
    const numericFilter = numericPlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const numericComparison = numericFilter as Extract<
      LogicalNode,
      { kind: "filter" }
    >;
    const nonStringNormalization = withNode(
      numericPlan,
      numericFilter.id,
      (node) =>
        node.kind === "filter"
          ? {
              ...node,
              predicate: {
                kind: "string-normalize",
                input: (
                  numericComparison.predicate as LogicalComparisonExpression
                ).left,
                normalization: "trim-ascii-space",
              } as never,
            }
          : node,
    );
    expect(() => lower(nonStringNormalization)).toThrow(
      "String normalization requires a string scalar value.",
    );

    const nonStringSearch = withNode(numericPlan, numericFilter.id, (node) =>
      node.kind === "filter"
        ? {
            ...node,
            predicate: {
              kind: "string-match",
              operator: "contains",
              input: (
                numericComparison.predicate as LogicalComparisonExpression
              ).left,
              value: "1",
              caseSensitive: true,
            } as never,
          }
        : node,
    );
    expect(() => lower(nonStringSearch)).toThrow(
      "String matching requires a string scalar expression.",
    );
  });

  it("rejects malformed derived page dimensions and entity CASE fallbacks", () => {
    const { plan, projectId, numericSlot } = createPageDimensionPlan();
    const project = plan.nodes.find(
      (node) => node.kind === "project" && node.id === projectId,
    )!;
    if (project.kind !== "project") throw new Error("expected_project_node");
    const dimensionExpression = project.projections[0]!.expression;
    if (dimensionExpression.kind !== "page-dimension")
      throw new Error("expected_page_dimension_expression");

    const missingDependency = withNode(plan, projectId, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "page-dimension"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      dependencies: projection.expression.dependencies.slice(1),
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(missingDependency)).toThrow(
      "Page dimension dependencies do not match its definition.",
    );

    const wrongDependencyType = withNode(plan, projectId, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "page-dimension"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      dependencies: projection.expression.dependencies.map(
                        (dependency) =>
                          dependency.attribute === "page.report.os"
                            ? { ...dependency, expression: numericSlot }
                            : dependency,
                      ),
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(wrongDependencyType)).toThrow(
      "Page dimension dependency has an incompatible scalar type.",
    );

    const caseBuilder = createBuilder();
    const pages = caseBuilder.source("page");
    const caseValue = caseBuilder.caseWhen(
      [
        {
          when: caseBuilder.literal(true, {
            kind: "scalar",
            scalar: "boolean",
          }),
          then: caseBuilder.literal("matched", STRING),
        },
      ],
      caseBuilder.literal("fallback", STRING),
    );
    const projected = caseBuilder.project(pages, { value: caseValue });
    const entityExpression = caseBuilder.slot(pages, "entity").expression;
    caseBuilder.output("case", projected, [{ name: "value", slot: "value" }]);
    const casePlan = caseBuilder.finish();
    const entityCondition = withNode(casePlan, projected.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "case"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      branches: projection.expression.branches.map(
                        (branch) => ({ ...branch, when: entityExpression }),
                      ),
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(entityCondition)).toThrow(
      "CASE conditions must lower to boolean scalar values.",
    );

    const entityBranch = withNode(casePlan, projected.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "case"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      branches: projection.expression.branches.map(
                        (branch) => ({ ...branch, then: entityExpression }),
                      ),
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(entityBranch)).toThrow(
      "CASE branches cannot return entity values.",
    );

    const entityFallback = withNode(casePlan, projected.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "case"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      otherwise: entityExpression,
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(entityFallback)).toThrow(
      "CASE fallback cannot return an entity value.",
    );
  });

  it("rejects invalid scalar, predicate, and time-bucket inputs", () => {
    const absoluteBuilder = createBuilder();
    const absolutePages = absoluteBuilder.source("page", {
      attributes: ["page.report.durationMs", "page.report.status"],
    });
    const absolute = absoluteBuilder.absolute(
      absoluteBuilder.slot(absolutePages, "attribute:page.report.durationMs"),
    );
    const absoluteProjection = absoluteBuilder.project(absolutePages, {
      value: absolute,
    });
    const statusExpression = absoluteBuilder.slot(
      absolutePages,
      "attribute:page.report.status",
    ).expression;
    absoluteBuilder.output("absolute", absoluteProjection, [
      { name: "value", slot: "value" },
    ]);
    const absolutePlan = absoluteBuilder.finish();
    const nonNumericAbsolute = withNode(
      absolutePlan,
      absoluteProjection.id,
      (node) =>
        node.kind === "project"
          ? {
              ...node,
              projections: node.projections.map((projection) =>
                projection.expression.kind === "absolute"
                  ? {
                      ...projection,
                      expression: {
                        ...projection.expression,
                        input: statusExpression,
                      },
                    }
                  : projection,
              ),
            }
          : node,
    );
    expect(() => lower(nonNumericAbsolute)).toThrow(
      "ABS requires a numeric scalar expression.",
    );

    const bucketBuilder = createBuilder();
    const bucketPages = bucketBuilder.source("page", {
      attributes: ["page.report.durationMs", "page.report.status"],
    });
    const bucket = bucketBuilder.timeBucket(
      bucketBuilder.slot(bucketPages, "attribute:page.report.durationMs"),
      "day",
    );
    const bucketProjection = bucketBuilder.project(bucketPages, {
      value: bucket,
    });
    const bucketStringInput = bucketBuilder.slot(
      bucketPages,
      "attribute:page.report.status",
    ).expression;
    bucketBuilder.output("bucket", bucketProjection, [
      { name: "value", slot: "value" },
    ]);
    const bucketPlan = bucketBuilder.finish();
    const nonTemporalBucket = withNode(
      bucketPlan,
      bucketProjection.id,
      (node) =>
        node.kind === "project"
          ? {
              ...node,
              projections: node.projections.map((projection) =>
                projection.expression.kind === "time-bucket"
                  ? {
                      ...projection,
                      expression: {
                        ...projection.expression,
                        input: bucketStringInput,
                      },
                    }
                  : projection,
              ),
            }
          : node,
    );
    expect(() => lower(nonTemporalBucket)).toThrow(
      "Time bucketing requires a temporal or epoch scalar.",
    );

    const wrongZone = withNode(bucketPlan, bucketProjection.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) =>
              projection.expression.kind === "time-bucket"
                ? {
                    ...projection,
                    expression: {
                      ...projection.expression,
                      reportingTimeZone: "Pacific/Honolulu" as never,
                    },
                  }
                : projection,
            ),
          }
        : node,
    );
    expect(() => lower(wrongZone)).toThrow(
      "Time buckets must use the Semantic reporting time zone.",
    );

    const aggregateBuilder = createBuilder();
    const aggregatePages = aggregateBuilder.source("page", {
      attributes: ["page.report.durationMs", "page.report.status"],
    });
    const total = aggregateBuilder.aggregate(aggregatePages, {}, [
      {
        name: "total",
        kind: "sum",
        expression: aggregateBuilder.slot(
          aggregatePages,
          "attribute:page.report.durationMs",
        ),
      },
    ]);
    const aggregateStringInput = aggregateBuilder.slot(
      aggregatePages,
      "attribute:page.report.status",
    ).expression;
    aggregateBuilder.output("total", total, [{ name: "total", slot: "total" }]);
    const aggregatePlan = aggregateBuilder.finish();
    const nonNumericSum = withNode(aggregatePlan, total.id, (node) =>
      node.kind === "aggregate"
        ? {
            ...node,
            measures: node.measures.map((measure) =>
              measure.kind === "sum"
                ? { ...measure, input: aggregateStringInput }
                : measure,
            ),
          }
        : node,
    );
    expect(() => lower(nonNumericSum)).toThrow(
      "SUM and AVG require numeric scalar values.",
    );

    const predicatePlan = createComparisonPlan(false);
    const predicateFilter = predicatePlan.nodes.find(
      (node) => node.kind === "filter",
    )!;
    const textPredicate = withNode(predicatePlan, predicateFilter.id, (node) =>
      node.kind === "filter"
        ? {
            ...node,
            predicate: {
              kind: "literal",
              value: "not-a-predicate",
              valueType: STRING,
            },
          }
        : node,
    );
    expect(() => lower(textPredicate)).toThrow(
      "A relational predicate must lower to an integer expression.",
    );
  });

  it("rejects forged ordered-member group and order slots", () => {
    const { plan, memberId, entitySlot } = createOrderedPlan();
    const member = plan.nodes.find((node) => node.id === memberId)!;

    const invalidGroupType = withNode(plan, memberId, (node) =>
      node.kind === "ordered-member"
        ? {
            ...node,
            groups: [entitySlot as never],
            grain: { kind: "keyed", keys: [entitySlot as never] },
          }
        : node,
    );
    expect(() => lower(invalidGroupType)).toThrow(
      "Ordered-member groups must be scalar values.",
    );

    const scalarMetadataForEntityGroup = withNode(
      withSlotType(plan, entitySlot, { kind: "scalar", scalar: "string" }),
      memberId,
      (node) =>
        node.kind === "ordered-member"
          ? {
              ...node,
              groups: [entitySlot as never],
              grain: { kind: "keyed", keys: [entitySlot as never] },
            }
          : node,
    );
    expect(() => lower(scalarMetadataForEntityGroup)).toThrow(
      "The lowered entity key does not match its Logical slot.",
    );

    const invalidOrderType = withNode(plan, memberId, (node) =>
      node.kind === "ordered-member"
        ? {
            ...node,
            order: [
              {
                slot: entitySlot as never,
                direction: "asc",
                nulls: "first",
              },
            ],
          }
        : node,
    );
    expect(() => lower(invalidOrderType)).toThrow(
      "Ordered-member keys must be scalar values.",
    );

    const scalarMetadataForEntityOrder = withNode(
      withSlotType(plan, entitySlot, { kind: "scalar", scalar: "string" }),
      memberId,
      (node) =>
        node.kind === "ordered-member"
          ? {
              ...node,
              order: [
                {
                  slot: entitySlot as never,
                  direction: "asc",
                  nulls: "first",
                },
              ],
            }
          : node,
    );
    expect(() => lower(scalarMetadataForEntityOrder)).toThrow(
      "The lowered entity key does not match its Logical slot.",
    );

    const emptyGroups = withNode(plan, memberId, (node) =>
      node.kind === "ordered-member" ? { ...node, groups: [] } : node,
    );
    expect(() => lower(emptyGroups)).toThrow(
      "Ordered-member requires groups and order keys.",
    );
    expect(member.kind).toBe("ordered-member");
  });

  it("rechecks ranked-member grain and bucket-index input during lowering", () => {
    const rankedBuilder = createBuilder();
    const pages = rankedBuilder.source("page", {
      attributes: ["page.report.pathname", "page.report.title"],
    });
    const rollup = rankedBuilder.aggregate(
      pages,
      {
        pathname: rankedBuilder.slot(pages, "attribute:page.report.pathname"),
        title: rankedBuilder.slot(pages, "attribute:page.report.title"),
      },
      [{ name: "views", kind: "count-rows" }],
    );
    const ranked = rankedBuilder.rankedMembers(rollup, {
      groups: ["pathname"],
      order: [
        { slot: "views", direction: "desc", nulls: "last" },
        { slot: "title", direction: "asc", nulls: "first" },
      ],
    });
    rankedBuilder.output("ranked", ranked, [
      { name: "pathname", slot: "pathname" },
      { name: "title", slot: "title" },
      { name: "views", slot: "views" },
      { name: "rank", slot: "rank" },
    ]);
    const rankedPlan = rankedBuilder.finish();
    const incompleteRanking = withNode(rankedPlan, ranked.id, (node) =>
      node.kind === "ranked-members"
        ? { ...node, order: [node.order[0]!] }
        : node,
    );
    expect(() => lower(incompleteRanking)).toThrow(
      "Ranked-member keys must cover and preserve input grain.",
    );
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members" ? { ...node, groups: [] } : node,
        ),
      ),
    ).toThrow("Ranked-member keys must cover and preserve input grain.");

    const globalRankBuilder = createBuilder();
    const globalPages = globalRankBuilder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.pathname", "page.report.title"],
    });
    const globalRollup = globalRankBuilder.aggregate(
      globalPages,
      {
        pathname: globalRankBuilder.slot(
          globalPages,
          "attribute:page.report.pathname",
        ),
        title: globalRankBuilder.slot(
          globalPages,
          "attribute:page.report.title",
        ),
      },
      [{ name: "views", kind: "count-rows" }],
    );
    const globalRank = globalRankBuilder.rankedMembers(globalRollup, {
      groups: [],
      order: [
        { slot: "views", direction: "desc", nulls: "last" },
        { slot: "pathname", direction: "asc", nulls: "first" },
        { slot: "title", direction: "asc", nulls: "first" },
      ],
    });
    globalRankBuilder.output("global-ranked", globalRank, [
      { name: "rank", slot: "rank" },
    ]);
    expect(() => lower(globalRankBuilder.finish())).not.toThrow();

    const rankedNode = rankedPlan.nodes.find((node) => node.id === ranked.id);
    if (!rankedNode || rankedNode.kind !== "ranked-members")
      throw new Error("Expected ranked-members node");
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members"
            ? { ...node, input: relationId(-1) }
            : node,
        ),
      ),
    ).toThrow("references a missing node");

    const rollupNode = rankedPlan.nodes.find((node) => node.id === rollup.id);
    if (!rollupNode || rollupNode.kind !== "aggregate")
      throw new Error("Expected aggregate node");
    const grainKey =
      rollupNode.grain.kind === "keyed"
        ? rollupNode.grain.keys[0]!
        : slotId(-1);
    expect(() =>
      lower(
        withNode(rankedPlan, rollup.id, (node) =>
          node.kind === "aggregate"
            ? { ...node, grain: { kind: "keyed", keys: [grainKey, grainKey] } }
            : node,
        ),
      ),
    ).toThrow("unique keyed grain");
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members"
            ? { ...node, groups: [node.groups[0]!, node.groups[0]!] }
            : node,
        ),
      ),
    ).toThrow("grouping and ordering keys are invalid");
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members"
            ? { ...node, groups: [slotId(-1)] }
            : node,
        ),
      ),
    ).toThrow("key is not visible in its input");
    expect(() =>
      lower(
        withSlotType(rankedPlan, rankedNode.groups[0]!, {
          kind: "entity",
          entity: "page",
        }),
      ),
    ).toThrow("Ranked-member keys must be scalar");
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members"
            ? {
                ...node,
                order: [{ ...node.order[0]!, nulls: "middle" as never }],
              }
            : node,
        ),
      ),
    ).toThrow("ordering metadata is invalid");
    expect(() =>
      lower(
        withNode(rankedPlan, ranked.id, (node) =>
          node.kind === "ranked-members"
            ? { ...node, output: [...node.output, node.rankSlot] }
            : node,
        ),
      ),
    ).toThrow("append exactly one new rank slot");
    expect(() =>
      lower(withSlotType(rankedPlan, ranked.slots.rank, STRING)),
    ).toThrow(
      "Rank output must be a new non-null unitless numeric derived slot",
    );

    const withoutRankOutput = {
      ...rankedPlan,
      outputs: rankedPlan.outputs.map((output) => ({
        ...output,
        fields: output.fields.filter(
          (field) => field.slot !== ranked.slots.rank,
        ),
      })),
    } as ValidatedLogicalPlan;
    expect(() => lower(withoutRankOutput)).not.toThrow();

    const bucketBuilder = createBuilder();
    const bucketPages = bucketBuilder.source("page", {
      attributes: ["page.report.startedAt"],
    });
    const bucket = bucketBuilder.timeBucket(
      bucketBuilder.slot(bucketPages, "attribute:page.report.startedAt"),
      "day",
    );
    const bucketIndex = bucketBuilder.bucketIndex(bucket);
    const bucketProjection = bucketBuilder.project(bucketPages, {
      index: bucketIndex,
    });
    bucketBuilder.output("bucket-index", bucketProjection, [
      { name: "index", slot: "index" },
    ]);
    const bucketPlan = bucketBuilder.finish();
    const numericInput = bucketBuilder.literal(0, {
      kind: "scalar",
      scalar: "number",
    }).expression;
    const forgedBucketIndex = withNode(
      bucketPlan,
      bucketProjection.id,
      (node) =>
        node.kind === "project"
          ? {
              ...node,
              projections: node.projections.map((projection) =>
                projection.expression.kind === "bucket-index"
                  ? {
                      ...projection,
                      expression: {
                        ...projection.expression,
                        input: numericInput,
                      },
                    }
                  : projection,
              ),
            }
          : node,
    );
    expect(() => lower(forgedBucketIndex)).toThrow(
      "Bucket-index requires a lowered calendar bucket.",
    );
  });

  it("preserves SQL NULL through a lowered calendar bucket index", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.startedAt"],
    });
    const index = builder.bucketIndex(
      builder.timeBucket(
        builder.slot(pages, "attribute:page.report.startedAt"),
        "minute",
      ),
    );
    const projected = builder.project(pages, { bucketIndex: index });
    builder.output("bucket-index", projected, [
      { name: "bucketIndex", slot: "bucketIndex" },
    ]);
    const plan = builder.finish();
    const output = plan.outputs[0]!;
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_ID,
      time: plan.context.time,
    });
    const lowered = lowerer.lower(output);
    const query = compileD1Query(
      lowerer.projectOutput(
        lowered,
        output.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    );
    const database = createMigratedDatabase();
    try {
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      const sitePk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE_ID) as { readonly site_pk: number }
        ).site_pk,
      );
      database
        .prepare(
          `
          INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'example.test')
        `,
        )
        .run(
          "bucket-index-null",
          SITE_ID,
          sitePk,
          "v1",
          "s1",
          "open",
          60_000,
          60_000,
          "/null",
        );
      const rows = database
        .prepare(query.sql)
        .all(...((query.bindings ?? []) as SQLInputValue[])) as Array<
        Record<string, unknown>
      >;
      expect(rows).toEqual([{ bucketIndex: null }]);
    } finally {
      database.close();
    }
  });

  it("rejects missing, mismatched, and incomplete scalar join keys", () => {
    const { plan, joinId } = createKeyedJoinPlan();
    const joinNode = plan.nodes.find(
      (node) => node.id === joinId && node.kind === "join",
    )!;
    if (joinNode.kind !== "join") throw new Error("expected_join_node");

    const missingInput = withNode(plan, joinId, (node) =>
      node.kind === "join" ? { ...node, right: 999 as never } : node,
    );
    expect(() => lower(missingInput)).toThrow(
      "The relation references a missing node.",
    );

    const rightKey = joinNode.keys[0]!.right;
    const mismatchedKeyType = withSlotType(plan, rightKey, {
      kind: "scalar",
      scalar: "string",
    });
    const numericKeyPlan = {
      ...mismatchedKeyType,
      slots: mismatchedKeyType.slots.map((slot) =>
        slot.id === rightKey
          ? { ...slot, type: { kind: "scalar", scalar: "number" } }
          : slot,
      ),
    } as ValidatedLogicalPlan;
    expect(() => lower(numericKeyPlan)).toThrow(
      "Keyed joins require matching scalar or bucket key types.",
    );

    const incompleteGrain = withNode(plan, joinId, (node) =>
      node.kind === "join" ? { ...node, keys: node.keys.slice(0, 1) } : node,
    );
    expect(() => lower(incompleteGrain)).toThrow(
      "Join keys must cover the complete scalar or bucket right grain.",
    );
  });

  it("lowers the empty string sentinel as a typed constant while preserving NULL and bound text", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.localId", "page.report.status"],
    });
    const status = builder.slot(pages, "attribute:page.report.status");
    const projected = builder.project(pages, {
      localId: builder.slot(pages, "attribute:page.report.localId"),
      status,
      emptySentinel: builder.literal("", STRING),
      nullableValue: builder.literal(null, STRING),
      userText: builder.literal("bounded-user-text", STRING),
      isEmpty: builder.compare("eq", status, builder.literal("", STRING)),
    });
    const sorted = builder.sort(projected, [
      { slot: "localId", direction: "asc", nulls: "first" },
    ]);
    builder.output("literal-sentinels", sorted, [
      { name: "localId", slot: "localId" },
      { name: "status", slot: "status" },
      { name: "emptySentinel", slot: "emptySentinel" },
      { name: "nullableValue", slot: "nullableValue" },
      { name: "userText", slot: "userText" },
      { name: "isEmpty", slot: "isEmpty" },
    ]);
    const plan = builder.finish();
    const output = plan.outputs[0]!;
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_ID,
      time: plan.context.time,
    });
    const lowered = lowerer.lower(output);
    const query = compileD1Query(
      lowerer.projectOutput(
        lowered,
        output.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    );
    const bindings = (query.bindings ?? []) as SQLInputValue[];
    expect(bindings).not.toContain("");
    expect(bindings).not.toContain(null);
    expect(bindings).toContain("bounded-user-text");

    const database = createMigratedDatabase();
    try {
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      const sitePk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE_ID) as { readonly site_pk: number }
        ).site_pk,
      );
      const insert = database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'example.test')
      `);
      insert.run(
        "literal-open",
        SITE_ID,
        sitePk,
        "v1",
        "s1",
        "open",
        10,
        10,
        "/open",
      );
      insert.run(
        "literal-empty",
        SITE_ID,
        sitePk,
        "v2",
        "s2",
        "",
        11,
        11,
        "/empty",
      );
      const rows = database.prepare(query.sql).all(...bindings) as Array<
        Record<string, unknown>
      >;
      expect(rows).toEqual([
        {
          localId: "literal-empty",
          status: "",
          emptySentinel: "",
          nullableValue: null,
          userText: "bounded-user-text",
          isEmpty: 1,
        },
        {
          localId: "literal-open",
          status: "open",
          emptySentinel: "",
          nullableValue: null,
          userText: "bounded-user-text",
          isEmpty: 0,
        },
      ]);
    } finally {
      database.close();
    }
  });
});
