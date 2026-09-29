import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  allCanonicalMetricIds,
  createCandidateScopeUniverse,
  type EligibleDatasetScope,
  groupingFieldDescriptors,
  LazyEligibleDataset,
  LogicalPlanBuilder,
  metricDimensionCapability,
  planMetricRelations,
  type PlannedGrouping,
  planSemanticAggregateQuery,
  printLogicalPlan,
  resolveMetricDependencies,
  resolveScopeFilterSelection,
  scopeConversionContract,
  scopeConversionContracts,
  type SemanticAggregateQuery,
  validatePlannedGrouping,
  validateScopeUniverse,
  validateSemanticAggregateQuery,
} from "@/lib/edge/analytics/engine";
import {
  createSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function createPlanningContext() {
  const range = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 86_400_000 as EpochMs,
  };
  return {
    subject: createSemanticSubjectDomain({
      origin: "site" as const,
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded" as const, range },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: range.endExclusiveMs,
    }),
    scope: {
      requested: "auto" as const,
      contractScope: null,
      logicalScope: null,
    },
  };
}

function createDataset(
  builder: LogicalPlanBuilder,
  options: {
    readonly association?: (
      entity: "observation" | "page" | "event" | "session" | "visitor",
      grouping: PlannedGrouping,
    ) => ReturnType<LogicalPlanBuilder["source"]>;
    readonly subject?: SemanticSubjectDomain;
    readonly scope?: EligibleDatasetScope;
  } = {},
) {
  const context = createPlanningContext();
  return new LazyEligibleDataset({
    subject: options.subject ?? context.subject,
    scope: options.scope ?? { kind: "unfiltered" },
    resolveRelation(entity) {
      if (entity === "page") {
        return builder.source("page", {
          attributes: ["page.durationMs"],
          relationships: ["page.session", "page.visitor"],
        });
      }
      return builder.source(entity);
    },
    resolveAssociation(entity, grouping) {
      if (!options.association)
        throw new Error("association_fixture_not_configured");
      return options.association(entity, grouping);
    },
  });
}

