import { describe, expect, it } from "vitest";

import type { QueryTime } from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import type { ComparisonMembershipSideInput } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import { planComparisonMembershipDependencies } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import {
  type MembershipChildDescriptor,
  planMembershipDependencies,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import type { ReferrersTimeMembershipDependencyPlan } from "@/lib/edge/analytics/engine/referrers-time-membership-plan";
import { planReferrersTimeMembershipDependency } from "@/lib/edge/analytics/engine/referrers-time-membership-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

// Frozen pre-refactor planner implementations: test-only independent value oracles.
// Keep these separate from the new shared validation and snapshot implementation.
const BASELINE_COMPARISON_OUTPUTS = {
  current: "comparison-current-membership-rollup",
  reference: "comparison-reference-membership-rollup",
} as const;
function baselineFreeze<T>(v: T): T {
  if (v && typeof v === "object")
    for (const x of Object.values(v as object)) baselineFreeze(x);
  return v && typeof v === "object" ? Object.freeze(v) : v;
}
function baselineReferrers(input: {
  execution: AdvancedFilterExecutionPlan;
  topN: number;
  filters: FilterDocument;
  queryTime: QueryTime;
}): ReferrersTimeMembershipDependencyPlan | undefined {
  const e = input.execution;
  if (
    e.decision.strategy !== "sql-membership" ||
    e.support.kind !== "supported" ||
    e.decision.membership.identity.grain === "activity"
  )
    return undefined;
  return baselineFreeze(
    JSON.parse(
      JSON.stringify({
        kind: "referrers-time-membership-dependency",
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        membership: e.decision.membership,
        steps: [
          {
            kind: "prepare-membership",
            strategy: "sql-membership",
            filterSemantics: "whole-original-tree",
            fallback: "bounded-core",
            filters: input.filters,
            queryTime: input.queryTime,
            bounds: e.decision.coreBounds,
          },
          {
            kind: "read-report",
            strategy: "consume-dependency",
            sourceRole: "page",
            queryTime: input.queryTime,
            maxPlans: 1,
            maxSources: 1,
          },
        ],
        consumer: {
          operation: "referrers",
          variant: "summary",
          topN: input.topN,
          audience: "private-dashboard",
        },
      }),
    ),
  );
}

function baselineComparison(input: {
  readonly current: ComparisonMembershipSideInput;
  readonly reference: ComparisonMembershipSideInput;
  readonly consumer: unknown;
}) {
  if (
    [input.current, input.reference].some(
      (s) =>
        s.execution.decision.strategy !== "sql-membership" ||
        s.execution.support.kind !== "supported" ||
        s.execution.decision.membership.identity.grain === "activity",
    )
  )
    return undefined;
  const sides = (["current", "reference"] as const).map((side) => ({
    kind: "prepare-membership" as const,
    side,
    childOutputId: BASELINE_COMPARISON_OUTPUTS[side],
    strategy: "sql-membership" as const,
    filterSemantics: "whole-original-tree" as const,
    fallback: "bounded-core" as const,
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    membership: input[side].execution.decision.membership,
    filters: input[side].filters,
    queryTime: input[side].queryTime,
    readerQueryTime: input[side].readerQueryTime,
    bounds: input[side].execution.decision.coreBounds,
  }));
  const freeze = <T>(v: T): T => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) freeze(x);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(
    JSON.parse(
      JSON.stringify({
        kind: "comparison-membership-dependencies",
        steps: [
          ...sides,
          {
            kind: "read-report",
            strategy: "consume-independent-analysis-dependencies",
            sourceRole: "page",
            maxPlansPerSide: 1,
            maxSourcesPerSide: 1,
          },
        ],
        consumer: input.consumer,
      }),
    ) as {
      readonly kind: "comparison-membership-dependencies";
      readonly steps: readonly [
        (typeof sides)[number],
        (typeof sides)[number],
        {
          readonly kind: "read-report";
          readonly strategy: "consume-independent-analysis-dependencies";
          readonly sourceRole: "page";
          readonly maxPlansPerSide: 1;
          readonly maxSourcesPerSide: 1;
        },
      ];
      readonly consumer: unknown;
    },
  );
}

