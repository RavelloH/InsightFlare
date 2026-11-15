import { describe, expect, it } from "vitest";

import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { planReferrersTimeMembershipDependency } from "@/lib/edge/analytics/engine/referrers-time-membership-plan";
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

describe("Referrers time membership execution recipe", () => {
  it("freezes independent prepare/read domains and whole filters without retaining mutable inputs", () => {
    const request = input();
    const plan = planReferrersTimeMembershipDependency(request)!;
    expect(plan.steps[0]).toMatchObject({
      strategy: "sql-membership",
      filterSemantics: "whole-original-tree",
      fallback: "bounded-core",
      filters: request.filters,
      queryTime: request.queryTime,
    });
    expect(plan.steps[1]).toMatchObject({
      strategy: "consume-dependency",
      sourceRole: "page",
      maxPlans: 1,
      maxSources: 1,
      queryTime: request.queryTime,
    });
    expect(plan.membership.time).toMatchObject({
      candidate: request.queryTime.range,
      filter: request.queryTime.filterRange,
      read: { kind: "bounded", range: request.queryTime.readRange },
    });
    expect(Object.isFrozen(plan.steps[0].filters.root)).toBe(true);
    request.queryTime.filterRange.startMs = 99;
    expect(plan.steps[0].queryTime.filterRange?.startMs).toBe(1);
  });
  it("refuses a report-fusion strategy", () => {
    const request = input();
    expect(
      planReferrersTimeMembershipDependency({
        ...request,
        execution: {
          ...request.execution,
          decision: {
            ...request.execution.decision,
            strategy: "sql-report-fusion",
          },
        },
      }),
    ).toBeUndefined();
  });
  it("requires independent Count support even when another proof selected SQL membership", () => {
    const request = input();
    expect(
      planReferrersTimeMembershipDependency({
        ...request,
        execution: {
          ...request.execution,
          support: {
            kind: "unsupported",
            code: "sequence-only",
            path: "root",
            reason: "Seq membership cannot grant Count eligibility.",
          },
        },
      }),
    ).toBeUndefined();
  });
  it("refuses activity-grain membership", () => {
    const request = input();
    expect(
      planReferrersTimeMembershipDependency({
        ...request,
        execution: {
          ...request.execution,
          decision: {
            ...request.execution.decision,
            membership: {
              ...request.execution.decision.membership,
              identity: {
                ...request.execution.decision.membership.identity,
                grain: "activity",
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
