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
});
