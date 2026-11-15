// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { prepareSiteExactDimensionRequest } from "@/lib/edge/analytics/application/site-exact-dimension";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { prepareSiteExactDimensionInputs } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readSiteExactDimension } from "@/lib/edge/analytics/providers/d1/operations/site-exact-dimension";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

import { createFixture } from "./team-sites-membership-fixture";
it.each(["requestedScope", "resolvedScope"] as const)(
  "TeamExact scoped Source rejects post-admission %s before storage",
  async (kind) => {
    const db = createFixture(),
      sites = ["b04-site-a", "b04-site-b"];
    const query = prepareScopedQuery("dimension", {
      context: teamQueryContext("b04-team", "private-dashboard", sites),
      teamId: "b04-team",
      time: createQueryTime(100, 200, "UTC", 300),
      filters: parseFilterDsl(
        'count(event { event.name eq "qualifier" }) gte 1',
        analyticsFilterRegistry,
      ),
      scopePreference: "session" as const,
      mode: "breakdown" as const,
      dimension: "page.path",
    });
    const child = (
      await prepareSiteExactDimensionInputs({
        env: { DB: createSqliteD1Database(db) } as Env,
        query,
        siteIds: sites,
      })
    ).get(sites[0]!)!;
    const request = prepareSiteExactDimensionRequest({
      siteId: sites[0]!,
      audience: "private-dashboard",
      dimension: "page.path",
      time: query.time,
      filters: child.filters,
      scopePreference: query.scopePreference,
      qualifiedPlan: child.qualifiedPlan,
      qualification: child.qualification,
    });
    await Promise.resolve();
    Object.assign(scopedFilterMetadata(child.filters)!, { [kind]: "visitor" });
    const prepare = vi.fn(() => {
      throw new Error("storage_must_not_run");
    });
    // The application JSON snapshot omits hidden metadata, but the existing
    // actual scoped Source proof still rejects these changes before storage.
    await expect(
      readSiteExactDimension({ DB: { prepare } } as unknown as Env, request),
    ).rejects.toThrow(
      kind === "requestedScope"
        ? "prepared_plan_mismatch"
        : "prepared_scope_mismatch",
    );
    expect(prepare).not.toHaveBeenCalled();
  },
);