describe("analytics logical planning contracts", () => {
  it("validates aggregate query selections and returns frozen snapshots", () => {
    const invalid = {
      context: createPlanningContext(),
      dimensions: ["unknown.dimension", "unknown.dimension"],
      metrics: ["durationViews", "durationViews", "unknown.metric"],
      sort: [{ field: "not-selected", direction: "sideways", nulls: "middle" }],
      limit: -1,
    } as unknown as SemanticAggregateQuery;
    expect(() =>
      validateSemanticAggregateQuery({ ...invalid, metrics: [] }),
    ).toThrow("Semantic aggregate queries require at least one metric.");
    try {
      validateSemanticAggregateQuery(invalid);
      throw new Error("invalid_query_expected");
    } catch (error) {
      expect(error).toMatchObject({
        name: "SemanticQueryError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "dimensions[0]" }),
          expect.objectContaining({ path: "dimensions[1]" }),
          expect.objectContaining({ path: "metrics[0]" }),
          expect.objectContaining({ path: "metrics[1]" }),
          expect.objectContaining({ path: "metrics[2]" }),
          expect.objectContaining({ path: "sort[0].direction" }),
          expect.objectContaining({ path: "sort[0].nulls" }),
          expect.objectContaining({ path: "sort[0].field" }),
          expect.objectContaining({ path: "limit" }),
        ]),
      });
    }

    const valid = validateSemanticAggregateQuery({
      context: createPlanningContext(),
      dimensions: ["geo.country"],
      metrics: ["views"],
      sort: [{ field: "views", direction: "desc", nulls: "last" }],
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(Object.isFrozen(valid.context.subject.siteIds)).toBe(true);
    expect(Object.isFrozen(valid.sort[0])).toBe(true);
    expect(() =>
      validateSemanticAggregateQuery({
        ...valid,
        timeBucket: { granularity: "year" as never },
      }),
    ).toThrow("Time bucket granularity is invalid");
    expect(() => validateSemanticAggregateQuery(null as never)).toThrow(
      "Semantic aggregate query must be an object",
    );
    try {
      validateSemanticAggregateQuery({
        context: {
          ...createPlanningContext(),
          scope: {
            requested: "auto",
            contractScope: "session",
            logicalScope: "visitor",
          },
        },
        dimensions: null,
        metrics: null,
        sort: null,
      } as unknown as SemanticAggregateQuery);
      throw new Error("malformed_query_expected");
    } catch (error) {
      expect(error).toMatchObject({
        name: "SemanticQueryError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "context.scope" }),
          expect.objectContaining({ path: "dimensions" }),
          expect.objectContaining({ path: "metrics" }),
          expect.objectContaining({ path: "sort" }),
        ]),
      });
    }
    expect(() =>
      validateSemanticAggregateQuery({
        ...valid,
        sort: [null as never],
      }),
    ).toThrow("Sort key must be an object");
  });

  it("resolves metric dependency closure in deterministic topological order", () => {
    const forward = resolveMetricDependencies(["avgDurationMs", "bounceRate"]);
    const reverse = resolveMetricDependencies(["bounceRate", "avgDurationMs"]);
    expect(forward).toEqual(reverse);
    expect(forward.atomic.map((metric) => metric.id)).toEqual([
      "bounces",
      "sessions",
      "totalDurationMs",
    ]);
    expect(forward.derivedOrder.map((metric) => metric.id)).toEqual([
      "avgDurationMs",
      "bounceRate",
    ]);
  });

  it("rejects unsupported metric plans and builds grouped duration recipes", () => {
    expect(() => resolveMetricDependencies(["unknown" as never])).toThrow(
      "Metric unknown is not registered.",
    );
    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const spineSource = builder.source("page", {
      attributes: ["geo.country"],
    });
    const spine = builder.aggregate(
      spineSource,
      { country: builder.slot(spineSource, "attribute:geo.country") },
      [{ name: "rows", kind: "count-rows" }],
    );
    const grouping: PlannedGrouping = {
      spine,
      dimensions: new Map([["geo.country", spine.slots.country!]]),
    };
    expect(() =>
      planMetricRelations(builder, createDataset(builder), [], grouping),
    ).toThrow("metric_plan_requires_requested_metrics");
    expect(() =>
      planMetricRelations(
        builder,
        createDataset(builder),
        ["bounces"],
        grouping,
      ),
    ).toThrow("metric_dimension_not_supported:bounces:geo.country");

    const missingDimension = createDataset(builder, {
      association() {
        return builder.source("page");
      },
    });
    expect(() =>
      planMetricRelations(builder, missingDimension, ["views"], grouping),
    ).toThrow("metric_association_missing_dimension:geo.country");

    const missingEntity = createDataset(builder, {
      association(_entity, _plannedGrouping) {
        const page = builder.source("page", { attributes: ["geo.country"] });
        return builder.project(page, {
          "dimension:geo.country": builder.slot(page, "attribute:geo.country"),
        });
      },
    });
    expect(() =>
      planMetricRelations(builder, missingEntity, ["views"], grouping),
    ).toThrow("metric_association_missing_entity:page");

    const dataset = createDataset(builder, {
      association(entity) {
        if (entity !== "page") throw new Error("unexpected_metric_entity");
        const page = builder.source("page", {
          attributes: ["geo.country", "page.durationMs"],
        });
        return builder.project(page, {
          "dimension:geo.country": builder.slot(page, "attribute:geo.country"),
          entity: builder.slot(page, "entity"),
          "attribute:page.durationMs": builder.slot(
            page,
            "attribute:page.durationMs",
          ),
        });
      },
    });
    const planned = planMetricRelations(
      builder,
      dataset,
      ["totalDurationMs", "durationViews"],
      grouping,
    );
    builder.output("grouped-duration", planned.relation, [
      { name: "country", slot: "dimension:geo.country" },
      { name: "duration", slot: planned.metrics.get("totalDurationMs")! },
      { name: "durationViews", slot: planned.metrics.get("durationViews")! },
    ]);
    expect(builder.finish().nodes.some((node) => node.kind === "filter")).toBe(
      true,
    );
  });

  it("plans every canonical metric without depending on scope or filter documents", () => {
    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const dataset = createDataset(builder);
    const planned = planMetricRelations(
      builder,
      dataset,
      allCanonicalMetricIds(),
    );
    builder.output(
      "canonical-metrics",
      planned.relation,
      allCanonicalMetricIds().map((metric) => ({
        name: metric,
        slot: planned.metrics.get(metric)!,
      })),
    );
    const plan = builder.finish();

    expect(planned.dependencies.closure).toHaveLength(10);
    expect(plan.nodes.some((node) => node.kind === "semi-join")).toBe(false);
    expect(plan.nodes.some((node) => node.kind === "aggregate")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "join")).toBe(true);
  });

  it("plans SemanticAggregateQuery through Builder, Validator, and Printer-ready IR", () => {
    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const dataset = createDataset(builder);
    const query = {
      context,
      dimensions: [],
      metrics: ["views", "avgDurationMs", "bounceRate"],
      sort: [{ field: "views", direction: "desc", nulls: "last" }],
      limit: 20,
    } as const;
    const plan = planSemanticAggregateQuery(builder, query, dataset);

    expect(plan.outputs[0]?.fields.map((field) => field.name)).toEqual([
      "views",
      "avgDurationMs",
      "bounceRate",
    ]);
    expect(plan.nodes.at(-1)?.kind).toBe("limit");
    expect(plan.nodes.some((node) => node.kind === "sort")).toBe(true);

    const replayBuilder = new LogicalPlanBuilder(createPlanningContext());
    const replay = planSemanticAggregateQuery(
      replayBuilder,
      { ...query, context: replayBuilder.context },
      createDataset(replayBuilder),
    );
    expect(replay).toEqual(plan);
    expect(printLogicalPlan(replay)).toBe(printLogicalPlan(plan));
  });

  it("uses explicit metric-by-dimension support and groups entity counts through a spine", () => {
    expect(metricDimensionCapability("views", "geo.country")?.support).toBe(
      "supported",
    );
    expect(metricDimensionCapability("bounces", "geo.country")?.support).toBe(
      "not-yet-supported",
    );
    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const spineSource = builder.source("page", {
      attributes: ["geo.country"],
    });
    const spine = builder.aggregate(
      spineSource,
      { country: builder.slot(spineSource, "attribute:geo.country") },
      [{ name: "spineRows", kind: "count-rows" }],
    );
    const grouping: PlannedGrouping = {
      spine,
      dimensions: new Map([["geo.country", spine.slots.country!]]),
    };
    expect(groupingFieldDescriptors(grouping)).toEqual([
      {
        key: "geo.country",
        sourceName: "country",
        outputName: "dimension:geo.country",
        associationName: "dimension:geo.country",
      },
    ]);
    const dataset = createDataset(builder, {
      association(entity, plannedGrouping) {
        if (entity !== "page") throw new Error("unexpected_entity_association");
        const page = builder.source("page", {
          attributes: ["geo.country"],
        });
        return builder.project(page, {
          "dimension:geo.country": builder.slot(page, "attribute:geo.country"),
          entity: builder.slot(page, "entity"),
        });
      },
    });
    const result = planMetricRelations(builder, dataset, ["views"], grouping);
    builder.output("country-views", result.relation, [
      {
        name: "country",
        slot: "dimension:geo.country",
        semantic: { kind: "dimension", id: "geo.country" },
      },
      {
        name: "views",
        slot: result.metrics.get("views")!,
        semantic: { kind: "metric", id: "views" },
      },
    ]);
    const plan = builder.finish();
    expect(plan.nodes.some((node) => node.kind === "distinct")).toBe(true);
    expect(
      plan.nodes.some(
        (node) => node.kind === "join" && node.joinType === "left",
      ),
    ).toBe(true);
  });

  it("reports malformed grouping spines and missing descriptor slots", () => {
    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const pages = builder.source("page", { attributes: ["geo.country"] });
    const scalarSpine = builder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    const malformed: PlannedGrouping = {
      spine: scalarSpine,
      dimensions: new Map([["geo.country", pages.slots.entity!]]),
      timeBucket: {
        slot: pages.slots.entity!,
        granularity: "day",
      },
    };
    expect(validatePlannedGrouping(malformed)).toEqual(
      expect.arrayContaining([
        "dimensions.geo.country: slot is not visible in the group spine",
        "timeBucket: slot is not visible in the group spine",
        "dimensions: a grouped spine cannot have scalar grain",
        "dimensions: group spine grain must be exactly the declared dimensions and time bucket",
      ]),
    );
    expect(
      validatePlannedGrouping({ spine: pages, dimensions: new Map() }),
    ).toEqual(["dimensions: an ungrouped spine must have scalar grain"]);
    expect(
      validatePlannedGrouping({
        spine: scalarSpine,
        dimensions: new Map([
          ["unknown.dimension" as never, scalarSpine.slots.rows!],
        ]),
      }),
    ).toContain("dimensions.unknown.dimension: unknown semantic dimension");
    expect(() => groupingFieldDescriptors(malformed)).toThrow(
      "grouping_spine_missing_dimension:geo.country",
    );
  });

  it("defines all scope conversions and lowers AND, OR, and NOT as set operations", () => {
    expect(scopeConversionContracts).toHaveLength(9);
    expect(
      scopeConversionContract("observation", "visitor")?.relationships,
    ).toEqual(["observation.visitor"]);

    const context = createPlanningContext();
    const builder = new LogicalPlanBuilder(context);
    const universe = createCandidateScopeUniverse(builder, "session");
    const candidate = universe.relation;
    const matchA = builder.source("session");
    const matchB = builder.source("session");
    expect(validateScopeUniverse(universe)).toEqual([]);
    expect(
      validateScopeUniverse({ ...universe, entitySlot: "missing" }),
    ).toEqual([
      "entitySlot: slot name is not visible in relation",
      "entitySlot: must identify the entity grain key",
    ]);
    expect(
      validateScopeUniverse({
        scope: "session",
        relation: builder.source("visitor"),
        entitySlot: "entity",
        temporalDomain: "candidate",
      }),
    ).toEqual(["relation: expected Entity<session> grain"]);
    expect(
      resolveScopeFilterSelection(
        builder,
        { ...universe, entitySlot: "missing" },
        null,
        {
          convert: () => {
            throw new Error("must_not_convert");
          },
        },
      ),
    ).toEqual({ kind: "unfiltered" });
    expect(() =>
      resolveScopeFilterSelection(
        builder,
        universe,
        { kind: "and", children: [] },
        { convert: () => matchA },
      ),
    ).toThrow("scope_boolean_group_empty");
    const converter = {
      convert(
        match: { readonly relation: typeof matchA },
        target: { readonly relation: typeof candidate },
      ) {
        return builder.setOperation("intersect", [
          target.relation,
          match.relation,
        ]);
      },
    };
    const andSelection = resolveScopeFilterSelection(
      builder,
      universe,
      {
        kind: "and",
        children: [
          {
            kind: "match",
            value: {
              nativeEntity: "session",
              relation: matchA,
              entitySlot: "entity",
              temporalDomain: "candidate",
            },
          },
          {
            kind: "match",
            value: {
              nativeEntity: "session",
              relation: matchB,
              entitySlot: "entity",
              temporalDomain: "candidate",
            },
          },
        ],
      },
      converter,
    );
    const orSelection = resolveScopeFilterSelection(
      builder,
      universe,
      {
        kind: "or",
        children: [
          {
            kind: "match",
            value: {
              nativeEntity: "session",
              relation: matchA,
              entitySlot: "entity",
              temporalDomain: "candidate",
            },
          },
          {
            kind: "match",
            value: {
              nativeEntity: "session",
              relation: matchB,
              entitySlot: "entity",
              temporalDomain: "candidate",
            },
          },
        ],
      },
      converter,
    );
    const notSelection = resolveScopeFilterSelection(
      builder,
      universe,
      {
        kind: "not",
        child: {
          kind: "match",
          value: {
            nativeEntity: "session",
            relation: matchA,
            entitySlot: "entity",
            temporalDomain: "candidate",
          },
        },
      },
      converter,
    );
    const singleSelection = resolveScopeFilterSelection(
      builder,
      universe,
      {
        kind: "and",
        children: [
          {
            kind: "match",
            value: {
              nativeEntity: "session",
              relation: matchA,
              entitySlot: "entity",
              temporalDomain: "candidate",
            },
          },
        ],
      },
      converter,
    );
    expect(andSelection.kind).toBe("matching");
    expect(orSelection.kind).toBe("matching");
    expect(notSelection.kind).toBe("matching");
    expect(singleSelection.kind).toBe("matching");
    if (
      andSelection.kind !== "matching" ||
      orSelection.kind !== "matching" ||
      notSelection.kind !== "matching"
    ) {
      throw new Error("scope_selection_fixture_expected");
    }
    builder.output("and", andSelection.relation, [
      { name: "session", slot: "entity" },
    ]);
    builder.output("or", orSelection.relation, [
      { name: "session", slot: "entity" },
    ]);
    builder.output("not", notSelection.relation, [
      { name: "session", slot: "entity" },
    ]);
    expect(
      builder
        .finish()
        .nodes.filter((node) => node.kind === "set-operation")
        .map((node) => (node.kind === "set-operation" ? node.operation : null)),
    ).toEqual([
      "intersect",
      "intersect",
      "intersect",
      "intersect",
      "intersect",
      "union",
      "intersect",
      "difference",
      "intersect",
    ]);
  });

  it("rejects planner context, subject, grouping, and scope mismatches", () => {
    const context = createPlanningContext();
    const makeQuery = (
      overrides: Partial<SemanticAggregateQuery> = {},
    ): SemanticAggregateQuery => ({
      context,
      dimensions: [],
      metrics: ["views"],
      sort: [],
      ...overrides,
    });

    const contextBuilder = new LogicalPlanBuilder(context);
    const contextDataset = createDataset(contextBuilder);
    expect(() =>
      planSemanticAggregateQuery(
        contextBuilder,
        makeQuery({
          context: { ...context, originOperation: "trend" },
        }),
        contextDataset,
      ),
    ).toThrow("semantic_query_builder_context_mismatch");

    const subjectBuilder = new LogicalPlanBuilder(context);
    const otherSubject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-b" as SiteId],
    });
    expect(() =>
      planSemanticAggregateQuery(
        subjectBuilder,
        makeQuery(),
        createDataset(subjectBuilder, { subject: otherSubject }),
      ),
    ).toThrow("semantic_query_dataset_subject_mismatch");

    const groupingBuilder = new LogicalPlanBuilder(context);
    expect(() =>
      planSemanticAggregateQuery(
        groupingBuilder,
        makeQuery({ dimensions: ["geo.country"] }),
        createDataset(groupingBuilder),
      ),
    ).toThrow("semantic_query_grouping_dimensions_mismatch");
    expect(() =>
      planSemanticAggregateQuery(
        groupingBuilder,
        makeQuery({ timeBucket: { granularity: "day" } }),
        createDataset(groupingBuilder),
      ),
    ).toThrow("semantic_query_time_bucket_requires_matching_group_spine");

    const timeBuilder = new LogicalPlanBuilder(context);
    const timeSource = timeBuilder.source("page", {
      includeOccurrenceTime: true,
    });
    const timeSpine = timeBuilder.aggregate(
      timeSource,
      {
        bucket: timeBuilder.timeBucket(
          timeBuilder.slot(timeSource, "time"),
          "day",
        ),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    const unrequestedTimeGrouping: PlannedGrouping = {
      spine: timeSpine,
      dimensions: new Map(),
      timeBucket: { slot: timeSpine.slots.bucket!, granularity: "day" },
    };
    expect(() =>
      planSemanticAggregateQuery(
        timeBuilder,
        makeQuery(),
        createDataset(timeBuilder),
        unrequestedTimeGrouping,
      ),
    ).toThrow("semantic_query_does_not_request_grouping_time_bucket");

    const filterBuilder = new LogicalPlanBuilder(context);
    expect(() =>
      planSemanticAggregateQuery(
        filterBuilder,
        makeQuery({ filters: { root: {} } as never }),
        createDataset(filterBuilder),
      ),
    ).toThrow("semantic_query_filter_requires_resolved_eligible_dataset");

    const sessionContext = {
      ...context,
      scope: {
        requested: "session" as const,
        contractScope: "session" as const,
        logicalScope: "session" as const,
      },
    };
    const scopeBuilder = new LogicalPlanBuilder(sessionContext);
    const visitors = scopeBuilder.source("visitor");
    expect(() =>
      planSemanticAggregateQuery(
        scopeBuilder,
        makeQuery({
          context: sessionContext,
          filters: { root: {} } as never,
        }),
        createDataset(scopeBuilder, {
          scope: {
            kind: "matching",
            target: "visitor",
            relation: visitors,
            entitySlotName: "entity",
          },
        }),
      ),
    ).toThrow("semantic_query_scope_dataset_mismatch");
  });
});
