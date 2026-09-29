import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  type FilterConditionLoweringResult,
  lowerFilterCondition,
  observationCapabilityForAttribute,
  observationSourceForAttribute,
} from "@/lib/edge/analytics/engine/filter-lowering";
import {
  type LogicalPlan,
  LogicalPlanBuilder,
  printLogicalPlan,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";
import { inferLogicalExpression } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  evaluateFilterDocument,
  type FilterEvaluationDataset,
} from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterCondition,
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

function createBuilder(): LogicalPlanBuilder {
  const range = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 100_000 as EpochMs,
  };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: range.endExclusiveMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function analyzedCondition(
  field: string,
  operator: string,
  value?: unknown,
): {
  readonly document: FilterDocument;
  readonly condition: FilterCondition;
  readonly analysis: AnalyzedFilterDocument;
} {
  const document = normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field },
        operator,
        ...(value === undefined ? {} : { value }),
      },
    },
    analyticsFilterRegistry,
  );
  const condition = document.root as FilterCondition;
  return {
    document,
    condition,
    analysis: analyzeFilterDocument(document, analyticsFilterRegistry),
  };
}

function analyzedPayloadCondition(): {
  readonly document: FilterDocument;
  readonly condition: FilterCondition;
  readonly analysis: AnalyzedFilterDocument;
} {
  const document = normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "event-payload", path: "/amount" },
        operator: "eq",
        value: 4,
      },
    },
    analyticsFilterRegistry,
  );
  const condition = document.root as FilterCondition;
  return {
    document,
    condition,
    analysis: analyzeFilterDocument(document, analyticsFilterRegistry),
  };
}

function lowerToPlan(
  input: ReturnType<typeof analyzedCondition>,
  temporalDomain: "candidate" | "filter" | "read" = "candidate",
): {
  readonly builder: LogicalPlanBuilder;
  readonly result: FilterConditionLoweringResult;
  readonly plan?: LogicalPlan;
} {
  const builder = createBuilder();
  const result = lowerFilterCondition(
    builder,
    input.analysis,
    input.condition,
    temporalDomain,
  );
  if (result.kind === "unsupported") return { builder, result };
  builder.output("matches", result.match.relation, [
    { name: "entity", slot: result.match.entitySlot },
  ]);
  return { builder, result, plan: builder.finish() };
}

function expectRoundTrip(plan: LogicalPlan): string {
  const printed = printLogicalPlan(plan);
  const roundTrip = JSON.parse(JSON.stringify(plan)) as LogicalPlan;
  const validated = validateLogicalPlan(roundTrip);
  expect(printLogicalPlan(validated)).toBe(printed);
  return printed;
}

function predicateInference(plan: LogicalPlan) {
  const filter = plan.nodes.find((node) => node.kind === "filter");
  if (!filter || filter.kind !== "filter") throw new Error("filter_missing");
  const slots = new Map(plan.slots.map((slot) => [slot.id, slot]));
  return inferLogicalExpression(filter.predicate, (id, path) => {
    const slot = slots.get(id);
    if (!slot) throw new Error(`slot_missing:${path}`);
    return { type: slot.type, nullable: slot.nullable };
  });
}

