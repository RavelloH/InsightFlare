import { describe, expect, it } from "vitest";

import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE = "wave93c-payload-key-carrier";
const STRING = { kind: "scalar", scalar: "string" } as const;
const BOOLEAN = { kind: "scalar", scalar: "boolean" } as const;
const ATTRIBUTES = ["event.report.eventName"] as const;

function createBuilder(): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: { startMs: 10 as never, endExclusiveMs: 20 as never },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 20 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function outputFor(plan: ReturnType<LogicalPlanBuilder["finish"]>, id: string) {
  const output = plan.outputs.find((candidate) => candidate.id === id);
  if (!output) throw new Error(`missing test output ${id}`);
  return output;
}

function compileOutput(
  lowerer: AnalyticsLogicalToDbLowerer,
  output: LogicalOutput,
  lowered: ReturnType<AnalyticsLogicalToDbLowerer["lowerMany"]>[number],
) {
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation));
  return {
    sql: query.sql,
    bindings: query.bindings,
    shape: query.physicalPlanShape,
  };
}

function eventScanCount(sql: string): number {
  return sql.match(/FROM "custom_events" AS /gu)?.length ?? 0;
}

function customEventsProjection(sql: string): string {
  const match = sql.match(/SELECT ([^()]*?) FROM "custom_events" AS /u);
  if (!match) throw new Error("custom_events source projection is missing");
  return match[1]!;
}

