import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  type LogicalPlan,
  LogicalPlanBuilder,
  printLogicalPlan,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { ResolvedAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function createBuilder(
  scope: ResolvedAnalyticsScope = resolveAnalyticsScope("auto"),
): LogicalPlanBuilder {
  const candidate = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 10_000 as EpochMs,
  };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate,
      read: { kind: "bounded", range: candidate },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 10_000 as EpochMs,
    }),
    scope,
  });
}

function pageInput(builder: LogicalPlanBuilder) {
  return builder.source("page", {
    attributes: [
      "page.report.sessionId",
      "page.report.startedAt",
      "page.report.localId",
      "page.report.status",
      "page.report.userId",
      "page.report.durationMs",
      "page.report.screenWidth",
    ],
  });
}

function orderedPlan() {
  const builder = createBuilder();
  const pages = pageInput(builder);
  const member = builder.orderedMember(pages, {
    groups: ["attribute:page.report.sessionId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction: "asc",
        nulls: "last",
      },
      {
        slot: "attribute:page.report.localId",
        direction: "asc",
        nulls: "last",
      },
    ],
  });
  builder.output("member", member, [
    { name: "sessionId", slot: "attribute:page.report.sessionId" },
    { name: "startedAt", slot: "attribute:page.report.startedAt" },
  ]);
  return { builder, pages, member, plan: builder.finish() };
}

