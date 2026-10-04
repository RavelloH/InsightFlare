import { describe, expect, it } from "vitest";

import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalComparisonExpression } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
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
});