describe("primitive Filter v1 condition lowering", () => {
  it("restricts one-kind attributes to their declared source kind", () => {
    expect(
      observationSourceForAttribute({
        nativeEntity: "page",
        observationKinds: ["page"],
      }),
    ).toBe("page");
    expect(
      observationSourceForAttribute({
        nativeEntity: "event",
        observationKinds: ["event"],
      }),
    ).toBe("event");
    expect(
      observationSourceForAttribute({
        nativeEntity: "page",
        observationKinds: ["page", "event"],
      }),
    ).toBe("observation");
    expect(
      observationSourceForAttribute({
        nativeEntity: "event",
        observationKinds: ["page"],
      }),
    ).toBeNull();
    expect(
      observationSourceForAttribute({
        nativeEntity: "page",
        observationKinds: [],
      }),
    ).toBeNull();
  });

  it("derives observation support from evaluation and presence metadata", () => {
    expect(
      observationCapabilityForAttribute({
        evaluation: "observation",
        presence: "non-null",
        nativeEntity: "page",
        observationKinds: ["page"],
      }),
    ).toEqual({ kind: "supported", source: "page" });
    expect(
      observationCapabilityForAttribute({
        evaluation: "derived",
        presence: "derived-value",
        nativeEntity: "page",
        observationKinds: ["page"],
      }),
    ).toEqual({ kind: "unsupported", code: "unsupported-evaluation" });
    expect(
      observationCapabilityForAttribute({
        evaluation: "observation",
        presence: "json-path",
        nativeEntity: "event",
        observationKinds: ["event"],
      }),
    ).toEqual({ kind: "unsupported", code: "unsupported-evaluation" });
    expect(
      observationCapabilityForAttribute({
        evaluation: "observation",
        presence: "non-null",
        nativeEntity: "session",
        observationKinds: ["page"],
      }),
    ).toEqual({ kind: "unsupported", code: "unsupported-native-entity" });
    expect(
      observationCapabilityForAttribute({
        evaluation: "observation",
        presence: "non-null",
        nativeEntity: "page",
        observationKinds: [],
      }),
    ).toEqual({ kind: "unsupported", code: "unsupported-observation-kinds" });
  });

  it("lowers a case-sensitive raw field equality with trim normalization", () => {
    const lowered = lowerToPlan(
      analyzedCondition("client.browser", "eq", " Chrome "),
    );
    expect(lowered.result.kind).toBe("supported");
    const filter = lowered.plan?.nodes.find((node) => node.kind === "filter");
    expect(filter).toMatchObject({
      kind: "filter",
      predicate: {
        kind: "comparison",
        operator: "eq",
        stringNormalization: "trim",
        right: { kind: "literal", value: "Chrome" },
      },
    });
    expect(expectRoundTrip(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=client.browser -> s1:Scalar<string>?{attribute:client.browser}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:client.browser}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 eq "Chrome":Scalar<string> normalization=trim)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:client.browser}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("lowers case-insensitive IN with canonical literals and explicit normalization", () => {
    const lowered = lowerToPlan(
      analyzedCondition("geo.country", "in", ["US", " ca "]),
    );
    const filter = lowered.plan?.nodes.find((node) => node.kind === "filter");
    expect(filter).toMatchObject({
      kind: "filter",
      predicate: {
        kind: "set-membership",
        negated: false,
        stringNormalization: "trim-case-fold",
        values: [
          { kind: "literal", value: "ca" },
          { kind: "literal", value: "us" },
        ],
      },
    });
    expect(expectRoundTrip(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=geo.country -> s1:Scalar<string>?{attribute:geo.country}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.country}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 IN ["ca":Scalar<string>, "us":Scalar<string>] normalization=trim-case-fold)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.country}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("lowers string matching with field-specific case and trim semantics", () => {
    const lowered = lowerToPlan(
      analyzedCondition("page.path", "contains", " /Docs/ "),
    );
    const filter = lowered.plan?.nodes.find((node) => node.kind === "filter");
    expect(filter).toMatchObject({
      kind: "filter",
      predicate: {
        kind: "string-match",
        operator: "contains",
        value: "/Docs/",
        caseSensitive: true,
        stringNormalization: "trim",
      },
    });
    expect(expectRoundTrip(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.path -> s1:Scalar<string>?{attribute:page.path}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 contains case-sensitive normalization=trim "/Docs/")
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("keeps unary null tests on the declared observation kinds", () => {
    const nullableField = lowerToPlan(analyzedCondition("geo.city", "isNull"));
    expect(
      nullableField.plan?.nodes.find((node) => node.kind === "source"),
    ).toMatchObject({ entity: "observation", temporalDomain: "candidate" });
    expect(
      nullableField.plan?.nodes.find((node) => node.kind === "filter"),
    ).toMatchObject({ predicate: { kind: "null-test", negated: false } });
    expect(expectRoundTrip(nullableField.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=geo.city -> s1:Scalar<string>?{attribute:geo.city}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.city}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 IS NULL)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.city}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);

    const eventOnly = lowerToPlan(analyzedCondition("event.name", "isNull"));
    expect(
      eventOnly.plan?.nodes.find((node) => node.kind === "source"),
    ).toMatchObject({ entity: "event", temporalDomain: "candidate" });
    expect(eventOnly.plan?.nodes.some((node) => node.kind === "distinct")).toBe(
      true,
    );
    expect(
      eventOnly.plan?.nodes.filter((node) => node.kind === "source"),
    ).toHaveLength(1);
    expect(predicateInference(eventOnly.plan!).nullable).toBe(false);
    expect(expectRoundTrip(eventOnly.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<event> grain=Entity<event>[s0] domain=candidate
        VALUE self -> s0:Entity<event>!{entity:event}
        VALUE relationship=event.observation -> s1:Entity<observation>!{relationship:event.observation}
        VALUE attribute=event.name -> s2:Scalar<string>!{attribute:event.name}
        OUTPUT s0:Entity<event>!{entity:event}, s1:Entity<observation>!{relationship:event.observation}, s2:Scalar<string>!{attribute:event.name}

      r1 Filter grain=Entity<event>[s0] input=r0
        WHERE (s2 IS NULL)
        OUTPUT s0:Entity<event>!{entity:event}, s1:Entity<observation>!{relationship:event.observation}, s2:Scalar<string>!{attribute:event.name}

      r2 Project grain=Entity<event>[s4] input=r1
        s3:Entity<observation>!{alias:s1} := s1
        s4:Entity<event>!{alias:s0} := s0
        OUTPUT s3:Entity<observation>!{alias:s1}, s4:Entity<event>!{alias:s0}

      r3 Distinct grain=Entity<observation>[s5] excludeNull=true
        KEY s5:Entity<observation>!{alias:s3} := s3:Entity<observation>!{alias:s1}
        OUTPUT s5:Entity<observation>!{alias:s3}

      Outputs
        "matches" from r3
          "entity" -> s5:Entity<observation>!{alias:s3}
      "
    `);

    const nonNullField = lowerToPlan(analyzedCondition("geo.city", "notNull"));
    expect(
      nonNullField.plan?.nodes.find((node) => node.kind === "filter"),
    ).toMatchObject({ predicate: { kind: "null-test", negated: true } });
    expect(expectRoundTrip(nonNullField.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=geo.city -> s1:Scalar<string>?{attribute:geo.city}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.city}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 IS NOT NULL)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:geo.city}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("lowers each supported string matching direction", () => {
    const startsWith = lowerToPlan(
      analyzedCondition("page.path", "startsWith", "/docs"),
    );
    expect(
      startsWith.plan?.nodes.find((node) => node.kind === "filter"),
    ).toMatchObject({
      predicate: {
        kind: "string-match",
        operator: "starts-with",
        value: "/docs",
        caseSensitive: true,
      },
    });
    expect(expectRoundTrip(startsWith.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.path -> s1:Scalar<string>?{attribute:page.path}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 starts-with case-sensitive normalization=trim "/docs")
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);

    const endsWith = lowerToPlan(
      analyzedCondition("page.path", "endsWith", ".html"),
    );
    expect(
      endsWith.plan?.nodes.find((node) => node.kind === "filter"),
    ).toMatchObject({
      predicate: {
        kind: "string-match",
        operator: "ends-with",
        value: ".html",
        caseSensitive: true,
      },
    });
    expect(expectRoundTrip(endsWith.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.path -> s1:Scalar<string>?{attribute:page.path}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 ends-with case-sensitive normalization=trim ".html")
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<string>?{attribute:page.path}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("lowers boolean equality without coercing its literal", () => {
    const lowered = lowerToPlan(
      analyzedCondition("session.bounce", "eq", true),
    );
    expect(lowered.result).toMatchObject({
      kind: "supported",
      match: {
        nativeEntity: "session",
        relation: { grain: { kind: "entity", entity: "session" } },
      },
    });
    expect(
      lowered.plan?.nodes.find((node) => node.kind === "filter"),
    ).toMatchObject({
      predicate: {
        kind: "comparison",
        operator: "eq",
        right: { kind: "literal", value: true },
      },
    });
    expect(expectRoundTrip(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<session> grain=Entity<session>[s0] domain=candidate
        VALUE self -> s0:Entity<session>!{entity:session}
        VALUE attribute=session.bounce -> s1:Scalar<boolean>!{attribute:session.bounce}
        OUTPUT s0:Entity<session>!{entity:session}, s1:Scalar<boolean>!{attribute:session.bounce}

      r1 Filter grain=Entity<session>[s0] input=r0
        WHERE (s1 eq true:Scalar<boolean>)
        OUTPUT s0:Entity<session>!{entity:session}, s1:Scalar<boolean>!{attribute:session.bounce}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<session>!{entity:session}
      "
    `);
  });

  it("lowers an ordered numeric comparison and preserves nullable predicate semantics", () => {
    const lowered = lowerToPlan(
      analyzedCondition("page.durationMs", "gt", 250),
    );
    const filter = lowered.plan?.nodes.find((node) => node.kind === "filter");
    expect(filter).toMatchObject({
      predicate: {
        kind: "comparison",
        operator: "gt",
        right: {
          kind: "literal",
          value: 250,
          valueType: { kind: "scalar", scalar: "number", unit: "ms" },
        },
      },
    });
    expect(predicateInference(lowered.plan!).nullable).toBe(true);
    expect(expectRoundTrip(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.durationMs -> s1:Scalar<number,ms>?{attribute:page.durationMs}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 gt 250:Scalar<number,ms>)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
  });

  it("keeps neq and notIn unknown for NULL or missing values", () => {
    const neq = lowerToPlan(analyzedCondition("page.durationMs", "neq", 250));
    const neqFilter = neq.plan?.nodes.find((node) => node.kind === "filter");
    expect(neqFilter).toMatchObject({
      predicate: { kind: "comparison", operator: "neq" },
    });
    expect(predicateInference(neq.plan!).nullable).toBe(true);

    const notIn = lowerToPlan(
      analyzedCondition("page.durationMs", "notIn", [250, 500]),
    );
    const notInFilter = notIn.plan?.nodes.find(
      (node) => node.kind === "filter",
    );
    expect(notInFilter).toMatchObject({
      predicate: { kind: "set-membership", negated: true },
    });
    expect(predicateInference(notIn.plan!).nullable).toBe(true);
    expect(expectRoundTrip(neq.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.durationMs -> s1:Scalar<number,ms>?{attribute:page.durationMs}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 neq 250:Scalar<number,ms>)
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);
    expect(expectRoundTrip(notIn.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE attribute=page.durationMs -> s1:Scalar<number,ms>?{attribute:page.durationMs}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      r1 Filter grain=Entity<observation>[s0] input=r0
        WHERE (s1 NOT IN [250:Scalar<number,ms>, 500:Scalar<number,ms>])
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Scalar<number,ms>?{attribute:page.durationMs}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<observation>!{entity:observation}
      "
    `);

    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          kind: "page",
          id: "null-path",
          visitId: "null-path",
          sessionId: "session-null",
          visitorId: "visitor-null",
          time: 10,
          fields: { "page.path": null },
        },
        {
          kind: "page",
          id: "missing-path",
          visitId: "missing-path",
          sessionId: "session-missing",
          visitorId: "visitor-missing",
          time: 20,
          fields: {},
        },
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    for (const input of [
      analyzedCondition("page.path", "neq", "/pricing"),
      analyzedCondition("page.path", "notIn", ["/pricing"]),
    ]) {
      expect(
        evaluateFilterDocument(input.document, dataset, {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC" as ReportingTimeZone,
          capturedAtMs: 100 as EpochMs,
        }).matchingScopeEntityIds,
      ).toEqual(new Set());
    }
  });

  it("lowers session and visitor facts at their native entity grains", () => {
    const session = lowerToPlan(analyzedCondition("session.views", "gte", 3));
    expect(session.result).toMatchObject({
      kind: "supported",
      match: {
        nativeEntity: "session",
        entitySlot: "entity",
        relation: { grain: { kind: "entity", entity: "session" } },
      },
    });
    expect(expectRoundTrip(session.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<session> grain=Entity<session>[s0] domain=candidate
        VALUE self -> s0:Entity<session>!{entity:session}
        VALUE attribute=session.views -> s1:Scalar<number>!{attribute:session.views}
        OUTPUT s0:Entity<session>!{entity:session}, s1:Scalar<number>!{attribute:session.views}

      r1 Filter grain=Entity<session>[s0] input=r0
        WHERE (s1 gte 3:Scalar<number>)
        OUTPUT s0:Entity<session>!{entity:session}, s1:Scalar<number>!{attribute:session.views}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<session>!{entity:session}
      "
    `);

    const visitor = lowerToPlan(
      analyzedCondition("visitor.sessions", "gte", 2),
    );
    expect(visitor.result).toMatchObject({
      kind: "supported",
      match: {
        nativeEntity: "visitor",
        entitySlot: "entity",
        relation: { grain: { kind: "entity", entity: "visitor" } },
      },
    });
    expect(expectRoundTrip(visitor.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<visitor> grain=Entity<visitor>[s0] domain=candidate
        VALUE self -> s0:Entity<visitor>!{entity:visitor}
        VALUE attribute=visitor.sessions -> s1:Scalar<number>!{attribute:visitor.sessions}
        OUTPUT s0:Entity<visitor>!{entity:visitor}, s1:Scalar<number>!{attribute:visitor.sessions}

      r1 Filter grain=Entity<visitor>[s0] input=r0
        WHERE (s1 gte 2:Scalar<number>)
        OUTPUT s0:Entity<visitor>!{entity:visitor}, s1:Scalar<number>!{attribute:visitor.sessions}

      Outputs
        "matches" from r1
          "entity" -> s0:Entity<visitor>!{entity:visitor}
      "
    `);
  });

  it("returns stable unsupported results for legal non-primitive Filter v1 features", () => {
    const between = lowerToPlan(
      analyzedCondition("page.durationMs", "between", [100, 500]),
    );
    expect(between.result).toEqual({
      kind: "unsupported",
      code: "unsupported-operator",
      fieldId: "page.durationMs",
      operator: "between",
    });
    expect(between.builder.finish().nodes).toEqual([]);

    const emptyString = lowerToPlan(analyzedCondition("page.path", "isEmpty"));
    expect(emptyString.result).toMatchObject({
      kind: "unsupported",
      code: "unsupported-operator",
      fieldId: "page.path",
      operator: "isEmpty",
    });

    for (const operator of ["exists", "notExists", "notEmpty"] as const) {
      const result = lowerToPlan(analyzedCondition("page.path", operator));
      expect(result.result).toMatchObject({
        kind: "unsupported",
        code: "unsupported-operator",
        fieldId: "page.path",
        operator,
      });
    }

    const payload = analyzedPayloadCondition();
    const payloadResult = lowerFilterCondition(
      createBuilder(),
      payload.analysis,
      payload.condition,
      "candidate",
    );
    expect(payloadResult).toEqual({
      kind: "unsupported",
      code: "unsupported-target",
      operator: "eq",
    });

    const derived = lowerToPlan(
      analyzedCondition("session.entryPath", "eq", "/home"),
    );
    expect(derived.result).toMatchObject({
      kind: "unsupported",
      code: "unsupported-evaluation",
      fieldId: "session.entryPath",
    });
  });

  it("rejects invalid, unanalysed, or mismatched conditions and time domains", () => {
    const first = analyzedCondition("page.path", "eq", "/home");
    const other = analyzedCondition("geo.country", "eq", "US");
    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        first.analysis,
        other.condition,
        "candidate",
      ),
    ).toThrow("filter_lowering_condition_not_analyzed");

    const staleDocument = analyzedCondition("page.path", "eq", "/home");
    const replacement = analyzedCondition("geo.country", "eq", "US");
    Object.assign(staleDocument.document, { root: replacement.condition });
    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        staleDocument.analysis,
        staleDocument.condition,
        "candidate",
      ),
    ).toThrow("filter_lowering_condition_not_analyzed");

    const unanalysed = {
      ...first.analysis,
      conditions: new WeakMap(),
    } as AnalyzedFilterDocument;
    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        unanalysed,
        first.condition,
        "candidate",
      ),
    ).toThrow("filter_lowering_condition_not_analyzed");

    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        first.analysis,
        first.condition,
        "filter",
      ),
    ).toThrow("filter_lowering_invalid_temporal_domain");

    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        first.analysis,
        first.condition,
        undefined as never,
      ),
    ).toThrow("filter_lowering_temporal_domain_required");

    const forged = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.durationMs" },
        operator: "contains",
        value: "250",
      },
    } as unknown as FilterDocument;
    const forgedCondition = forged.root as FilterCondition;
    const forgedAnalysis = analyzeFilterDocument(
      forged,
      analyticsFilterRegistry,
    );
    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        forgedAnalysis,
        forgedCondition,
        "candidate",
      ),
    ).toThrow();

    const malformedSet = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.durationMs" },
        operator: "in",
        value: 250,
      },
    } as unknown as FilterDocument;
    const malformedSetCondition = malformedSet.root as FilterCondition;
    const malformedSetAnalysis = analyzeFilterDocument(
      malformedSet,
      analyticsFilterRegistry,
    );
    expect(() =>
      lowerFilterCondition(
        createBuilder(),
        malformedSetAnalysis,
        malformedSetCondition,
        "candidate",
      ),
    ).toThrow();

    const emptyDocument = normalizeFilterDocument(
      { version: 1, root: null },
      analyticsFilterRegistry,
    );
    const emptyAnalysis = analyzeFilterDocument(
      emptyDocument,
      analyticsFilterRegistry,
    );
    const emptyBuilder = createBuilder();
    expect(() =>
      lowerFilterCondition(
        emptyBuilder,
        emptyAnalysis,
        null as never,
        "candidate",
      ),
    ).toThrow("filter_lowering_invalid_condition");
    expect(emptyBuilder.finish().nodes).toEqual([]);
  });
});
