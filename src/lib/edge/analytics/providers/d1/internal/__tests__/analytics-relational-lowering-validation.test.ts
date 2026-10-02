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
