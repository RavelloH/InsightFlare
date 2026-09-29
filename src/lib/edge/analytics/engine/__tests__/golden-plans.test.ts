import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  createCandidateScopeUniverse,
  createNativeMatchConverter,
  LazyEligibleDataset,
  type LogicalPlan,
  LogicalPlanBuilder,
  type PlannedGrouping,
  planSemanticAggregateQuery,
  printLogicalPlan,
  resolveScopeFilterSelection,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function context() {
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
      filter: { startMs: 0, endExclusiveMs: 90_000_000 },
      read: { kind: "retained-history" as const },
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

function expectSerializablePlan(plan: LogicalPlan): void {
  const parsed = JSON.parse(JSON.stringify(plan)) as LogicalPlan;
  expect(validateLogicalPlan(parsed)).toEqual(plan);
}

function equalsString(
  builder: LogicalPlanBuilder,
  relation: ReturnType<LogicalPlanBuilder["source"]>,
  slotName: string,
  value: string,
) {
  return builder.compare(
    "eq",
    builder.slot(relation, slotName),
    builder.literal(value, { kind: "scalar", scalar: "string" }),
  );
}

function planCandidateScopeScenario(
  kind:
    | "session-browser"
    | "visitor-page"
    | "observation-session-fact"
    | "history-visitor",
) {
  const builder = new LogicalPlanBuilder(context());
  let relation: ReturnType<LogicalPlanBuilder["source"]>;
  if (kind === "session-browser") {
    const evidence = builder.source("observation", {
      temporalDomain: "read",
      attributes: ["client.browser"],
      relationships: ["observation.session"],
    });
    const filtered = builder.filter(
      evidence,
      equalsString(builder, evidence, "attribute:client.browser", "Chrome"),
    );
    const matchingSessions = builder.distinctEntity(
      filtered,
      "relationship:observation.session",
      "session",
    );
    const candidatePages = builder.source("page", {
      temporalDomain: "candidate",
      relationships: ["page.session"],
    });
    relation = builder.semiJoin(candidatePages, matchingSessions, [
      { left: "relationship:page.session", right: "session" },
    ]);
  } else if (kind === "visitor-page") {
    const evidence = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.path"],
      relationships: ["page.visitor"],
    });
    const filtered = builder.filter(
      evidence,
      equalsString(builder, evidence, "attribute:page.path", "/pricing"),
    );
    const matchingVisitors = builder.distinctEntity(
      filtered,
      "relationship:page.visitor",
      "visitor",
    );
    const candidateObservations = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.visitor"],
    });
    relation = builder.semiJoin(candidateObservations, matchingVisitors, [
      { left: "relationship:observation.visitor", right: "visitor" },
    ]);
  } else if (kind === "observation-session-fact") {
    const sessionEvidence = builder.source("session", {
      temporalDomain: "read",
      attributes: ["session.durationMs"],
    });
    const duration = builder.slot(
      sessionEvidence,
      "attribute:session.durationMs",
    );
    const filteredSessions = builder.filter(
      sessionEvidence,
      builder.compare(
        "gte",
        duration,
        builder.literal(60_000, {
          kind: "scalar",
          scalar: "number",
          unit: "ms",
        }),
      ),
    );
    const candidateObservations = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.session"],
    });
    relation = builder.semiJoin(candidateObservations, filteredSessions, [
      { left: "relationship:observation.session", right: "entity" },
    ]);
  } else {
    const historyEvidence = builder.source("observation", {
      temporalDomain: "read",
      attributes: ["geo.country"],
      relationships: ["observation.visitor"],
    });
    const filtered = builder.filter(
      historyEvidence,
      equalsString(builder, historyEvidence, "attribute:geo.country", "US"),
    );
    const historyVisitors = builder.distinctEntity(
      filtered,
      "relationship:observation.visitor",
      "visitor",
    );
    const candidateVisitors = builder.source("visitor", {
      temporalDomain: "candidate",
    });
    relation = builder.semiJoin(candidateVisitors, historyVisitors, [
      { left: "entity", right: "visitor" },
    ]);
  }
  builder.output(kind, relation, [{ name: "entity", slot: "entity" }]);
  return builder.finish();
}

function overviewPrinterPlan(): LogicalPlan {
  const builder = new LogicalPlanBuilder(context());
  const pages = builder.source("page", { attributes: ["page.path"] });
  const overview = builder.aggregate(pages, {}, [
    { name: "views", kind: "count-rows" },
  ]);
  builder.output("overview", overview, [
    { name: "views", slot: "views", semantic: { kind: "metric", id: "views" } },
  ]);
  return builder.finish();
}

function countryBreakdownPrinterPlan(): LogicalPlan {
  const builder = new LogicalPlanBuilder(context());
  const pages = builder.source("page", { attributes: ["geo.country"] });
  const breakdown = builder.aggregate(
    pages,
    { country: builder.slot(pages, "attribute:geo.country") },
    [{ name: "views", kind: "count-rows" }],
  );
  builder.output("country-breakdown", breakdown, [
    {
      name: "country",
      slot: "country",
      semantic: { kind: "dimension", id: "geo.country" },
    },
    { name: "views", slot: "views", semantic: { kind: "metric", id: "views" } },
  ]);
  return builder.finish();
}

