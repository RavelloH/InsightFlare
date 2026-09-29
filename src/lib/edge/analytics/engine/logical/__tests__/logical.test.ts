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
import {
  type LogicalExpr,
  scalarLiteral,
} from "@/lib/edge/analytics/engine/logical/expression";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import {
  entityValueType,
  isSameLogicalValueType,
  type LogicalValueType,
} from "@/lib/edge/analytics/engine/logical/slots";
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

function planWithForgedFilter(predicate: LogicalExpr): LogicalPlan {
  const builder = createBuilder();
  const pages = builder.source("page", {
    attributes: ["page.path", "page.durationMs"],
    includeOccurrenceTime: true,
  });
  const filtered = builder.filter(pages, booleanLiteral(builder, true));
  builder.output("pages", filtered, [{ name: "page", slot: "entity" }]);
  const plan = builder.finish();
  return {
    ...plan,
    nodes: plan.nodes.map((node) =>
      node.kind === "filter" ? { ...node, predicate } : node,
    ),
  };
}

describe("logical relational IR", () => {
  it("provides data-only logical scalar and entity values", () => {
    expect(entityValueType("session")).toEqual({
      kind: "entity",
      entity: "session",
    });
    expect(
      isSameLogicalValueType(
        { kind: "bucket" },
        { kind: "scalar", scalar: "number" },
      ),
    ).toBe(false);
    expect(scalarLiteral("/pricing", "string")).toEqual({
      kind: "literal",
      value: "/pricing",
      valueType: { kind: "scalar", scalar: "string" },
    });
  });

  it("authors typed scalar, boolean, case, and time expressions", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.path", "page.durationMs"],
      includeOccurrenceTime: true,
    });
    const path = builder.slot(pages, "attribute:page.path");
    const duration = builder.slot(pages, "attribute:page.durationMs");
    const contains = builder.stringMatch("contains", path, "docs", true);
    const membership = builder.in(
      path,
      [
        builder.literal("/docs", { kind: "scalar", scalar: "string" }),
        builder.literal("/reference", {
          kind: "scalar",
          scalar: "string",
        }),
      ],
      true,
    );
    const isMissing = builder.isNull(duration);
    const predicate = builder.or(
      builder.and(contains, membership),
      builder.not(isMissing),
    );
    const millisecond = builder.literal(1, {
      kind: "scalar",
      scalar: "number",
      unit: "ms",
    });
    const scalar = builder.literal(2, {
      kind: "scalar",
      scalar: "number",
    });
    const bucket = builder.timeBucket(builder.slot(pages, "time"), "day");
    const sameBucket = builder.compare(
      "eq",
      bucket,
      builder.timeBucket(builder.slot(pages, "time"), "day"),
    );
    const projected = builder.project(pages, {
      predicate,
      sameBucket,
      added: builder.arithmetic("add", duration, millisecond),
      subtracted: builder.arithmetic("subtract", duration, millisecond),
      multiplied: builder.round(
        builder.arithmetic("multiply", duration, scalar),
      ),
      divided: builder.arithmetic("divide", duration, duration),
      coalesced: builder.coalesce(
        duration,
        builder.literal(null, {
          kind: "scalar",
          scalar: "number",
          unit: "ms",
        }),
      ),
      conditional: builder.caseWhen(
        [{ when: contains, then: duration }],
        duration,
      ),
    });
    builder.output(
      "expressions",
      projected,
      Object.keys(projected.slots)
        .filter((name) => !name.startsWith("$grain"))
        .map((name) => ({ name, slot: name })),
    );

    const plan = builder.finish();
    expect(plan.nodes.some((node) => node.kind === "project")).toBe(true);
    expect(plan.outputs[0]?.fields.map((field) => field.name)).toEqual([
      "predicate",
      "sameBucket",
      "added",
      "subtracted",
      "multiplied",
      "divided",
      "coalesced",
      "conditional",
    ]);
    const printed = printLogicalPlan(plan);
    expect(printed).toContain("NOT IN [");
    expect(printed).toContain("TIME_BUCKET");
  });

  it("independently rejects forged expressions with invalid scalar semantics", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.path", "page.durationMs"],
      includeOccurrenceTime: true,
    });
    const path = pages.slots["attribute:page.path"]!;
    const duration = pages.slots["attribute:page.durationMs"]!;
    const number = { kind: "scalar", scalar: "number" } as const;
    const milliseconds = { ...number, unit: "ms" } as const;
    const string = { kind: "scalar", scalar: "string" } as const;
    const literal = (
      value: string | number | boolean | null,
      valueType: Extract<LogicalValueType, { kind: "scalar" }>,
    ) =>
      ({
        kind: "literal",
        value,
        valueType,
      }) as LogicalExpr;
    const slot = (id: typeof path) =>
      ({ kind: "slot", slot: id }) as LogicalExpr;
    const badExpressions: LogicalExpr[] = [
      literal(Number.POSITIVE_INFINITY, number),
      {
        kind: "comparison",
        operator: "gt",
        left: slot(pages.slots.entity!),
        right: slot(pages.slots.entity!),
      },
      { kind: "boolean", operator: "and", terms: [] },
      {
        kind: "boolean",
        operator: "or",
        terms: [literal(1, number)],
      },
      { kind: "not", input: slot(duration) },
      {
        kind: "set-membership",
        input: slot(duration),
        values: [{ kind: "literal", value: 1, valueType: number }],
        negated: false,
      },
      {
        kind: "string-match",
        operator: "contains",
        input: slot(duration),
        value: "1",
        caseSensitive: false,
      },
      {
        kind: "arithmetic",
        operator: "divide",
        left: slot(duration),
        right: slot(duration),
      },
      {
        kind: "arithmetic",
        operator: "add",
        left: slot(duration),
        right: slot(path),
      },
      {
        kind: "arithmetic",
        operator: "multiply",
        left: literal(2, milliseconds),
        right: literal(3, milliseconds),
      },
      {
        kind: "arithmetic",
        operator: "divide",
        zeroDenominator: "null",
        left: literal(2, milliseconds),
        right: literal(1, { ...number, unit: "px" }),
      },
      {
        kind: "arithmetic",
        operator: "divide",
        zeroDenominator: "null",
        left: literal(2, number),
        right: literal(1, milliseconds),
      },
      { kind: "round", input: slot(path) },
      { kind: "coalesce", values: [] },
      {
        kind: "coalesce",
        values: [literal(1, milliseconds), literal(2, number)],
      },
      {
        kind: "case",
        branches: [{ when: literal(1, number), then: literal(1, number) }],
        otherwise: literal(2, number),
      },
      {
        kind: "case",
        branches: [
          {
            when: booleanLiteral(builder, true).expression,
            then: literal(1, number),
          },
        ],
        otherwise: literal("other", string),
      },
      {
        kind: "time-bucket",
        input: slot(path),
        granularity: "day",
        reportingTimeZone: "UTC" as ReportingTimeZone,
      },
    ];
    for (const expression of badExpressions) {
      expect(() =>
        validateLogicalPlan(planWithForgedFilter(expression)),
      ).toThrow();
    }
  });

  it("rejects invalid builder inputs at the boundary", () => {
    const builder = createBuilder();
    expect(() => builder.source("page", { temporalDomain: "filter" })).toThrow(
      "logical_source_invalid_temporal_domain",
    );
    expect(() =>
      builder.source("session", { relationships: ["page.session"] }),
    ).toThrow("logical_source_invalid_relationship");
    expect(() =>
      builder.source("page", {
        relationships: ["page.session", "page.session"],
      }),
    ).toThrow("logical_source_duplicate_name");
    expect(() =>
      builder.source("page", { attributes: ["page.path", "page.path"] }),
    ).toThrow("logical_source_duplicate_name");
    expect(() =>
      builder.source("session", { includeOccurrenceTime: true }),
    ).toThrow("logical_source_occurrence_time_unavailable");

    const pages = builder.source("page", {
      attributes: ["page.path"],
      relationships: ["page.session"],
    });
    const path = builder.slot(pages, "attribute:page.path");
    expect(() => builder.slot(pages, "missing")).toThrow(
      "logical_builder_unknown_slot",
    );
    expect(() => builder.in(path, [builder.isNull(path)])).toThrow(
      "logical_builder_set_membership_requires_literals",
    );
    expect(() => builder.filter(pages, path)).toThrow(
      "logical_builder_filter_requires_boolean",
    );
    expect(() =>
      builder.project(pages, {
        ["$grain0"]: builder.literal("reserved", {
          kind: "scalar",
          scalar: "string",
        }),
      }),
    ).toThrow("logical_builder_reserved_projection_name");
    expect(() =>
      builder.aggregate(pages, {}, [{ name: "sum", kind: "sum" }]),
    ).toThrow("logical_builder_aggregate_expression_required");
    expect(() => builder.distinct(pages, [])).toThrow(
      "logical_builder_distinct_requires_keys",
    );
    expect(() => builder.distinctEntity(pages, "attribute:page.path")).toThrow(
      "logical_builder_distinct_entity_requires_entity_slot",
    );
    expect(() => builder.setOperation("union", [pages])).toThrow(
      "logical_builder_set_requires_two_inputs",
    );
    expect(() =>
      builder.sort(pages, [
        { slot: "missing", direction: "asc", nulls: "last" },
      ]),
    ).toThrow("logical_builder_sort_slot_not_visible");
    expect(() => builder.limit(pages, -1)).toThrow(
      "logical_builder_invalid_limit",
    );
    expect(() => builder.output("", pages, [])).toThrow(
      "logical_builder_duplicate_output_id",
    );
    expect(() =>
      builder.output("duplicate-fields", pages, [
        { name: "same", slot: "entity" },
        { name: "same", slot: "entity" },
      ]),
    ).toThrow("logical_builder_duplicate_output_name");
    expect(() =>
      builder.output("unknown-field", pages, [
        { name: "missing", slot: "missing" },
      ]),
    ).toThrow("logical_builder_unknown_output_slot");
    expect(() => createBuilder().limit(pages, 1)).toThrow(
      "logical_builder_foreign_relation_handle",
    );
    expect(() =>
      builder.project(pages, {
        "": builder.literal("empty", { kind: "scalar", scalar: "string" }),
      }),
    ).toThrow("logical_builder_invalid_projection_names");
    expect(() =>
      builder.aggregate(pages, { "": path }, [
        { name: "rows", kind: "count-rows" },
      ]),
    ).toThrow("logical_builder_invalid_group_name");
    expect(() =>
      builder.aggregate(pages, { same: path }, [
        { name: "same", kind: "count-rows" },
      ]),
    ).toThrow("logical_builder_duplicate_aggregate_name");
    expect(() => builder.distinct(pages, [{ input: "missing" }])).toThrow(
      "logical_builder_unknown_slot",
    );
    expect(() =>
      builder.distinct(pages, [
        { input: "entity", output: "duplicate" },
        { input: "attribute:page.path", output: "duplicate" },
      ]),
    ).toThrow("logical_builder_duplicate_distinct_name");
    expect(() =>
      builder.setOperation("union", [pages, builder.source("visitor")]),
    ).toThrow("logical_builder_set_incompatible_shape");
    const stringKeys = builder.distinct(pages, [
      { input: "attribute:page.path" },
    ]);
    const numberKeys = builder.distinct(
      builder.source("page", { attributes: ["page.durationMs"] }),
      [{ input: "attribute:page.durationMs" }],
    );
    expect(() =>
      builder.setOperation("union", [stringKeys, numberKeys]),
    ).toThrow("logical_builder_set_incompatible_types");
    expect(() => builder.join(pages, pages, [])).toThrow(
      "logical_builder_self_join_requires_distinct_sources",
    );
    expect(() =>
      builder.join(pages, builder.source("session"), [
        { left: "missing", right: "entity" },
      ]),
    ).toThrow("logical_builder_unknown_join_key");
    expect(() =>
      builder.join(pages, builder.source("visitor"), [
        { left: "relationship:page.session", right: "entity" },
      ]),
    ).toThrow("logical_builder_join_key_type_mismatch");
    expect(() =>
      builder.join(pages, builder.source("session"), [
        { left: "relationship:page.session", right: "entity" },
        { left: "relationship:page.session", right: "entity" },
      ]),
    ).toThrow("logical_builder_duplicate_join_key");
    const pathGrouped = builder.distinct(pages, [
      { input: "relationship:page.session" },
      { input: "attribute:page.path" },
    ]);
    expect(() =>
      builder.join(pages, pathGrouped, [
        {
          left: "relationship:page.session",
          right: "relationship:page.session",
        },
      ]),
    ).toThrow("logical_builder_join_keys_do_not_cover_right_grain");
    const collisionLeft = builder.project(pages, {
      "right.entity": builder.slot(pages, "entity"),
    });
    const collisionRight = builder.source("page", {
      relationships: ["page.session"],
    });
    expect(() =>
      builder.join(collisionLeft, collisionRight, [
        { left: "right.entity", right: "entity" },
      ]),
    ).toThrow("logical_builder_join_output_name_collision");
    expect(() =>
      builder.project(pages, {
        pathFromOther: builder.slot(builder.source("visitor"), "entity"),
      }),
    ).toThrow("project.pathFromOther:logical_builder_invisible_slot");
    const missingExpression = {
      expression: { kind: "slot", slot: slotId(999) } as const,
      type: { kind: "scalar", scalar: "number" } as const,
      nullable: false,
    };
    expect(() =>
      builder.compare("eq", missingExpression, missingExpression),
    ).toThrow("logical_builder_unknown_expression_slot");
  });

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
    const uniquePaths = builder.aggregate(projected, {}, [
      {
        name: "uniquePaths",
        kind: "count-distinct",
        expression: builder.slot(projected, "path"),
      },
    ]);
    builder.output("unique-paths", uniquePaths, [
      { name: "uniquePaths", slot: "uniquePaths" },
    ]);
    const plan = builder.finish();

    expect(plan.nodes.map((node) => node.kind)).toEqual([
      "source",
      "filter",
      "project",
      "aggregate",
      "aggregate",
    ]);
    expect(
      validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan),
    ).toEqual(plan);
    expect(printLogicalPlan(plan)).toBe(printLogicalPlan(plan));
    expect(printLogicalPlan(plan)).toContain("domain=candidate");
    expect(printLogicalPlan(plan)).toContain("Aggregate grain=Keyed");
    expect(printLogicalPlan(plan)).toContain("COUNT_DISTINCT");
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
    const printed = printLogicalPlan(plan);
    expect(printed).toContain("Union");
    expect(printed).toContain("SemiJoin");
    expect(printed).toContain("AntiJoin");
    expect(printed).toContain("LeftJoin");
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
