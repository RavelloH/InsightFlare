import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
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
  const candidate = builder.source("visitor");
  const matchingA = builder.distinctEntity(
    builder.source("observation", { relationships: ["observation.visitor"] }),
    "relationship:observation.visitor",
    "visitor",
  );
  const matchingB = builder.distinctEntity(
    builder.source("observation", { relationships: ["observation.visitor"] }),
    "relationship:observation.visitor",
    "visitor",
  );
  const matchA = {
    kind: "match" as const,
    value: {
      nativeEntity: "observation" as const,
      relation: matchingA,
      entitySlot: "visitor",
    },
  };
  const matchB = {
    kind: "match" as const,
    value: {
      nativeEntity: "observation" as const,
      relation: matchingB,
      entitySlot: "visitor",
    },
  };
  const selection = resolveScopeFilterSelection(
    builder,
    { scope: "visitor", relation: candidate, entitySlot: "entity" },
    {
      kind: "or",
      children: [
        { kind: "and", children: [matchA, { kind: "not", child: matchB }] },
        matchB,
      ],
    },
    {
      convert(match, target) {
        return builder.semiJoin(target.relation, match.relation, [
          { left: target.entitySlot, right: match.entitySlot },
        ]);
      },
    },
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

      r0 Source<visitor> grain=Entity<visitor>[s0] domain=candidate
        VALUE self -> s0:Entity<visitor>!{entity:visitor}
        OUTPUT s0:Entity<visitor>!{entity:visitor}

      r1 Source<observation> grain=Entity<observation>[s1] domain=candidate
        VALUE self -> s1:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s2:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s1:Entity<observation>!{entity:observation}, s2:Entity<visitor>?{relationship:observation.visitor}

      r2 Distinct grain=Entity<visitor>[s3] excludeNull=true
        KEY s3:Entity<visitor>!{alias:s2} := s2:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s3:Entity<visitor>!{alias:s2}

      r3 Source<observation> grain=Entity<observation>[s4] domain=candidate
        VALUE self -> s4:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s5:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s4:Entity<observation>!{entity:observation}, s5:Entity<visitor>?{relationship:observation.visitor}

      r4 Distinct grain=Entity<visitor>[s6] excludeNull=true
        KEY s6:Entity<visitor>!{alias:s5} := s5:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s6:Entity<visitor>!{alias:s5}

      r5 SemiJoin grain=Entity<visitor>[s0]
        LEFT r0
        RIGHT r2
        ON s0:Entity<visitor>!{entity:visitor} = s3:Entity<visitor>!{alias:s2}
        OUTPUT s0:Entity<visitor>!{entity:visitor}

      r6 SemiJoin grain=Entity<visitor>[s0]
        LEFT r0
        RIGHT r4
        ON s0:Entity<visitor>!{entity:visitor} = s6:Entity<visitor>!{alias:s5}
        OUTPUT s0:Entity<visitor>!{entity:visitor}

      r7 Difference grain=Entity<visitor>[s7] inputs=[r0, r6]
        INPUT r0
        INPUT r6
        OUTPUT s7:Entity<visitor>!{derived:set:difference(s0,s0)}

      r8 Intersect grain=Entity<visitor>[s8] inputs=[r5, r7]
        INPUT r5
        INPUT r7
        OUTPUT s8:Entity<visitor>!{derived:set:intersect(s0,s7)}

      r9 SemiJoin grain=Entity<visitor>[s0]
        LEFT r0
        RIGHT r4
        ON s0:Entity<visitor>!{entity:visitor} = s6:Entity<visitor>!{alias:s5}
        OUTPUT s0:Entity<visitor>!{entity:visitor}

      r10 Union grain=Entity<visitor>[s9] inputs=[r8, r9]
        INPUT r8
        INPUT r9
        OUTPUT s9:Entity<visitor>!{derived:set:union(s8,s0)}

      Outputs
        "visitor-scope" from r10
          "visitor" -> s9:Entity<visitor>!{derived:set:union(s8,s0)}
      "
    `);
  });
});