function preparation(
  scope: "session" | "visitor" = "session",
  offset = 0,
  history = false,
) {
  const filters = parseFilterDsl(
    "count(page) gt 0 and time gte @range.start+1ms",
    analyticsFilterRegistry,
  );
  const queryTime: QueryTime = {
    ...createQueryTime(offset, offset + 100, "Asia/Shanghai", offset + 500),
    filterRange: { startMs: offset + 1, endExclusiveMs: offset + 201 },
    filterRangeEmpty: true,
    fullHistory: history,
    readRange: createQueryTime(
      offset - 100,
      offset + 201,
      "Asia/Shanghai",
      offset + 500,
    ).range,
    paginationBinding: "original-preset",
  };
  const execution = planAdvancedFilterExecution({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-1" as never],
    }),
    filters,
    scope,
    time: queryTime,
    reportFusionAvailable: false,
  });
  return { key: "membership", filters, queryTime, execution };
}
function child(
  overrides: Partial<MembershipChildDescriptor> = {},
): MembershipChildDescriptor {
  return {
    key: "report",
    preparationKey: "membership",
    readerProfile: "referrers-summary-page-v1",
    queryTime: createQueryTime(0, 100, "UTC", 500),
    sourceRole: "page",
    maxPlans: 1,
    maxSources: 1,
    ...overrides,
  };
}
function frozen(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(frozen);
  }
}
describe("bounded ordered membership recipe", () => {
  it("copies all C/F/R, bounds, filters and consumer, preserving preparation/child order", () => {
    const first = preparation(),
      second = { ...preparation("visitor", 1000, true), key: "reference" };
    const children = [
      child({ key: "ref", preparationKey: "reference", outputId: "reference" }),
      child({ outputId: "current" }),
    ];
    const consumer = { nested: { value: 1 } };
    const recipe = planMembershipDependencies({
      preparations: [first, second],
      children,
      consumer,
    })!;
    expect(recipe.preparations.map((p) => p.key)).toEqual([
      "membership",
      "reference",
    ]);
    expect(recipe.children.map((c) => c.key)).toEqual(["ref", "report"]);
    for (const [index, original] of [first, second].entries()) {
      expect(recipe.preparations[index]).toMatchObject({
        filters: original.filters,
        queryTime: original.queryTime,
        membership: original.execution.decision.membership,
        bounds: original.execution.decision.coreBounds,
      });
      expect(recipe.preparations[index]!.queryTime).not.toBe(
        original.queryTime,
      );
      expect(recipe.preparations[index]!.membership.time.read.kind).toBe(
        index ? "retained-history" : "bounded",
      );
    }
    frozen(recipe);
    consumer.nested.value = 9;
    expect(recipe.consumer.nested.value).toBe(1);
    expect(Object.isFrozen(first.filters)).toBe(false);
  });
  it.each([
    "empty",
    "over-two",
    "duplicate-prep",
    "duplicate-child",
    "unknown-prep",
    "unused-prep",
    "reused-prep",
    "duplicate-output",
    "empty-output",
    "unknown-profile",
    "event-source",
    "two-plans",
    "two-sources",
  ])("rejects %s descriptors", (kind) => {
    const first = preparation();
    let preparations = [first];
    let children = [child()];
    if (kind === "empty") {
      preparations = [];
      children = [];
    }
    if (kind === "over-two") {
      preparations = [
        first,
        { ...first, key: "second" },
        { ...first, key: "third" },
      ];
      children = [
        child(),
        child({ key: "second", preparationKey: "second" }),
        child({ key: "third", preparationKey: "third" }),
      ];
    }
    if (kind === "duplicate-prep") {
      preparations = [first, first];
      children = [child(), child({ key: "second" })];
    }
    if (["duplicate-child", "reused-prep", "duplicate-output"].includes(kind)) {
      preparations = [first, { ...first, key: "second" }];
      children = [
        child({ outputId: "output" }),
        child({
          key: kind === "duplicate-child" ? "report" : "second",
          preparationKey: kind === "reused-prep" ? "membership" : "second",
          outputId: kind === "duplicate-output" ? "output" : "other",
        }),
      ];
    }
    if (kind === "unknown-prep")
      children = [child({ preparationKey: "undeclared" })];
    if (kind === "unused-prep") preparations.push({ ...first, key: "unused" });
    if (kind === "empty-output") children = [child({ outputId: "" })];
    if (kind === "unknown-profile")
      children = [child({ readerProfile: "unregistered" as never })];
    if (kind === "event-source")
      children = [child({ sourceRole: "event" as never })];
    if (kind === "two-plans") children = [child({ maxPlans: 2 as never })];
    if (kind === "two-sources") children = [child({ maxSources: 2 as never })];
    expect(
      planMembershipDependencies({ preparations, children, consumer: {} }),
    ).toBeUndefined();
  });
  it.each(["sql-report-fusion", "bounded-core"] as const)(
    "rejects %s across the shared path",
    (strategy) => {
      const p = preparation();
      p.execution = {
        ...p.execution,
        decision: { ...p.execution.decision, strategy },
      };
      expect(
        planMembershipDependencies({
          preparations: [p],
          children: [child()],
          consumer: {},
        }),
      ).toBeUndefined();
    },
  );
  it.each(["unsupported", "activity"] as const)(
    "rejects %s without another reader granting eligibility",
    (kind) => {
      const p = preparation();
      if (kind === "unsupported")
        p.execution = {
          ...p.execution,
          support: {
            kind: "unsupported",
            code: "unsupported",
            path: "root",
            reason: "unsupported",
          },
        };
      else
        p.execution = {
          ...p.execution,
          decision: {
            ...p.execution.decision,
            membership: {
              ...p.execution.decision.membership,
              identity: {
                ...p.execution.decision.membership.identity,
                grain: "activity",
              },
            },
          },
        };
      expect(
        planMembershipDependencies({
          preparations: [p],
          children: [child()],
          consumer: {},
        }),
      ).toBeUndefined();
    },
  );
});
it("preserves the old optional consumer JSON value contract", () => {
  const p = preparation();
  const side = { ...p, readerQueryTime: p.queryTime };
  for (const consumer of [
    undefined,
    null,
    { optional: undefined, nan: NaN, nested: [undefined] },
  ]) {
    const input = { current: side, reference: side, consumer };
    expect(planComparisonMembershipDependencies(input)).toStrictEqual(
      baselineComparison(input),
    );
  }
});
describe("wrapper exact value and deep freeze parity against pre-change implementations", () => {
  it.each(["session", "visitor"] as const)(
    "preserves %s Referrers and both comparison sides with independent windows",
    (scope) => {
      for (const history of [false, true]) {
        const current = preparation(scope, 0, history),
          reference = preparation(scope, 1000, !history);
        const referrers = { ...current, topN: 23 };
        const actualReferrers =
          planReferrersTimeMembershipDependency(referrers)!;
        expect(actualReferrers).toStrictEqual(baselineReferrers(referrers));
        frozen(actualReferrers);
        const request = {
          current: {
            ...current,
            readerQueryTime: createQueryTime(-10, 90, "UTC", 600),
          },
          reference: {
            ...reference,
            readerQueryTime: createQueryTime(900, 990, "UTC", 1500),
          },
          consumer: {
            operation: "comparison",
            selection: { kind: "referrer", nested: ["original"] },
          },
        };
        const actual = planComparisonMembershipDependencies(request)!;
        expect(actual).toStrictEqual(baselineComparison(request));
        expect(
          actual.steps
            .slice(0, 2)
            .map((s) => ("childOutputId" in s ? s.childOutputId : undefined)),
        ).toEqual([
          "comparison-current-membership-rollup",
          "comparison-reference-membership-rollup",
        ]);
        frozen(actual);
        request.consumer.selection.nested.push("changed");
        expect(actual.consumer).toEqual({
          operation: "comparison",
          selection: { kind: "referrer", nested: ["original"] },
        });
      }
    },
  );
});
