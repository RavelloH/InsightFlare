import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { prepareScopedQuery } from "@/lib/edge/analytics/contract/scoped-filter";
import { planTeamExactMembershipDependencies } from "@/lib/edge/analytics/engine/team-exact-membership-dependency-plan";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const makeQuery = (
  siteIds: readonly string[] = ["a", "b"],
  scopePreference: "session" | "visitor" | "event" = "session",
  dsl = "count(page) gte 0",
) =>
  prepareScopedQuery("dimension", {
    context: teamQueryContext("team", "private-dashboard", siteIds),
    time: createQueryTime(100, 200, "UTC", 300),
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    scopePreference,
    mode: "breakdown",
    dimension: "page.path",
  });
function expectFrozen(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}
describe("team exact joint membership dependency recipe", () => {
  it.each(["session", "visitor"] as const)(
    "declares one whole-domain %s admission before site-owned complete reads",
    (scope) => {
      const query = makeQuery(["b", "a"], scope);
      const recipe = planTeamExactMembershipDependencies(query)!;
      expect(recipe.admission.siteIds).toEqual(["b", "a"]);
      expect(recipe.admission.filters).toEqual(query.filters);
      expect(recipe.admission.queryTime).toEqual(query.time);
      expect(recipe.admission.membership.identity).toMatchObject({
        site: "siteId",
        grain: scope,
      });
      expect(
        recipe.children.map(
          ({ siteId, key, maxPlans, maxSources, localOutputId }) => ({
            siteId,
            key,
            maxPlans,
            maxSources,
            localOutputId,
          }),
        ),
      ).toEqual(
        ["b", "a"].map((siteId) => ({
          siteId,
          key: `site:${siteId}`,
          maxPlans: 1,
          maxSources: 1,
          localOutputId: "dimension-top",
        })),
      );
      expect(recipe.consumer).toMatchObject({
        dimension: "page.path",
        perSiteLimit: 0,
        excludeEmpty: true,
      });
      expectFrozen(recipe);
      expect(recipe.admission.filters).not.toBe(query.filters);
      expect(recipe.children[0]!.queryTime).not.toBe(query.time);
    },
  );
  it("does not skip the joint admission for zero authorized report children", () => {
    const recipe = planTeamExactMembershipDependencies(makeQuery([]))!;
    expect(recipe.admission).toMatchObject({
      key: "joint",
      siteIds: [],
      strategy: "sql-membership",
      fallback: "bounded-core",
    });
    expect(recipe.children).toEqual([]);
  });
  it.each([
    ["event", "count(page) gte 0"],
    ["session", "page.path exists"],
    ["session", "count(page) gte 0 and time gte @range.start+1ms"],
    ["session", 'count(event { event.payload("/amount") gte 1 }) gte 1'],
  ] as const)("retains the prior route for %s / %s", (scope, dsl) =>
    expect(
      planTeamExactMembershipDependencies(makeQuery(["a"], scope, dsl)),
    ).toBeUndefined(),
  );
  it.each(["public-share", "api-v1"] as const)(
    "does not derive %s authority from a reader profile",
    (audience) => {
      const query = makeQuery();
      expect(
        planTeamExactMembershipDependencies({
          ...query,
          context: teamQueryContext("team", audience, ["a", "b"]),
        }),
      ).toBeUndefined();
    },
  );
  it("rejects changed authorization, unknown dimension and non-breakdown modes", () => {
    const query = makeQuery();
    expect(
      planTeamExactMembershipDependencies({
        ...query,
        context: teamQueryContext("team", "private-dashboard", ["a"]),
      }),
    ).toBeUndefined();
    expect(
      planTeamExactMembershipDependencies({
        ...query,
        dimension: "event.name",
      }),
    ).toBeUndefined();
    expect(
      planTeamExactMembershipDependencies({ ...query, mode: "page" }),
    ).toBeUndefined();
  });
});
