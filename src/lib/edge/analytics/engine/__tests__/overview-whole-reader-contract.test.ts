// @vitest-environment node
import { expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { describeOverviewComparisonReader } from "@/lib/edge/analytics/engine/overview-comparison-reader-contract";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY as ENTITY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY as EVENT,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY as PAGE,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { projectWholeOriginalMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
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
function prepared(
  scope: "event" | "session" | "visitor",
  root: "advanced" | "native" | "empty",
) {
  const p = prepareScopedQuery("overview", {
    context: siteQueryContext("site", "private-dashboard"),
    time: current,
    filters: parseFilterDsl("count(event) gt 0", analyticsFilterRegistry),
    scopePreference: scope,
  });
  if (root !== "advanced")
    Object.assign(p.filters!, {
      root:
        root === "empty"
          ? null
          : parseFilterDsl('page.path eq "/a"', analyticsFilterRegistry).root,
    });
  return p;
}
function physicalPreparation(
  p: ReturnType<typeof prepared>,
  key: unknown,
  bindings: number,
) {
  const observation = p.scopePlan!.mode === "observation";
  const projection = projectWholeOriginalMembership({
    siteIds: ["site"],
    mode: p.scopePlan!.mode,
    matches: [],
  });
  return createPageVisitQualificationPreparation({
    siteId: "site",
    filters: p.filters!,
    queryTime: current,
    scopePlan: p.scopePlan!,
    consumerKey: key,
    dependencyRef: observation ? PAGE : ENTITY,
    relation: observation
      ? projection.relations.visit!
      : projection.relations.entity!,
    ...(observation
      ? {
          additionalRelations: [
            { dependencyRef: EVENT, relation: projection.relations.event! },
          ],
        }
      : {}),
    maxBindings: bindings,
    maxSourcesPerRole: 2,
    qualificationSemantics: "whole-original",
  });
}
for (const scope of ["event", "session", "visitor"] as const) {
  it.each(["advanced", "native", "empty"] as const)(
    `preserves original preparation and every actual Overview reader window for ${scope}/%s`,
    (root) => {
      const p = prepared(scope, root);
      const mode = scope === "event" ? "observation" : "entity";
      for (const configuration of configurations) {
        const description = describeOverviewComparisonReader({
          consumer: { kind: "overview", configuration },
          queryTime: current,
          mode,
        })!;
        const preparation = physicalPreparation(
          p,
          configuration,
          description.outputs.length,
        );
        for (const output of description.outputs) {
          const input = {
            siteId: "site",
            filters: p.filters!,
            scopePlan: p.scopePlan,
            queryTime: output.queryTime,
            qualificationDependencyRefs: [mode === "entity" ? ENTITY : EVENT],
            pageVisitDependencyRefs: [mode === "entity" ? ENTITY : PAGE],
            qualificationSemantics: "whole-original" as const,
          };
          const plan = snapshotPageVisitQualificationPlan(
            output.outputId === "overview-aggregate"
              ? buildOverviewAggregatePlan(input)
              : buildOverviewTrendPlan({ ...input, interval: "day" }),
          );
          expect(plan.outputs.map((o) => o.id)).toEqual([output.outputId]);
          const sources = plan.nodes.filter((n) => n.kind === "source");
          expect(
            sources.map((n) => ({
              entity: n.entity,
              dependencyRef: n.selection?.qualificationDependencyRefs?.[0],
            })),
          ).toEqual(output.sources);
          for (const source of sources) {
            expect(source.selection?.profile).toBe(
              "prepared-whole-filter-reader-window-v1",
            );
            expect(source.selection?.preparationTime).toEqual(
              semanticTemporalDomainsFromQueryTime(
                scopedFilterMetadata(p.filters!)!.time!,
              ),
            );
            expect(source.selection?.time).toEqual(
              semanticTemporalDomainsFromQueryTime(output.queryTime),
            );
            expect(source.selection?.preparedMembership).toBeUndefined();
          }
          expect(
            () =>
              new AnalyticsLogicalToDbLowerer(plan, {
                siteIds: ["site"],
                time: plan.context.time,
              }),
          ).toThrow("qualification_execution_dependency_unbound");
          const executionInputs = bindPageVisitQualificationPreparation({
            preparation,
            siteId: "site",
            filters: p.filters!,
            queryTime: current,
            scopePlan: p.scopePlan!,
            consumerKey: configuration,
            plan,
            readerQueryTime: output.queryTime,
          });
          expect(
            () =>
              new AnalyticsLogicalToDbLowerer(
                plan,
                { siteIds: ["site"], time: plan.context.time },
                { qualificationExecutionInputs: executionInputs },
              ),
          ).not.toThrow();
        }
      }
    },
  );
}
it("does not permit missing typed roles, forged prepared contexts or an ordinary source to gain whole semantics", () => {
  const p = prepared("event", "empty");
  const input = {
    siteId: "site",
    filters: p.filters!,
    scopePlan: p.scopePlan,
    queryTime: current,
    qualificationSemantics: "whole-original" as const,
  };
  for (const build of [
    (value: typeof input) => buildOverviewAggregatePlan(value),
    (value: typeof input) =>
      buildOverviewTrendPlan({ ...value, interval: "day" }),
  ]) {
    expect(() => build(input)).toThrow();
    for (const change of [
      {
        qualificationDependencyRefs: [ENTITY],
        pageVisitDependencyRefs: [ENTITY],
      },
      {
        qualificationDependencyRefs: [EVENT],
        pageVisitDependencyRefs: [PAGE],
        siteId: "outside",
      },
      {
        qualificationDependencyRefs: [EVENT],
        pageVisitDependencyRefs: [PAGE],
        scopePlan: { ...p.scopePlan! },
      },
      {
        qualificationDependencyRefs: [EVENT],
        pageVisitDependencyRefs: [PAGE],
        filters: JSON.parse(JSON.stringify(p.filters)),
      },
    ])
      expect(
        () => build({ ...input, ...change } as typeof input),
        JSON.stringify(change),
      ).toThrow();
    const wrongRole = snapshotPageVisitQualificationPlan(
      build({
        ...input,
        qualificationDependencyRefs: [EVENT],
        pageVisitDependencyRefs: [EVENT],
      } as typeof input),
    );
    const key = { wrongRole: true };
    const preparation = physicalPreparation(p, key, 1);
    expect(() =>
      bindPageVisitQualificationPreparation({
        preparation,
        siteId: "site",
        filters: p.filters!,
        queryTime: current,
        scopePlan: p.scopePlan!,
        consumerKey: key,
        plan: wrongRole,
        readerQueryTime: current,
      }),
    ).toThrow("qualification_execution_plan_context_mismatch");
    expect(() =>
      build({
        ...input,
        filters: { version: 1, root: null },
        scopePlan: undefined,
      }),
    ).toThrow("overview_source_whole_original_requires_prepared_scope");
  }
});
it.each(["session", "visitor"] as const)(
  "keeps old advanced/native/empty profiles unless %s explicitly opts in",
  (scope) => {
    for (const root of ["advanced", "native", "empty"] as const) {
      const p = prepared(scope, root);
      const input = {
        siteId: "site",
        filters: p.filters!,
        scopePlan: p.scopePlan,
        queryTime: current,
      };
      const old = buildOverviewAggregatePlan({
        ...input,
        ...(root === "advanced"
          ? { qualificationDependencyRefs: [ENTITY] }
          : {}),
      });
      expect(
        old.nodes
          .filter((n) => n.kind === "source")
          .map((n) => n.selection?.profile),
      ).toEqual([
        "prepared-scoped-reader-window-v1",
        "prepared-scoped-reader-window-v1",
      ]);
      if (root !== "advanced")
        expect(() =>
          buildOverviewAggregatePlan({
            ...input,
            qualificationDependencyRefs: [ENTITY],
          }),
        ).toThrow();
    }
  },
);
