import { describe, expect, it, vi } from "vitest";

import { prepareSiteExactDimensionRequest } from "@/lib/edge/analytics/application/site-exact-dimension";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
} from "@/lib/edge/analytics/contract";
import { readSiteExactDimension } from "@/lib/edge/analytics/providers/d1/operations/site-exact-dimension";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

function request() {
  return prepareSiteExactDimensionRequest({
    siteId: "exact-site",
    audience: "private-dashboard",
    dimension: "page.path",
    time: createQueryTime(100, 200, "UTC", 300),
    filters: EMPTY_FILTER_DOCUMENT,
  });
}

describe("private exact dimension execution boundary", () => {
  it("requires completed qualification for an advanced expression", () => {
    expect(() =>
      prepareSiteExactDimensionRequest({
        siteId: "exact-site",
        audience: "private-dashboard",
        dimension: "page.path",
        time: createQueryTime(100, 200, "UTC", 300),
        filters: parseFilterDsl("count(page) gte 0", analyticsFilterRegistry),
      }),
    ).toThrow("site_exact_dimension_qualified_membership_required");
  });
  it.each(["clone", "site", "time", "plan"] as const)(
    "rejects a %s forgery before reading storage",
    async (kind) => {
      const original = request();
      const candidate = kind === "clone" ? { ...original } : original;
      if (kind === "site")
        Object.assign(original.context.subject, { siteId: "another-site" });
      if (kind === "time") Object.assign(original.time.range, { startMs: 101 });
      if (kind === "plan")
        Object.assign(original.scopePlan!, { expansion: "matching-visitors" });
      const prepare = vi.fn();
      await expect(
        readSiteExactDimension(
          { DB: { prepare } } as unknown as Env,
          candidate,
        ),
      ).rejects.toThrow("site_exact_dimension_request_context_mismatch");
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["public-share", "api-v1"] as const)(
    "keeps %s outside the private port",
    (audience) => {
      expect(() =>
        prepareSiteExactDimensionRequest({
          siteId: "exact-site",
          audience,
          dimension: "page.path",
          time: createQueryTime(100, 200, "UTC", 300),
          filters: EMPTY_FILTER_DOCUMENT,
        }),
      ).toThrow("site_exact_dimension_private_audience_required");
    },
  );
});