function booleanScopePrinterPlan(): LogicalPlan {
  const builder = new LogicalPlanBuilder(context());
  const candidate = createCandidateScopeUniverse(builder, "visitor");
  const matchingA = builder.distinctEntity(
    builder.source("observation", {
      temporalDomain: "read",
      relationships: ["observation.visitor"],
    }),
    "relationship:observation.visitor",
    "entity",
  );
  const matchingB = builder.distinctEntity(
    builder.source("observation", {
      temporalDomain: "read",
      relationships: ["observation.visitor"],
    }),
    "relationship:observation.visitor",
    "entity",
  );
  const matchA = {
    kind: "match" as const,
    value: {
      nativeEntity: "visitor" as const,
      relation: matchingA,
      entitySlot: "entity",
      temporalDomain: "read" as const,
    },
  };
  const matchB = {
    kind: "match" as const,
    value: {
      nativeEntity: "visitor" as const,
      relation: matchingB,
      entitySlot: "entity",
      temporalDomain: "read" as const,
    },
  };
  const selection = resolveScopeFilterSelection(
    builder,
    candidate,
    {
      kind: "or",
      children: [
        { kind: "and", children: [matchA, { kind: "not", child: matchB }] },
        matchB,
      ],
    },
    createNativeMatchConverter(builder),
  );
  if (selection.kind !== "matching")
    throw new Error("expected_matching_scope_fixture");
  builder.output("visitor-scope", selection.relation, [
    { name: "visitor", slot: "entity" },
  ]);
  return builder.finish();
}

