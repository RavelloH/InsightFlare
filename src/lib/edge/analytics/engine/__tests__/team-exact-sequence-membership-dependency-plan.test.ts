import { expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { normalizeMembershipPreparations } from "@/lib/edge/analytics/engine/membership-dependency-plan";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { planTeamExactMembershipDependencies } from "@/lib/edge/analytics/engine/team-exact-membership-dependency-plan";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const dsl =
  'sequence([window(page { page.path eq "/q" },@range.start,[0ms,99ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,99ms])]) exists';
function make(scope: "session" | "visitor", filter = dsl) {
  return prepareScopedQuery("dimension", {
    context: teamQueryContext("team", "private-dashboard", ["b", "a"]),
    time: createQueryTime(100, 200, "UTC", 300),
    filters: parseFilterDsl(filter, analyticsFilterRegistry),
    scopePreference: scope,
    mode: "breakdown",
    dimension: "page.path",
  });
}
function frozen(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
}
it.each(["session", "visitor"] as const)(
  "declares only the existing whole-domain %s Seq proof, without widening Count",
  (scope) => {
    const q = make(scope),
      execution = planAdvancedFilterExecution({
        subject: semanticSubjectFromQuerySubject(q.context.subject),
        filters: q.filters!,
        scope: q.scopePlan!.scope,
        time: q.time,
        reportFusionAvailable: false,
      });
    expect(execution.support.kind).toBe("unsupported");
    expect(execution.sequenceSupport?.kind).toBe("supported");
    expect(
      normalizeMembershipPreparations([
        { key: "joint", execution, filters: q.filters!, queryTime: q.time },
      ]),
    ).toBeUndefined();
    const recipe = planTeamExactMembershipDependencies(q)!;
    expect(recipe.admission).toMatchObject({
      executionKind: "sequence-membership",
      key: "joint",
      strategy: "sql-membership",
      fallback: "bounded-core",
      bounds: execution.decision.coreBounds,
      siteIds: ["b", "a"],
    });
    expect(
      recipe.children.map((c) => ({
        siteId: c.siteId,
        maxPlans: c.maxPlans,
        maxSources: c.maxSources,
        sourceRole: c.sourceRole,
        localOutputId: c.localOutputId,
      })),
    ).toEqual(
      ["b", "a"].map((siteId) => ({
        siteId,
        maxPlans: 1,
        maxSources: 1,
        sourceRole: "page",
        localOutputId: "dimension-top",
      })),
    );
    frozen(recipe);
    expect(recipe.admission.filters).not.toBe(q.filters);
    const count = planTeamExactMembershipDependencies(
      make(scope, "count(page) gte 0"),
    )!;
    expect(count.admission).not.toHaveProperty("executionKind");
  },
);
it("does not grant reader, audience or authorized-domain authority from the Seq tag", () => {
  const q = make("session");
  for (const changed of [
    { ...q, context: teamQueryContext("team", "api-v1", ["b", "a"]) },
    { ...q, context: teamQueryContext("team", "public-share", ["b", "a"]) },
    { ...q, context: teamQueryContext("team", "private-dashboard", ["b"]) },
    { ...q, dimension: "event.name" },
    { ...q, mode: "page" },
  ])
    expect(planTeamExactMembershipDependencies(changed)).toBeUndefined();
  expect(
    planTeamExactMembershipDependencies(
      make("session", dsl + " and time gte @range.start+1ms"),
    ),
  ).toBeUndefined();
});
