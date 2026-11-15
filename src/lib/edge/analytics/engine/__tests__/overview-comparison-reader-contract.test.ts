import { expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  COMPARISON_PAGE_READER_TABS,
  comparisonPageReaderContract,
} from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { describeOverviewComparisonReader } from "@/lib/edge/analytics/engine/overview-comparison-reader-contract";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY as ENTITY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY as EVENT,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY as PAGE,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { buildComparisonDimensionRollupPlan } from "@/lib/edge/analytics/providers/d1/internal/comparison-dimension-source";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const current = createQueryTime(86400000, 172800000, "UTC", 172800001);
const previous = createQueryTime(0, 86400000, "Asia/Shanghai", 172800001);
const configurations: readonly OverviewTrendQualificationConfiguration[] = [
  { kind: "aggregate" },
  { kind: "trend", interval: "hour" },
  { kind: "overview-with-detail", interval: "day" },
  { kind: "overview-with-previous", previousTime: previous },
  {
    kind: "overview-with-previous-and-detail",
    previousTime: previous,
    interval: "week",
  },
];
function prepared(scope: "event" | "session" | "visitor") {
  return prepareScopedQuery("overview", {
    context: siteQueryContext("site", "private-dashboard"),
    time: current,
    filters: parseFilterDsl("count(event) gt 0", analyticsFilterRegistry),
    scopePreference: scope,
  });
}
function uses(plan: ValidatedLogicalPlan) {
  return plan.nodes
    .filter((n) => n.kind === "source")
    .map((n) => ({
      entity: n.entity,
      dependencyRef: n.selection?.qualificationDependencyRefs?.[0],
    }));
}
it.each(["event", "session", "visitor"] as const)(
  "matches all five actual Overview configurations for %s without changing reader order",
  (scope) => {
    const p = prepared(scope);
    const mode = scope === "event" ? "observation" : "entity";
    for (const configuration of configurations) {
      const description = describeOverviewComparisonReader({
        consumer: { kind: "overview", configuration },
        queryTime: p.time,
        mode,
      })!;
      const expectedKeys =
        configuration.kind === "trend"
          ? ["current-trend"]
          : [
              "current-overview",
              ...("previousTime" in configuration ? ["previous-overview"] : []),
              ...("interval" in configuration ? ["current-detail"] : []),
            ];
      expect(description.preparationKeys).toEqual(["original"]);
      expect(description.outputs.map((x) => x.readerKey)).toEqual(expectedKeys);
      for (const output of description.outputs) {
        const input = {
          siteId: "site",
          filters: p.filters,
          scopePlan: p.scopePlan,
          queryTime: output.queryTime,
          qualificationDependencyRefs: [mode === "entity" ? ENTITY : EVENT],
          pageVisitDependencyRefs: [mode === "entity" ? ENTITY : PAGE],
        };
        const plan =
          output.outputId === "overview-aggregate"
            ? buildOverviewAggregatePlan(input)
            : buildOverviewTrendPlan({ ...input, interval: "day" });
        expect(plan.outputs.map((x) => x.id)).toEqual([output.outputId]);
        expect(uses(plan)).toEqual(output.sources);
        expect(output.queryTime).toBe(
          output.readerKey === "previous-overview" ? previous : p.time,
        );
      }
    }
  },
);
it.each(["session", "visitor"] as const)(
  "keeps the existing entity-only builder selection byte-equivalent for %s",
  (scope) => {
    const p = prepared(scope);
    const input = {
      siteId: "site",
      filters: p.filters,
      scopePlan: p.scopePlan,
      queryTime: p.time,
      qualificationDependencyRefs: [ENTITY],
    };
    expect(buildOverviewAggregatePlan(input)).toEqual(
      buildOverviewAggregatePlan({
        ...input,
        pageVisitDependencyRefs: [ENTITY],
      }),
    );
    expect(buildOverviewTrendPlan({ ...input, interval: "day" })).toEqual(
      buildOverviewTrendPlan({
        ...input,
        interval: "day",
        pageVisitDependencyRefs: [ENTITY],
      }),
    );
  },
);
it.each(["session", "visitor"] as const)(
  "maps all actual Comparison Page child outputs independently for %s",
  (scope) => {
    const p = prepared(scope);
    for (const tab of COMPARISON_PAGE_READER_TABS) {
      const description = describeOverviewComparisonReader({
        consumer: {
          kind: "comparison-page",
          tab,
          referenceQueryTime: previous,
        },
        queryTime: p.time,
        mode: "entity",
      })!;
      expect(description.preparationKeys).toEqual(["current", "reference"]);
      for (const output of description.outputs) {
        const time = output.queryTime;
        const plan = buildComparisonDimensionRollupPlan({
          siteId: "site",
          window: {
            startMs: time.range.startMs,
            endExclusiveMs: time.range.endExclusiveMs,
            timeZone: time.reportingTimeZone,
            nowMs: time.capturedAtMs,
          },
          filters: p.filters,
          selection: comparisonPageReaderContract(tab)!.selection,
          entityDependency: true,
          outputId: output.outputId,
        });
        expect(plan.outputs.map((x) => x.id)).toEqual([output.outputId]);
        expect(uses(plan)).toEqual(output.sources);
        expect(output.preparationKey).toBe(output.readerKey.split(":")[1]);
      }
    }
  },
);
it("declines unknown readers and the unwired observation Comparison builder", () => {
  expect(
    describeOverviewComparisonReader({
      consumer: {
        kind: "comparison-page",
        tab: "source.domain",
        referenceQueryTime: previous,
      },
      queryTime: current,
      mode: "observation",
    }),
  ).toBeUndefined();
  expect(
    describeOverviewComparisonReader({
      consumer: { kind: "arbitrary" } as never,
      queryTime: current,
      mode: "entity",
    }),
  ).toBeUndefined();
});
