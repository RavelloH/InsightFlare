// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { dimensionPageSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import * as dimensions from "@/lib/edge/analytics/engine/dimension-report-plan";
import * as dependencies from "@/lib/edge/analytics/engine/membership-dependency-plan";
import {
  type PageChannelMembershipReader,
  planPageChannelMembershipDependencies,
} from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import {
  PAGE_MEMBERSHIP_DIMENSIONS,
  pageMembershipDimensionContract,
} from "@/lib/edge/analytics/engine/page-channel-membership-reader-contract";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
function input(scope: "session" | "visitor" = "session") {
  const readerQueryTime = createQueryTime(100, 200, "UTC", 400);
  const queryTime = {
    ...readerQueryTime,
    readRange: { ...createQueryTime(200, 401, "UTC", 400).range },
    filterRange: { ...createQueryTime(200, 401, "UTC", 400).range },
  };
  const filters = parseFilterDsl(
    "count(page) gt 0 and time gte @range.end",
    analyticsFilterRegistry,
  );
  return {
    preparation: {
      key: "original",
      filters,
      queryTime,
      execution: planAdvancedFilterExecution({
        subject: semanticSubjectFromQuerySubject(
          siteQueryContext("site", "private-dashboard").subject,
        ),
        filters,
        scope,
        time: queryTime,
        reportFusionAvailable: false,
      }),
    },
    readerQueryTime,
    reader: {
      kind: "dimension-page",
      dimension: "page.path",
      limit: 2,
      cursorText: null,
      excludeEmpty: false,
      sortBy: "views",
      sortDirection: "desc",
      audience: "private-dashboard",
    } as PageChannelMembershipReader,
  };
}
describe("closed Page dimension/channel membership declarations", () => {
  it.each(PAGE_MEMBERSHIP_DIMENSIONS)(
    "uses exact existing dimension selection %s",
    (dimension) => {
      const c = pageMembershipDimensionContract(dimension)!;
      expect(c.selection).toBe(dimensionPageSelection(dimension));
      expect(c).toMatchObject({
        sourceRole: "page",
        maxSources: 1,
        maxPlans: 1,
        outputId: "dimension-page",
      });
      const request = input();
      expect(
        planPageChannelMembershipDependencies({
          ...request,
          reader: {
            ...request.reader,
            dimension,
          } as PageChannelMembershipReader,
        })?.children[0],
      ).toMatchObject({ selection: c.selection });
    },
  );
  it.each([
    "event.name",
    "session.entryPath",
    "session.exitPath",
    "unknown",
    "__proto__",
    "constructor",
  ])("rejects non-Page/unknown selection %s", (dimension) =>
    expect(pageMembershipDimensionContract(dimension)).toBeUndefined(),
  );
  it.each(["session", "visitor"] as const)(
    "prepares complete original %s membership before cursor and Page read",
    (scope) => {
      const request = input(scope);
      const plan = planPageChannelMembershipDependencies(request)!;
      expect(plan).toBeDefined();
      expect(plan.steps.map((s) => s.kind)).toEqual([
        "prepare-membership",
        "decode-page-cursor",
        "read-report",
      ]);
      expect(plan.preparations[0]).toMatchObject({
        filters: request.preparation.filters,
        queryTime: request.preparation.queryTime,
        bounds: request.preparation.execution.decision.coreBounds,
      });
      expect(plan.children[0]?.queryTime).toEqual(request.readerQueryTime);
      expect(plan.children).toHaveLength(1);
      expect(plan.children[0]?.queryTime).not.toEqual(
        plan.preparations[0]?.queryTime,
      );
      expect(Object.isFrozen(plan.preparations[0]?.filters)).toBe(true);
      expect(Object.isFrozen(plan.preparations[0]?.queryTime.readRange)).toBe(
        true,
      );
      request.preparation.queryTime.readRange.startMs = createQueryTime(
        999,
        1000,
        "UTC",
        1000,
      ).range.startMs;
      expect(plan.preparations[0]?.queryTime.readRange?.startMs).toBe(200);
    },
  );
  it("declares channel list with unchanged original source limit and no cursor stage", () => {
    const request = input();
    const reader = {
      kind: "channels-list",
      mode: "list",
      limit: 100,
      sourceLimit: undefined,
      audience: "private-dashboard",
      hasComparison: false,
      hasCurrent: false,
      hasReference: false,
    } as const;
    const plan = planPageChannelMembershipDependencies({ ...request, reader })!;
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "prepare-membership",
      "read-report",
    ]);
    expect(plan.children[0]).toMatchObject({
      readerProfile: "channels-list-v1",
      outputId: "overview-channels",
      maxPlans: 1,
      maxSources: 1,
    });
    expect(plan.consumer).toEqual(JSON.parse(JSON.stringify(reader)));
  });
  it.each([
    { audience: "api-v1" },
    { audience: "public-share" },
    { limit: -1 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { dimension: "event.name" },
    { dimension: "session.entryPath" },
    { cursorText: 1 },
    { search: 1 },
    { sortBy: "other" },
    { sortDirection: "other" },
    { excludeEmpty: true },
  ])("refuses unsupported reader %j", (invalid) => {
    const request = input();
    expect(
      planPageChannelMembershipDependencies({
        ...request,
        reader: {
          ...request.reader,
          ...invalid,
        } as PageChannelMembershipReader,
      }),
    ).toBeUndefined();
  });
  it.each([
    { mode: "overview-tab" },
    { hasComparison: true },
    { hasCurrent: true },
    { hasReference: true },
    { limit: 0 },
    { sourceLimit: 99 },
    { limit: 2, sourceLimit: undefined },
  ])("keeps channel list closed %j", (invalid) => {
    const request = input();
    expect(
      planPageChannelMembershipDependencies({
        ...request,
        reader: {
          kind: "channels-list",
          mode: "list",
          limit: 100,
          sourceLimit: undefined,
          audience: "private-dashboard",
          hasComparison: false,
          hasCurrent: false,
          hasReference: false,
          ...invalid,
        } as PageChannelMembershipReader,
      }),
    ).toBeUndefined();
  });
  it("retains unsupported Seq on the complete old fallback, despite SQL-membership decision", () => {
    const request = input();
    const filters = parseFilterDsl(
      "sequence([window(page,@range.start,[0ms,99ms]),window(event,@range.start,[0ms,99ms])]) exists",
      analyticsFilterRegistry,
    );
    const execution = planAdvancedFilterExecution({
      subject: semanticSubjectFromQuerySubject(
        siteQueryContext("site", "private-dashboard").subject,
      ),
      filters,
      scope: "session",
      time: request.readerQueryTime,
      reportFusionAvailable: false,
    });
    expect(execution.sequenceSupport?.kind).toBe("supported");
    expect(execution.support.kind).toBe("unsupported");
    expect(
      planPageChannelMembershipDependencies({
        ...request,
        preparation: { ...request.preparation, execution, filters },
      }),
    ).toBeUndefined();
  });
});

it("rejects a structurally similar unknown reader profile", () => {
  const request = input();
  expect(
    planPageChannelMembershipDependencies({
      ...request,
      reader: {
        ...request.reader,
        kind: "unknown-reader",
      } as unknown as PageChannelMembershipReader,
    }),
  ).toBeUndefined();
});
it("fails closed if the canonical selection resolver no longer supports a declared alias", () => {
  const selection = vi
    .spyOn(dimensions, "dimensionPageSelection")
    .mockReturnValue(null);
  try {
    expect(pageMembershipDimensionContract("page.path")).toBeUndefined();
    expect(planPageChannelMembershipDependencies(input())).toBeUndefined();
  } finally {
    selection.mockRestore();
  }
});
it("keeps shared dependency-reference validation authoritative", () => {
  const references = vi
    .spyOn(dependencies, "validMembershipChildReferences")
    .mockReturnValue(false);
  try {
    expect(planPageChannelMembershipDependencies(input())).toBeUndefined();
    expect(references).toHaveBeenCalledOnce();
  } finally {
    references.mockRestore();
  }
});
