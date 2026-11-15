import { describe, expect, it } from "vitest";

import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { ADVANCED_FILTER_LEAF_CAPABILITIES } from "@/lib/edge/analytics/engine/advanced-filter-leaf-capabilities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const subject = createSemanticSubjectDomain({
  origin: "site",
  siteIds: ["planner-site" as SiteId],
});
const time = createQueryTime(100, 200, "UTC", 300);
const base =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
function plan(
  dsl: string,
  overrides: Partial<Parameters<typeof planAdvancedFilterExecution>[0]> = {},
) {
  return planAdvancedFilterExecution({
    subject,
    time,
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    scope: "session",
    reportFusionAvailable: true,
    ...overrides,
  });
}

describe("advanced filter strategy planning", () => {
  it("collects a computed leaf independently of an earlier field leaf", () => {
    const result = plan('page.path eq "/" and event exists');
    expect(result.decision.leafCapabilities.map((leaf) => leaf.family)).toEqual(
      ["computed", "field"],
    );
  });
  it.each(["session", "visitor"] as const)(
    "describes same-site %s grain and both activity roles",
    (scope) => {
      const result = plan(base, { scope });
      expect(result.decision).toMatchObject({
        strategy: "sql-report-fusion",
        wholeTreeProof: { kind: "supported" },
        membership: {
          subject,
          activityRoles: ["page", "event"],
          identity: { site: "siteId", grain: scope, roles: [scope] },
          expressionDomain: "candidate",
        },
      });
      expect(
        result.decision.leafCapabilities.map((leaf) => leaf.family),
      ).toEqual(["count", "field"]);
      expect(result.decision.permittedStrategies).toEqual([
        "sql-report-fusion",
        "sql-membership",
        "bounded-core",
      ]);
    },
  );

  it("keeps time predicates on SQL membership only with their explicit expression window", () => {
    const dsl = `${base} and time gte @range.start+1ms`;
    const missing = plan(dsl);
    expect(missing.decision).toMatchObject({
      strategy: "bounded-core",
      reason: "count_sql_time_leaf_unsupported",
    });
    const explicit = plan(dsl, {
      time: { ...time, filterRange: { startMs: 101, endExclusiveMs: 200 } },
    });
    expect(explicit.decision).toMatchObject({
      strategy: "sql-membership",
      reason: "independent-membership-time-domains",
      membership: {
        expressionDomain: "filter",
        time: {
          candidate: time.range,
          filter: { startMs: 101, endExclusiveMs: 200 },
          capturedAtMs: 300,
        },
      },
    });
    expect(explicit.decision.leafCapabilities).toContainEqual(
      ADVANCED_FILTER_LEAF_CAPABILITIES.time,
    );
    expect(explicit.decision.permittedStrategies).toEqual([
      "sql-membership",
      "bounded-core",
    ]);
  });

  it("requires the whole-tree proof even when every field/count leaf permits SQL", () => {
    const result = plan(
      'count(event { event.name eq "qualifier" }) gte 1 or count(periods(event, 1w) { count($items) gte 3 }) gte 2',
    );
    expect(
      result.decision.leafCapabilities.every((leaf) =>
        leaf.permittedStrategies.includes("sql-membership"),
      ),
    ).toBe(true);
    expect(result.decision).toMatchObject({
      strategy: "bounded-core",
      wholeTreeProof: { kind: "unsupported" },
    });
  });

  it("keeps retained-history Seq on bounded Core", () => {
    const result = plan(
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      { time: { ...time, fullHistory: true } },
    );
    expect(result.decision).toMatchObject({
      strategy: "bounded-core",
      coreBounds: {
        maxActivities: 20000,
        maxSequenceMatches: 50000,
        maxSequenceWork: 1000000,
      },
    });
    expect(result.decision.leafCapabilities).toContainEqual(
      ADVANCED_FILTER_LEAF_CAPABILITIES.seq,
    );
  });

  it.each(["session", "visitor"] as const)(
    "declares a separate whole-tree %s Seq membership proof",
    (scope) => {
      const result = plan(
        'sequence([window(page { page.path eq "/" },@range.start,[0ms,99ms]),window(event { event.name eq "purchase" },@range.start,[0ms,99ms])]) exists',
        { scope },
      );
      expect(result.decision).toMatchObject({
        strategy: "sql-membership",
        reason: "whole-tree-sequence-membership-supported",
        permittedStrategies: ["sql-membership", "bounded-core"],
        wholeTreeProof: {
          kind: "supported",
          code: "sequence_sql_two_step_exists",
        },
      });
      expect(result.sequenceSupport?.kind).toBe("supported");
      expect(result.support.kind).toBe("unsupported");
    },
  );

  it("does not infer whole-tree Seq support from permitted leaves", () => {
    const result = plan(
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists OR page.path eq "/"',
    );
    expect(result.decision.strategy).toBe("bounded-core");
    expect(result.sequenceSupport).toBeUndefined();
  });

  it("leaves invalid document errors with the existing whole-tree classifier", () => {
    expect(() =>
      plan(base, {
        filters: {
          version: 1,
          root: { kind: "unknown" },
        } as unknown as FilterDocument,
      }),
    ).not.toThrow();
    expect(
      plan(base, {
        filters: {
          version: 1,
          root: { kind: "unknown" },
        } as unknown as FilterDocument,
      }).decision.strategy,
    ).toBe("bounded-core");
  });
});
