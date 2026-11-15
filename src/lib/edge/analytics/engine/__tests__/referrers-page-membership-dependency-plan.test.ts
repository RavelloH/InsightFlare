import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { planReferrersPageMembershipDependencies } from "@/lib/edge/analytics/engine/referrers-page-membership-dependency-plan";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

type Input = Parameters<typeof planReferrersPageMembershipDependencies>[0];
function input(): Input {
  const time = {
    ...createQueryTime(100, 200, "UTC", 400),
    readRange: createQueryTime(200, 401, "UTC", 400).range,
    filterRange: createQueryTime(200, 401, "UTC", 400).range,
  };
  const filters = parseFilterDsl(
    "count(page) gt 0 and time gte @range.end",
    analyticsFilterRegistry,
  );
  return {
    preparation: {
      key: "original",
      filters,
      queryTime: time,
      execution: planAdvancedFilterExecution({
        subject: semanticSubjectFromQuerySubject(
          siteQueryContext("site", "private-dashboard").subject,
        ),
        filters,
        scope: "session",
        time,
        reportFusionAvailable: false,
      }),
    },
    readerQueryTime: time,
    configuration: {
      limit: 2,
      includeFullUrl: false,
      cursorText: null,
      audience: "private-dashboard",
      sortBy: "views",
      sortDirection: "desc",
    },
  };
}
describe("Referrers Page membership dependency recipe", () => {
  it("freezes ordered whole-filter preparation, original cursor decode and one Page reader", () => {
    const request = input(),
      plan = planReferrersPageMembershipDependencies(request)!;
    expect(plan.steps.map((step) => step!.kind)).toEqual([
      "prepare-membership",
      "decode-page-cursor",
      "read-report",
    ]);
    expect(plan.steps[0]!.queryTime).toEqual(request.preparation.queryTime);
    expect(plan.steps[1].queryTime).toEqual(request.readerQueryTime);
    expect(plan.steps[2]).toMatchObject({
      preparationKey: "original",
      sourceRole: "page",
      maxPlans: 1,
      maxSources: 1,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps[0]!.filters)).toBe(true);
    expect(plan.consumer.configuration).toEqual(request.configuration);
  });
  it.each([
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { includeFullUrl: "yes" },
    { search: 1 },
    { cursorText: 1 },
    { audience: "api-v1" },
    { sortBy: "unknown" },
    { sortDirection: "unknown" },
  ])("refuses invalid reader declaration %j", (invalid) => {
    const request = input();
    expect(
      planReferrersPageMembershipDependencies({
        ...request,
        configuration: {
          ...request.configuration,
          ...invalid,
        } as Input["configuration"],
      }),
    ).toBeUndefined();
  });
  it("accepts reader limit zero without increasing its one-plan/source budget", () => {
    const request = input();
    expect(
      planReferrersPageMembershipDependencies({
        ...request,
        configuration: {
          ...request.configuration,
          limit: 0,
          search: "",
          cursorText: "opaque-cursor",
          includeFullUrl: true,
          sortBy: "visitors",
          sortDirection: "asc",
        },
      })!.steps[2],
    ).toMatchObject({ maxPlans: 1, maxSources: 1 });
  });
  it("refuses unsupported Count proof even when separate sequence membership is supported", () => {
    const request = input(),
      filters = parseFilterDsl(
        "sequence([window(page,@range.start,[0ms,99ms]),window(event,@range.start,[0ms,99ms])]) exists",
        analyticsFilterRegistry,
      );
    const time = createQueryTime(100, 200, "UTC", 400);
    const execution = planAdvancedFilterExecution({
      subject: semanticSubjectFromQuerySubject(
        siteQueryContext("site", "private-dashboard").subject,
      ),
      filters,
      scope: "session",
      time,
      reportFusionAvailable: false,
    });
    expect(execution.sequenceSupport?.kind).toBe("supported");
    expect(execution.support.kind).toBe("unsupported");
    expect(
      planReferrersPageMembershipDependencies({
        ...request,
        preparation: { key: "original", execution, filters, queryTime: time },
        readerQueryTime: time,
      }),
    ).toBeUndefined();
  });
});