describe("Phase 4A golden logical plans", () => {
  it("builds a Trend by day from occurrence time and prints deterministically", () => {
    const queryContext = context();
    const builder = new LogicalPlanBuilder(queryContext);
    const spineSource = builder.source("page", { includeOccurrenceTime: true });
    const timeBucket = builder.timeBucket(
      builder.slot(spineSource, "time"),
      "day",
    );
    const spine = builder.aggregate(spineSource, { day: timeBucket }, [
      { name: "seedCount", kind: "count-rows" },
    ]);
    const grouping: PlannedGrouping = {
      spine,
      dimensions: new Map(),
      timeBucket: { slot: spine.slots.day!, granularity: "day" },
    };
    const dataset = new LazyEligibleDataset({
      subject: queryContext.subject,
      scope: { kind: "unfiltered" },
      resolveRelation(entity) {
        return builder.source(entity, {
          ...(entity === "page" ? { includeOccurrenceTime: true } : {}),
        });
      },
      resolveAssociation(entity) {
        if (entity !== "page") throw new Error("unexpected_trend_entity");
        const page = builder.source("page", { includeOccurrenceTime: true });
        return builder.project(page, {
          timeBucket: builder.timeBucket(builder.slot(page, "time"), "day"),
          entity: builder.slot(page, "entity"),
        });
      },
    });
    const plan = planSemanticAggregateQuery(
      builder,
      {
        context: queryContext,
        dimensions: [],
        metrics: ["views"],
        sort: [{ field: "timeBucket", direction: "asc", nulls: "last" }],
        timeBucket: { granularity: "day" },
      },
      dataset,
      grouping,
    );
    expect(plan.nodes.some((node) => node.kind === "sort")).toBe(true);
    expectSerializablePlan(plan);
    expect(printLogicalPlan(plan)).toContain("TIME_BUCKET");
    expect(printLogicalPlan(plan)).toBe(printLogicalPlan(plan));
  });

  it.each([
    "session-browser",
    "visitor-page",
    "observation-session-fact",
    "history-visitor",
  ] as const)(
    "keeps %s evidence separate from the candidate universe",
    (kind) => {
      const plan = planCandidateScopeScenario(kind);
      expectSerializablePlan(plan);
      const semiJoin = plan.nodes.find((node) => node.kind === "semi-join");
      expect(semiJoin?.kind).toBe("semi-join");
      expect(
        plan.nodes.some(
          (node) => node.kind === "source" && node.temporalDomain === "read",
        ),
      ).toBe(true);
      expect(plan.nodes.some((node) => node.kind === "distinct")).toBe(
        kind !== "observation-session-fact",
      );
    },
  );

  it("freezes the Overview printer", () => {
    expect(printLogicalPlan(overviewPrinterPlan())).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<page> grain=Entity<page>[s0] domain=candidate
        VALUE self -> s0:Entity<page>!{entity:page}
        VALUE attribute=page.path -> s1:Scalar<string>?{attribute:page.path}
        OUTPUT s0:Entity<page>!{entity:page}, s1:Scalar<string>?{attribute:page.path}

      r1 Aggregate grain=Scalar input=r0
        MEASURE s2=COUNT_ROWS
        OUTPUT s2:Scalar<number>!{derived:aggregate:count-rows()}

      Outputs
        "overview" from r1
          "views" -> s2:Scalar<number>!{derived:aggregate:count-rows()} semantic=metric:views
      "
    `);
  });

  it("freezes the Country Breakdown printer", () => {
    expect(printLogicalPlan(countryBreakdownPrinterPlan()))
      .toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<page> grain=Entity<page>[s0] domain=candidate
        VALUE self -> s0:Entity<page>!{entity:page}
        VALUE attribute=geo.country -> s1:Scalar<string>?{attribute:geo.country}
        OUTPUT s0:Entity<page>!{entity:page}, s1:Scalar<string>?{attribute:geo.country}

      r1 Aggregate grain=Keyed[s2] input=r0
        GROUP s2:Scalar<string>?{derived:group(s1)} := s1
        MEASURE s3=COUNT_ROWS
        OUTPUT s2:Scalar<string>?{derived:group(s1)}, s3:Scalar<number>!{derived:aggregate:count-rows()}

      Outputs
        "country-breakdown" from r1
          "country" -> s2:Scalar<string>?{derived:group(s1)} semantic=dimension:geo.country
          "views" -> s3:Scalar<number>!{derived:aggregate:count-rows()} semantic=metric:views
      "
    `);
  });

  it("freezes the AND / OR / NOT scope printer", () => {
    expect(printLogicalPlan(booleanScopePrinterPlan())).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<visitor>?{relationship:observation.visitor}

      r1 Distinct grain=Entity<visitor>[s2] excludeNull=true
        KEY s2:Entity<visitor>!{alias:s1} := s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s2:Entity<visitor>!{alias:s1}

      r2 Source<observation> grain=Entity<observation>[s3] domain=read
        VALUE self -> s3:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s4:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s3:Entity<observation>!{entity:observation}, s4:Entity<visitor>?{relationship:observation.visitor}

      r3 Distinct grain=Entity<visitor>[s5] excludeNull=true
        KEY s5:Entity<visitor>!{alias:s4} := s4:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s5:Entity<visitor>!{alias:s4}

      r4 Source<observation> grain=Entity<observation>[s6] domain=read
        VALUE self -> s6:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s7:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s6:Entity<observation>!{entity:observation}, s7:Entity<visitor>?{relationship:observation.visitor}

      r5 Distinct grain=Entity<visitor>[s8] excludeNull=true
        KEY s8:Entity<visitor>!{alias:s7} := s7:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s8:Entity<visitor>!{alias:s7}

      r6 Project grain=Entity<visitor>[s9] input=r3
        s9:Entity<visitor>!{alias:s5} := s5
        OUTPUT s9:Entity<visitor>!{alias:s5}

      r7 Distinct grain=Entity<visitor>[s10] excludeNull=true
        KEY s10:Entity<visitor>!{alias:s9} := s9:Entity<visitor>!{alias:s5}
        OUTPUT s10:Entity<visitor>!{alias:s9}

      r8 Intersect grain=Entity<visitor>[s11] inputs=[r1, r7]
        INPUT r1
        INPUT r7
        OUTPUT s11:Entity<visitor>!{derived:set:intersect(s2,s10)}

      r9 Project grain=Entity<visitor>[s12] input=r5
        s12:Entity<visitor>!{alias:s8} := s8
        OUTPUT s12:Entity<visitor>!{alias:s8}

      r10 Distinct grain=Entity<visitor>[s13] excludeNull=true
        KEY s13:Entity<visitor>!{alias:s12} := s12:Entity<visitor>!{alias:s8}
        OUTPUT s13:Entity<visitor>!{alias:s12}

      r11 Intersect grain=Entity<visitor>[s14] inputs=[r1, r10]
        INPUT r1
        INPUT r10
        OUTPUT s14:Entity<visitor>!{derived:set:intersect(s2,s13)}

      r12 Difference grain=Entity<visitor>[s15] inputs=[r1, r11]
        INPUT r1
        INPUT r11
        OUTPUT s15:Entity<visitor>!{derived:set:difference(s2,s14)}

      r13 Intersect grain=Entity<visitor>[s16] inputs=[r8, r12]
        INPUT r8
        INPUT r12
        OUTPUT s16:Entity<visitor>!{derived:set:intersect(s11,s15)}

      r14 Project grain=Entity<visitor>[s17] input=r5
        s17:Entity<visitor>!{alias:s8} := s8
        OUTPUT s17:Entity<visitor>!{alias:s8}

      r15 Distinct grain=Entity<visitor>[s18] excludeNull=true
        KEY s18:Entity<visitor>!{alias:s17} := s17:Entity<visitor>!{alias:s8}
        OUTPUT s18:Entity<visitor>!{alias:s17}

      r16 Intersect grain=Entity<visitor>[s19] inputs=[r1, r15]
        INPUT r1
        INPUT r15
        OUTPUT s19:Entity<visitor>!{derived:set:intersect(s2,s18)}

      r17 Union grain=Entity<visitor>[s20] inputs=[r13, r16]
        INPUT r13
        INPUT r16
        OUTPUT s20:Entity<visitor>!{derived:set:union(s16,s19)}

      Outputs
        "visitor-scope" from r17
          "visitor" -> s20:Entity<visitor>!{derived:set:union(s16,s19)}
      "
    `);
  });
});