describe("logical ordered-member and scalar keyed joins", () => {
  it("keeps the complete member row while declaring the requested group grain", () => {
    const { pages, member, plan } = orderedPlan();
    const source = plan.nodes.find((node) => node.id === pages.id)!;
    const selection = plan.nodes.find((node) => node.id === member.id);

    expect(selection).toMatchObject({
      kind: "ordered-member",
      groups: [pages.slots["attribute:page.report.sessionId"]],
      grain: {
        kind: "keyed",
        keys: [pages.slots["attribute:page.report.sessionId"]],
      },
    });
    expect(selection?.output).toEqual(source.output);
    expect(member.temporalDomains).toEqual(pages.temporalDomains);
    const printed = printLogicalPlan(plan);
    expect(printed).toContain("OrderedMember");
    expect(printed).toContain("  GROUP ");
    expect(printed).toContain("  ORDER ");
    expect(
      validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan),
    ).toEqual(plan);
  });

  it("rejects empty, duplicate, invisible, and entity selection keys", () => {
    const builder = createBuilder();
    const pages = pageInput(builder);
    expect(() =>
      builder.orderedMember(pages, { groups: [], order: [] }),
    ).toThrow("logical_builder_ordered_member_requires_groups");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [],
      }),
    ).toThrow("logical_builder_ordered_member_requires_order");
    expect(() =>
      builder.orderedMember(pages, {
        groups: [
          "attribute:page.report.sessionId",
          "attribute:page.report.sessionId",
        ],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "asc",
            nulls: "last",
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_duplicate_group");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["missing"],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "asc",
            nulls: "last",
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_group_not_visible");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["entity"],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "asc",
            nulls: "last",
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_requires_scalar_slots");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "asc",
            nulls: "last",
          },
          {
            slot: "attribute:page.report.startedAt",
            direction: "desc",
            nulls: "first",
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_duplicate_order_key");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [{ slot: "missing", direction: "asc", nulls: "first" }],
      }),
    ).toThrow("logical_builder_ordered_member_order_not_visible");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [{ slot: "entity", direction: "asc", nulls: "first" }],
      }),
    ).toThrow("logical_builder_ordered_member_requires_scalar_slots");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "sideways" as never,
            nulls: "first",
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_invalid_direction");
    expect(() =>
      builder.orderedMember(pages, {
        groups: ["attribute:page.report.sessionId"],
        order: [
          {
            slot: "attribute:page.report.startedAt",
            direction: "asc",
            nulls: "middle" as never,
          },
        ],
      }),
    ).toThrow("logical_builder_ordered_member_invalid_nulls");
  });

  it("validates ordered-member scope, output, grain, and sort metadata", () => {
    const { plan, pages, member } = orderedPlan();
    const selectionIndex = plan.nodes.findIndex(
      (node) => node.kind === "ordered-member",
    );
    const selection = plan.nodes[selectionIndex]!;

    const forgedInput = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === selectionIndex && node.kind === "ordered-member"
          ? { ...node, input: slotId(999) as never }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedInput as LogicalPlan)).toThrow(
      "must appear earlier",
    );

    const forgedOutput = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === selectionIndex
          ? { ...node, output: [member.slots.entity] }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedOutput as LogicalPlan)).toThrow(
      "Node output does not match derived visible slots",
    );

    const forgedGrain = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === selectionIndex && node.kind === "ordered-member"
          ? { ...node, grain: { kind: "keyed", keys: [pages.entityKey!] } }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedGrain as LogicalPlan)).toThrow(
      "Declared grain does not match node semantics",
    );

    const forgedKey = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === selectionIndex && node.kind === "ordered-member"
          ? { ...node, groups: [slotId(999)] }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedKey as LogicalPlan)).toThrow(
      "is not visible from this relation",
    );

    const sessionSlot = pages.slots["attribute:page.report.sessionId"];
    const forgedMetadata = {
      ...plan,
      slots: plan.slots.map((slot) =>
        slot.id === sessionSlot
          ? {
              ...slot,
              type: { kind: "scalar", scalar: "number" },
              lineage: { kind: "derived", operation: "forged", inputs: [] },
            }
          : slot,
      ),
    };
    expect(() => validateLogicalPlan(forgedMetadata as LogicalPlan)).toThrow(
      "Attribute slot metadata differs from the semantic catalog",
    );

    const forgedOrder = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === selectionIndex && node.kind === "ordered-member"
          ? {
              ...node,
              order: [
                {
                  ...node.order[0]!,
                  direction: "sideways" as never,
                },
              ],
            }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedOrder as LogicalPlan)).toThrow(
      "Ordered member direction is invalid",
    );
  });

  it("allows explicit string equality modes only on string eq/neq comparisons", () => {
    const builder = createBuilder();
    const pages = pageInput(builder);
    const status = builder.slot(pages, "attribute:page.report.status");
    const text = (value: string) =>
      builder.literal(value, { kind: "scalar", scalar: "string" });

    const trimmed = builder.compare(
      "neq",
      status,
      text(""),
      "trim-ascii-space",
    );
    const folded = builder.compare(
      "eq",
      status,
      text("open"),
      "ascii-case-fold",
    );
    const oldTrim = builder.compare("eq", status, text("open"), "trim");
    const oldFold = builder.compare(
      "eq",
      status,
      text("open"),
      "trim-case-fold",
    );
    for (const predicate of [trimmed, folded, oldTrim, oldFold]) {
      const filtered = builder.filter(pages, predicate);
      builder.output(`comparison-${filtered.id}`, filtered, [
        { name: "session", slot: "attribute:page.report.sessionId" },
      ]);
    }
    expect(() => builder.finish()).not.toThrow();

    expect(() =>
      builder.compare("gt", status, text(""), "ascii-case-fold"),
    ).toThrow("supported only for equality comparisons");
    expect(() =>
      builder.compare(
        "eq",
        builder.slot(pages, "attribute:page.report.durationMs"),
        builder.literal(1, { kind: "scalar", scalar: "number", unit: "ms" }),
        "trim-ascii-space",
      ),
    ).toThrow("requires string scalar operands");
    expect(() =>
      builder.compare("eq", status, text("open"), "full-unicode-fold" as never),
    ).toThrow("String normalization mode is invalid");
    expect(() =>
      builder.in(status, [text("open")], false, "ascii-case-fold"),
    ).toThrow("String normalization mode is invalid");
    expect(() =>
      builder.stringMatch(
        "contains",
        status,
        "OPEN",
        false,
        "trim-ascii-space",
      ),
    ).toThrow("String normalization mode is invalid");
  });

  it("proves complete scalar keyed joins and nullable left aliases", () => {
    const builder = createBuilder();
    const pages = pageInput(builder);
    const candidates = pageInput(builder);
    const right = builder.aggregate(
      candidates,
      {
        session: builder.slot(candidates, "attribute:page.report.sessionId"),
        started: builder.slot(candidates, "attribute:page.report.startedAt"),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    const joined = builder.join(
      pages,
      right,
      [
        {
          left: "attribute:page.report.sessionId",
          right: "session",
        },
        {
          left: "attribute:page.report.startedAt",
          right: "started",
        },
      ],
      "left",
    );
    const plan = builder.finish();
    const rightSlotIds = Object.entries(joined.slots)
      .filter(([name]) => name.startsWith("right."))
      .map(([, id]) => id);
    const aliases = rightSlotIds.map((id) =>
      plan.slots.find((slot) => slot.id === id),
    );
    expect(aliases.every((slot) => slot?.nullable)).toBe(true);
    const joinNode = plan.nodes.find((node) => node.kind === "join");
    expect(joinNode).toMatchObject({
      joinType: "left",
      keys: expect.any(Array),
    });
    expect(
      validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan),
    ).toEqual(plan);

    const partialBuilder = createBuilder();
    const left = pageInput(partialBuilder);
    const source = pageInput(partialBuilder);
    const grouped = partialBuilder.aggregate(
      source,
      {
        session: partialBuilder.slot(source, "attribute:page.report.sessionId"),
        started: partialBuilder.slot(source, "attribute:page.report.startedAt"),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    expect(() =>
      partialBuilder.join(left, grouped, [
        {
          left: "attribute:page.report.sessionId",
          right: "session",
        },
      ]),
    ).toThrow("logical_builder_join_keys_do_not_cover_right_grain");

    const unitBuilder = createBuilder();
    const unitLeft = pageInput(unitBuilder);
    const unitSource = pageInput(unitBuilder);
    const durationGrouped = unitBuilder.aggregate(
      unitSource,
      {
        duration: unitBuilder.slot(
          unitSource,
          "attribute:page.report.durationMs",
        ),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    expect(() =>
      unitBuilder.join(unitLeft, durationGrouped, [
        {
          left: "attribute:page.report.screenWidth",
          right: "duration",
        },
      ]),
    ).toThrow("logical_builder_join_key_type_mismatch");
  });

  it("preserves scalar cross-join and entity-key joins without entity keyed widening", () => {
    const builder = createBuilder();
    const pages = pageInput(builder);
    const scalarA = builder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    const scalarB = builder.aggregate(pageInput(builder), {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    expect(() => builder.join(scalarA, scalarB, [], "inner")).not.toThrow();

    const pageWithSession = builder.source("page", {
      relationships: ["page.session"],
    });
    const session = builder.source("session");
    expect(() =>
      builder.join(pageWithSession, session, [
        { left: "relationship:page.session", right: "entity" },
      ]),
    ).not.toThrow();

    const groupedInput = builder.source("page", {
      relationships: ["page.session"],
    });
    const entityGrouped = builder.aggregate(
      groupedInput,
      {
        session: builder.slot(groupedInput, "relationship:page.session"),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    expect(() =>
      builder.join(pageWithSession, entityGrouped, [
        {
          left: "relationship:page.session",
          right: "session",
        },
      ]),
    ).toThrow("logical_builder_join_keyed_grain_requires_scalar_keys");
  });

  it("rejects forged incomplete keyed-join proof and invalid left aliases", () => {
    const builder = createBuilder();
    const left = pageInput(builder);
    const source = pageInput(builder);
    const right = builder.aggregate(
      source,
      {
        session: builder.slot(source, "attribute:page.report.sessionId"),
        started: builder.slot(source, "attribute:page.report.startedAt"),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    builder.join(
      left,
      right,
      [
        {
          left: "attribute:page.report.sessionId",
          right: "session",
        },
        {
          left: "attribute:page.report.startedAt",
          right: "started",
        },
      ],
      "left",
    );
    const plan = builder.finish();
    const invalidCoverage = {
      ...plan,
      nodes: plan.nodes.map((node) =>
        node.kind === "join" ? { ...node, keys: node.keys.slice(0, 1) } : node,
      ),
    };
    expect(() => validateLogicalPlan(invalidCoverage as LogicalPlan)).toThrow(
      "Join keys do not cover right grain",
    );

    const join = plan.nodes.find((node) => node.kind === "join");
    expect(join?.kind).toBe("join");
    if (join?.kind !== "join") return;
    const alias = join.rightAliases[0]!;
    const invalidAlias: LogicalPlan = {
      ...plan,
      slots: plan.slots.map((slot) =>
        slot.id === alias.alias ? { ...slot, nullable: false } : slot,
      ),
    };
    expect(() => validateLogicalPlan(invalidAlias)).toThrow(
      "nullable aliases of source slots",
    );

    const invalidAliasLineage: LogicalPlan = {
      ...plan,
      slots: plan.slots.map((slot) =>
        slot.id === alias.alias
          ? {
              ...slot,
              lineage: { kind: "derived", operation: "forged", inputs: [] },
            }
          : slot,
      ),
    };
    expect(() => validateLogicalPlan(invalidAliasLineage)).toThrow(
      "nullable aliases of source slots",
    );
  });
});
