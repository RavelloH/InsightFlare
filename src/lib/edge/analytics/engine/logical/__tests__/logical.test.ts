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
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function createBuilder(): LogicalPlanBuilder {
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
    scope: resolveAnalyticsScope("auto"),
  });
}

function booleanLiteral(builder: LogicalPlanBuilder, value: boolean) {
  return builder.literal(value, { kind: "scalar", scalar: "boolean" });
}

describe("logical relational IR", () => {
  it("preserves hidden entity grain through projections and serializes as data", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.path", "page.durationMs"],
      relationships: ["page.session"],
      includeOccurrenceTime: true,
    });
    const duration = builder.slot(pages, "attribute:page.durationMs");
    const filtered = builder.filter(
      pages,
      builder.compare(
        "gte",
        duration,
        builder.literal(0, { kind: "scalar", scalar: "number", unit: "ms" }),
      ),
    );
    const projected = builder.project(filtered, {
      path: builder.slot(filtered, "attribute:page.path"),
    });
    expect(projected.entityKey).toBeDefined();
    expect(projected.slots.$grain0).toBe(projected.entityKey);

    const aggregate = builder.aggregate(
      projected,
      { path: builder.slot(projected, "path") },
      [{ name: "pageCount", kind: "count-rows" }],
    );
    builder.output("paths", aggregate, [
      {
        name: "path",
        slot: "path",
        semantic: { kind: "dimension", id: "page.path" },
      },
      {
        name: "views",
        slot: "pageCount",
        semantic: { kind: "metric", id: "views" },
      },
    ]);
    const plan = builder.finish();

    expect(plan.nodes.map((node) => node.kind)).toEqual([
      "source",
      "filter",
      "project",
      "aggregate",
    ]);
    expect(
      validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan),
    ).toEqual(plan);
    expect(printLogicalPlan(plan)).toBe(printLogicalPlan(plan));
    expect(printLogicalPlan(plan)).toContain("domain=candidate");
    expect(printLogicalPlan(plan)).toContain("Aggregate grain=Keyed");
  });

  it("supports entity distinct, set operations, membership joins, unique joins, sort, and limit", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      relationships: ["page.session"],
    });
    const sessionA = builder.source("session");
    const sessionB = builder.source("session");
    const sessions = builder.setOperation("union", [sessionA, sessionB]);
    const distinctSessions = builder.distinctEntity(
      pages,
      "relationship:page.session",
      "session",
    );
    const eligiblePages = builder.semiJoin(pages, distinctSessions, [
      { left: "relationship:page.session", right: "session" },
    ]);
    const excludedPages = builder.antiJoin(pages, distinctSessions, [
      { left: "relationship:page.session", right: "session" },
    ]);
    const enriched = builder.join(
      eligiblePages,
      distinctSessions,
      [{ left: "relationship:page.session", right: "session" }],
      "left",
    );
    expect(enriched.slots["right.session"]).toBeDefined();

    const scalarViews = builder.aggregate(eligiblePages, {}, [
      { name: "views", kind: "count-rows" },
    ]);
    const scalarSessions = builder.aggregate(sessions, {}, [
      { name: "sessions", kind: "count-rows" },
    ]);
    const scalarMetrics = builder.join(scalarViews, scalarSessions, []);
    const sorted = builder.sort(enriched, [
      { slot: "relationship:page.session", direction: "asc", nulls: "last" },
    ]);
    const limited = builder.limit(sorted, 25);
    builder.output("sample", limited, [
      { name: "page", slot: "entity" },
      { name: "session", slot: "right.session" },
    ]);
    builder.output("counts", scalarMetrics, [
      { name: "views", slot: "views" },
      { name: "sessions", slot: "right.sessions" },
    ]);
    builder.output("excluded", excludedPages, [
      { name: "page", slot: "entity" },
    ]);
    const plan = builder.finish();

    expect(plan.nodes.some((node) => node.kind === "set-operation")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "semi-join")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "anti-join")).toBe(true);
    const leftJoin = plan.nodes.find(
      (node) => node.kind === "join" && node.joinType === "left",
    );
    expect(leftJoin?.kind === "join" ? leftJoin.rightAliases.length : 0).toBe(
      1,
    );
    expect(plan.nodes.some((node) => node.kind === "sort")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "limit")).toBe(true);
  });

  it("rejects entity-type mismatches, invalid attributes, and non-unique joins early", () => {
    const builder = createBuilder();
    const session = builder.source("session");
    const visitor = builder.source("visitor");
    expect(() =>
      builder.compare(
        "eq",
        builder.slot(session, "entity"),
        builder.slot(visitor, "entity"),
      ),
    ).toThrow("Expression operand types are incompatible");
    expect(() =>
      builder.source("session", { attributes: ["page.path"] }),
    ).toThrow("logical_source_invalid_attribute");
    const pages = builder.source("page");
    expect(() => builder.join(pages, session, [])).toThrow(
      "logical_builder_join_requires_keys",
    );
  });

  it("independently rejects forged forward references, wrong predicates, and unknown output slots", () => {
    const builder = createBuilder();
    const pages = builder.source("page");
    const filtered = builder.filter(pages, booleanLiteral(builder, true));
    builder.output("pages", filtered, [{ name: "page", slot: "entity" }]);
    const plan = builder.finish();
    const filterIndex = plan.nodes.findIndex((node) => node.kind === "filter");
    const filterNode = plan.nodes[filterIndex]!;
    if (filterNode.kind !== "filter")
      throw new Error("filter_fixture_expected");

    const forwardReference: LogicalPlan = {
      ...plan,
      nodes: [...plan.nodes].reverse(),
    };
    expect(() => validateLogicalPlan(forwardReference)).toThrow(
      "must appear earlier",
    );

    const nonBooleanFilter: LogicalPlan = {
      ...plan,
      nodes: plan.nodes.map((node, index) =>
        index === filterIndex && node.kind === "filter"
          ? { ...node, predicate: { kind: "slot", slot: pages.entityKey! } }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(nonBooleanFilter)).toThrow(
      "Filter predicate must be boolean",
    );

    const unknownOutput: LogicalPlan = {
      ...plan,
      outputs: [
        {
          ...plan.outputs[0]!,
          fields: [{ name: "missing", slot: slotId(999) }],
        },
      ],
    };
    expect(() => validateLogicalPlan(unknownOutput)).toThrow(
      "is not visible from this relation",
    );
  });

  it("rejects forged IDs, source bindings, grains, joins, set schemas, and foreign aggregate slots", () => {
    const duplicateBuilder = createBuilder();
    const duplicateSource = duplicateBuilder.source("page", {
      attributes: ["page.path"],
    });
    duplicateBuilder.filter(
      duplicateSource,
      booleanLiteral(duplicateBuilder, true),
    );
    const duplicatePlan = duplicateBuilder.finish();
    const duplicateRelation: LogicalPlan = {
      ...duplicatePlan,
      nodes: duplicatePlan.nodes.map((node, index) =>
        index === 1 ? { ...node, id: duplicatePlan.nodes[0]!.id } : node,
      ),
    };
    expect(() => validateLogicalPlan(duplicateRelation)).toThrow(
      "Logical relation IDs must be unique",
    );
    const duplicateSlot: LogicalPlan = {
      ...duplicatePlan,
      slots: duplicatePlan.slots.map((item, index) =>
        index === 1 ? { ...item, id: duplicatePlan.slots[0]!.id } : item,
      ),
    };
    expect(() => validateLogicalPlan(duplicateSlot)).toThrow(
      "Logical slot IDs must be unique",
    );

    const sourceBuilder = createBuilder();
    const source = sourceBuilder.source("page", {
      attributes: ["page.path"],
    });
    const sourcePlan = sourceBuilder.finish();
    const sourceNode = sourcePlan.nodes[0]!;
    if (sourceNode.kind !== "source")
      throw new Error("source_fixture_expected");
    const wrongAttribute: LogicalPlan = {
      ...sourcePlan,
      nodes: [
        {
          ...sourceNode,
          values: sourceNode.values.map((binding) =>
            binding.kind === "attribute"
              ? { ...binding, attribute: "session.durationMs" }
              : binding,
          ),
        },
      ],
    };
    expect(() => validateLogicalPlan(wrongAttribute)).toThrow(
      "Attribute is not available on this source entity",
    );

    const invalidTime: LogicalPlan = {
      ...sourcePlan,
      nodes: [{ ...sourceNode, temporalDomain: "archive" as never }],
    };
    expect(() => validateLogicalPlan(invalidTime)).toThrow(
      "Source temporal domain is invalid",
    );

    const wrongGrain: LogicalPlan = {
      ...sourcePlan,
      nodes: [{ ...sourceNode, grain: { kind: "scalar" } }],
    };
    expect(() => validateLogicalPlan(wrongGrain)).toThrow(
      "Declared grain does not match node semantics",
    );

    const nullableEntityKey: LogicalPlan = {
      ...sourcePlan,
      slots: sourcePlan.slots.map((item) =>
        item.id === source.entityKey ? { ...item, nullable: true } : item,
      ),
    };
    expect(() => validateLogicalPlan(nullableEntityKey)).toThrow(
      "Self binding must be a non-null entity slot",
    );

    const setBuilder = createBuilder();
    const left = setBuilder.source("session");
    const right = setBuilder.source("session");
    setBuilder.setOperation("union", [left, right]);
    const setPlan = setBuilder.finish();
    const invalidSet: LogicalPlan = {
      ...setPlan,
      nodes: setPlan.nodes.map((node) =>
        node.id === right.id && node.kind === "source"
          ? {
              ...node,
              entity: "visitor",
              grain: {
                kind: "entity",
                entity: "visitor",
                key: right.entityKey!,
              },
            }
          : node,
      ),
      slots: setPlan.slots.map((item) =>
        item.id === right.entityKey
          ? {
              ...item,
              type: { kind: "entity", entity: "visitor" },
              lineage: { kind: "entity", entity: "visitor" },
            }
          : item,
      ),
    };
    expect(() => validateLogicalPlan(invalidSet)).toThrow(
      "Set inputs must have compatible output and grain shapes",
    );

    const joinBuilder = createBuilder();
    const pages = joinBuilder.source("page", {
      relationships: ["page.session"],
    });
    const sessions = joinBuilder.source("session");
    joinBuilder.join(
      pages,
      sessions,
      [{ left: "relationship:page.session", right: "entity" }],
      "left",
    );
    const joinPlan = joinBuilder.finish();
    const invalidJoin: LogicalPlan = {
      ...joinPlan,
      nodes: joinPlan.nodes.map((node) =>
        node.kind === "join" ? { ...node, keys: [] } : node,
      ),
    };
    expect(() => validateLogicalPlan(invalidJoin)).toThrow(
      "Join keys do not cover right grain",
    );

    const aggregateBuilder = createBuilder();
    const aggregatePages = aggregateBuilder.source("page");
    const foreignSessions = aggregateBuilder.source("session");
    aggregateBuilder.aggregate(aggregatePages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    const aggregatePlan = aggregateBuilder.finish();
    const invalidAggregate: LogicalPlan = {
      ...aggregatePlan,
      nodes: aggregatePlan.nodes.map((node) =>
        node.kind === "aggregate"
          ? {
              ...node,
              measures: [
                {
                  kind: "count-distinct",
                  input: { kind: "slot", slot: foreignSessions.entityKey! },
                  output: node.measures[0]!.output,
                },
              ],
            }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(invalidAggregate)).toThrow(
      "is not visible from this relation",
    );

    const entityCompareBuilder = createBuilder();
    const comparisonInput = entityCompareBuilder.source("page", {
      relationships: ["page.session", "page.visitor"],
    });
    const compareFilter = entityCompareBuilder.filter(
      comparisonInput,
      booleanLiteral(entityCompareBuilder, true),
    );
    entityCompareBuilder.output("session", compareFilter, [
      { name: "page", slot: "entity" },
    ]);
    const comparePlan = entityCompareBuilder.finish();
    const forgedEntityCompare: LogicalPlan = {
      ...comparePlan,
      nodes: comparePlan.nodes.map((node) =>
        node.kind === "filter"
          ? {
              ...node,
              predicate: {
                kind: "comparison",
                operator: "eq",
                left: {
                  kind: "slot",
                  slot: comparisonInput.slots["relationship:page.session"]!,
                },
                right: {
                  kind: "slot",
                  slot: comparisonInput.slots["relationship:page.visitor"]!,
                },
              },
            }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedEntityCompare)).toThrow(
      "Expression operand types are incompatible",
    );
  });
});
