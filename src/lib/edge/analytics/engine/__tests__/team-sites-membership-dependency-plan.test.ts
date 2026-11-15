// @vitest-environment node
import { expect, it, vi } from "vitest";

import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import * as references from "@/lib/edge/analytics/engine/membership-dependency-plan";
import { planTeamSitesMembershipDependencies } from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
function query() {
  const sites = ["recipe-a", "recipe-b"];
  return prepareScopedQuery("team-sites", {
    context: teamQueryContext("recipe-team", "private-dashboard", sites),
    teamId: "recipe-team",
    time: createQueryTime(100, 200, "UTC", 300),
    filters: parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    ),
    scopePreference: "session" as const,
  });
}
it.each(["duplicate", "empty", "foreign"] as const)(
  "rejects %s metadata domain before constructing children",
  (kind) => {
    const q = query(),
      metadata = scopedFilterMetadata(q.filters)!;
    Object.assign(metadata, {
      siteIds:
        kind === "duplicate"
          ? ["recipe-a", "recipe-a"]
          : kind === "empty"
            ? ["recipe-a", ""]
            : ["recipe-a", "recipe-c"],
    });
    expect(planTeamSitesMembershipDependencies(q)).toBeUndefined();
  },
);
it("rejects an unknown interval rather than granting arbitrary reader fanout", () => {
  const q = query();
  Object.assign(q, { interval: "quarter" });
  expect(planTeamSitesMembershipDependencies(q)).toBeUndefined();
});
it("propagates the shared reference validator rejection rather than treating the recipe as authority", () => {
  const q = query();
  const validator = vi
    .spyOn(references, "validMembershipChildReferences")
    .mockReturnValue(false);
  try {
    expect(planTeamSitesMembershipDependencies(q)).toBeUndefined();
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator.mock.calls[0]?.[0]).toMatchObject([{ key: "joint" }]);
    expect(
      validator.mock.calls[0]?.[1].map((c) => ({
        key: c.key,
        preparationKey: c.preparationKey,
      })),
    ).toEqual([
      { key: "site:recipe-a:overview", preparationKey: "joint" },
      { key: "site:recipe-a:latest", preparationKey: "joint" },
      { key: "site:recipe-b:overview", preparationKey: "joint" },
      { key: "site:recipe-b:latest", preparationKey: "joint" },
    ]);
  } finally {
    validator.mockRestore();
  }
});