describe("Analytics Provider payload key carrier", () => {
  it("rejects Event entity DISTINCT without a Provider identity proof", () => {
    const builder = createBuilder();
    const events = builder.source("event", {
      temporalDomain: "read",
      attributes: ATTRIBUTES,
    });
    const aggregate = builder.aggregate(events, {}, [
      {
        name: "events",
        kind: "count-distinct",
        expression: builder.slot(events, "entity"),
      },
    ]);
    builder.output("unproven-event-distinct", aggregate, [
      { name: "events", slot: "events" },
    ]);
    const plan = builder.finish();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });

    expect(() =>
      lowerer.lower(outputFor(plan, "unproven-event-distinct")),
    ).toThrow(
      "COUNT(DISTINCT) supports Entity values only with a proven non-null Event identity.",
    );
  });

  it("keeps the hidden key through transparent Filters and unions multi-output demand", () => {
    const builder = createBuilder();
    const eventsA = builder.source("event", {
      temporalDomain: "read",
      attributes: ATTRIBUTES,
    });
    const eventsB = builder.source("event", {
      temporalDomain: "read",
      attributes: ATTRIBUTES,
    });
    const eventsC = builder.source("event", {
      temporalDomain: "read",
      attributes: ATTRIBUTES,
    });

    const firstFilter = builder.filter(
      eventsA,
      builder.compare(
        "eq",
        builder.slot(eventsA, "attribute:event.report.eventName"),
        builder.literal("signup", STRING),
      ),
    );
    const secondFilter = builder.filter(
      firstFilter,
      builder.compare(
        "eq",
        builder.slot(firstFilter, "attribute:event.report.eventName"),
        builder.literal("signup", STRING),
      ),
    );

    const occurrenceOutput = (
      id: string,
      events: typeof eventsA | typeof eventsB | typeof eventsC,
    ) => {
      const occurrences = builder.eventPayloadOccurrences(events);
      const aggregate = builder.aggregate(occurrences, {}, [
        {
          name: "events",
          kind: "count-distinct",
          expression: builder.slot(occurrences, "eventIdentity"),
        },
        { name: "occurrences", kind: "count-rows" },
      ]);
      builder.output(id, aggregate, [
        { name: "events", slot: "events" },
        { name: "occurrences", slot: "occurrences" },
      ]);
    };
    occurrenceOutput("occurrence-a", secondFilter);
    occurrenceOutput("occurrence-b", eventsB);
    occurrenceOutput("occurrence-c", eventsC);

    const countEvents = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.internalPk"],
    });
    const countAggregate = builder.aggregate(countEvents, {}, [
      {
        name: "events",
        kind: "count-distinct",
        expression: builder.slot(
          countEvents,
          "attribute:event.report.internalPk",
        ),
      },
    ]);
    builder.output("count-a", countAggregate, [
      { name: "events", slot: "events" },
    ]);

    const plainEvents = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.eventName"],
    });
    const plainAggregate = builder.aggregate(plainEvents, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    builder.output("plain", plainAggregate, [{ name: "rows", slot: "rows" }]);

    const plan = builder.finish();
    const occurrenceA = outputFor(plan, "occurrence-a");
    const countA = outputFor(plan, "count-a");
    const occurrenceB = outputFor(plan, "occurrence-b");
    const occurrenceC = outputFor(plan, "occurrence-c");
    const plain = outputFor(plan, "plain");
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });

    const forwardOutputs = [occurrenceA, countA, occurrenceB, occurrenceC];
    const forward = lowerer.lowerMany(forwardOutputs);
    const forwardQueries = new Map(
      forwardOutputs.map((output, index) => [
        output.id,
        compileOutput(lowerer, output, forward[index]!),
      ]),
    );
    const reverseOutputs = [...forwardOutputs].reverse();
    const reverse = lowerer.lowerMany(reverseOutputs);
    const reverseQueries = new Map(
      reverseOutputs.map((output, index) => [
        output.id,
        compileOutput(lowerer, output, reverse[index]!),
      ]),
    );

    expect(reverseQueries.get("occurrence-a")).toEqual(
      forwardQueries.get("occurrence-a"),
    );
    expect(reverseQueries.get("count-a")).toEqual(
      forwardQueries.get("count-a"),
    );
    expect(reverseQueries.get("occurrence-b")).toEqual(
      forwardQueries.get("occurrence-b"),
    );
    expect(reverseQueries.get("occurrence-c")).toEqual(
      forwardQueries.get("occurrence-c"),
    );
    expect(forwardQueries.get("occurrence-b")?.sql).toBe(
      forwardQueries.get("occurrence-c")?.sql,
    );
    expect(forwardQueries.get("occurrence-a")?.sql).toContain('"event_pk"');
    expect(forwardQueries.get("occurrence-a")?.sql).toContain(
      '"custom_event_json_values"',
    );
    expect(eventScanCount(forwardQueries.get("occurrence-a")!.sql)).toBe(1);
    expect(
      customEventsProjection(forwardQueries.get("occurrence-a")!.sql).match(
        /"event_pk" AS /gu,
      ),
    ).toHaveLength(1);
    expect(
      customEventsProjection(forwardQueries.get("occurrence-b")!.sql).match(
        /"event_pk" AS /gu,
      ),
    ).toHaveLength(1);

    const plainOnly = lowerer.lowerMany([plain]);
    const plainQuery = compileOutput(lowerer, plain, plainOnly[0]!);
    expect(plainQuery.sql).not.toContain('"event_pk"');
    expect(eventScanCount(plainQuery.sql)).toBe(1);
    expect(customEventsProjection(plainQuery.sql)).not.toContain('"event_pk"');

    const countOnly = lowerer.lowerMany([countA]);
    compileOutput(lowerer, countA, countOnly[0]!);
    const occurrenceOnly = lowerer.lowerMany([occurrenceA]);
    const occurrenceAfterIncrementalCall = compileOutput(
      lowerer,
      occurrenceA,
      occurrenceOnly[0]!,
    );
    expect(occurrenceAfterIncrementalCall.sql).toContain(
      '"custom_event_json_values"',
    );
    expect(eventScanCount(occurrenceAfterIncrementalCall.sql)).toBe(1);
  });

  it("remaps the hidden payload key and Event identity across a left membership semi-join", () => {
    const builder = createBuilder();
    const events = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.ownerSessionId"],
    });
    const matchedEvents = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.ownerSessionId"],
    });
    const selected = builder.semiJoin(events, matchedEvents, [
      {
        left: "attribute:event.report.ownerSessionId",
        right: "attribute:event.report.ownerSessionId",
      },
    ]);
    const occurrences = builder.eventPayloadOccurrences(selected);
    const aggregate = builder.aggregate(occurrences, {}, [
      {
        name: "events",
        kind: "count-distinct",
        expression: builder.slot(occurrences, "eventIdentity"),
      },
      { name: "occurrences", kind: "count-rows" },
    ]);
    builder.output("semi-payload", aggregate, [
      { name: "events", slot: "events" },
      { name: "occurrences", slot: "occurrences" },
    ]);
    const plan = builder.finish();
    const output = outputFor(plan, "semi-payload");
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });
    const [lowered] = lowerer.lowerMany([output]);
    const query = compileOutput(lowerer, output, lowered!);

    expect(query.sql).toContain('"event_pk"');
    expect(query.sql).toContain('"custom_event_json_values"');
    expect(query.sql).toContain("EXISTS");
    expect(eventScanCount(query.sql)).toBeGreaterThanOrEqual(2);
    expect(query.sql).toMatch(/"event_pk" AS /u);
  });

  it("unions hidden Properties metadata demand across multi-output Event lowering", () => {
    const builder = createBuilder();
    const events = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.localId", "event.report.ownerPresent"],
    });
    const ownerScopedEvents = builder.filter(
      events,
      builder.compare(
        "eq",
        builder.slot(events, "attribute:event.report.ownerPresent"),
        builder.literal(true, BOOLEAN),
      ),
    );
    const properties = builder.eventPayloadProperties(ownerScopedEvents, [
      "/tier",
    ]);
    builder.output("properties", properties, [
      { name: "eventId", slot: "attribute:event.report.localId" },
      { name: "present", slot: "payloadProperty:0:present" },
    ]);
    const occurrences = builder.eventPayloadOccurrences(ownerScopedEvents);
    const occurrenceTotals = builder.aggregate(occurrences, {}, [
      {
        name: "events",
        kind: "count-distinct",
        expression: builder.slot(occurrences, "eventIdentity"),
      },
    ]);
    builder.output("occurrences", occurrenceTotals, [
      { name: "events", slot: "events" },
    ]);
    const plan = builder.finish();
    const propertiesNode = plan.nodes.find(
      (node) => node.kind === "event-payload-properties",
    );
    const eventSource = plan.nodes.find(
      (node) => node.kind === "source" && node.id === events.id,
    );
    if (
      propertiesNode?.kind !== "event-payload-properties" ||
      eventSource?.kind !== "source"
    )
      throw new Error("properties_source_contract_missing");
    expect("eventPk" in propertiesNode).toBe(false);
    expect("selectedNodes" in propertiesNode).toBe(false);
    expect("resourceBudget" in propertiesNode).toBe(false);
    expect(
      eventSource.values.some(
        (binding) =>
          binding.kind === "attribute" &&
          binding.attribute === "event.report.internalPk",
      ),
    ).toBe(false);

    const propertyOutput = outputFor(plan, "properties");
    const occurrenceOutput = outputFor(plan, "occurrences");
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });
    const outputs = [propertyOutput, occurrenceOutput];
    const forward = lowerer.lowerMany(outputs);
    const forwardQueries = new Map(
      outputs.map((output, index) => [
        output.id,
        compileOutput(lowerer, output, forward[index]!),
      ]),
    );
    const reverseOutputs = [...outputs].reverse();
    const reverse = lowerer.lowerMany(reverseOutputs);
    const reverseQueries = new Map(
      reverseOutputs.map((output, index) => [
        output.id,
        compileOutput(lowerer, output, reverse[index]!),
      ]),
    );
    expect(reverseQueries.get("properties")).toEqual(
      forwardQueries.get("properties"),
    );
    const propertyQuery = forwardQueries.get("properties");
    if (!propertyQuery) throw new Error("properties_query_missing");
    const propertyOnlyLowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });
    const [propertyOnly] = propertyOnlyLowerer.lowerMany([propertyOutput]);
    if (!propertyOnly) throw new Error("property_only_lowering_missing");
    const propertyOnlyQuery = compileOutput(
      propertyOnlyLowerer,
      propertyOutput,
      propertyOnly,
    );
    expect(eventScanCount(propertyQuery.sql)).toBe(
      eventScanCount(propertyOnlyQuery.sql),
    );
    expect(customEventsProjection(propertyQuery.sql)).toContain(
      '"event_pk" AS ',
    );
    expect(propertyQuery.sql).toContain('"site_id"');
    expect(propertyQuery.sql).toContain('"event_name_id"');
    expect(propertyQuery.sql).toContain('"visit_id"');
  });
});
