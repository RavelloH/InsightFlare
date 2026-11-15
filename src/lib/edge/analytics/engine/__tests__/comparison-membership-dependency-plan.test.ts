import { describe, expect, it } from "vitest";

import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { planComparisonMembershipDependencies } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

function input() {
  const filters = parseFilterDsl(
    "count(page) gt 0 and time gte @range.start+1ms",
    analyticsFilterRegistry,
  );
  const queryTime = {
    ...createQueryTime(0, 100, "UTC", 200),
    filterRange: { startMs: 1, endExclusiveMs: 201 },
    readRange: createQueryTime(1, 201, "UTC", 200).range,
  };
  const execution = planAdvancedFilterExecution({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["time-site" as never],
    }),
    filters,
    scope: "session",
    time: queryTime,
    reportFusionAvailable: false,
  });
  return { filters, queryTime, execution, topN: 10 };
}

describe("comparison membership execution recipe", () => {
  function make() {
    const a = input(),
      b = input();
    return {
      current: { ...a, readerQueryTime: a.queryTime },
      reference: { ...b, readerQueryTime: b.queryTime },
      consumer: { operation: "comparison" },
    };
  }
  it("freezes whole-tree independent preparation steps and a bounded read recipe", () => {
    const value = make(),
      plan = planComparisonMembershipDependencies(value)!;
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "prepare-membership",
      "prepare-membership",
      "read-report",
    ]);
    expect(plan.steps[0].filters).toEqual(value.current.filters);
    expect(plan.steps[0].bounds).toEqual(
      value.current.execution.decision.coreBounds,
    );
    expect(plan.steps[2]).toMatchObject({
      maxPlansPerSide: 1,
      maxSourcesPerSide: 1,
    });
    expect(Object.isFrozen(plan.steps[0].filters.root)).toBe(true);
    value.current.queryTime.filterRange.startMs = 99;
    expect(plan.steps[0].queryTime.filterRange?.startMs).toBe(1);
  });
  it.each(["fusion", "unsupported", "activity"] as const)(
    "refuses %s side eligibility",
    (kind) => {
      const value = make();
      if (kind === "fusion")
        value.current.execution = {
          ...value.current.execution,
          decision: {
            ...value.current.execution.decision,
            strategy: "sql-report-fusion",
          },
        };
      if (kind === "unsupported")
        value.current.execution = {
          ...value.current.execution,
          support: {
            kind: "unsupported",
            code: "no-count-proof",
            path: "root",
            reason: "No Count support",
          },
        };
      if (kind === "activity")
        value.current.execution = {
          ...value.current.execution,
          decision: {
            ...value.current.execution.decision,
            membership: {
              ...value.current.execution.decision.membership,
              identity: {
                ...value.current.execution.decision.membership.identity,
                grain: "activity",
              },
            },
          },
        };
      expect(planComparisonMembershipDependencies(value)).toBeUndefined();
    },
  );
});
