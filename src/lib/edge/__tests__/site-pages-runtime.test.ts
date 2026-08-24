import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/pages", () => ({
  queryPagesAggregate: vi.fn(),
  queryReferrerAggregate: vi.fn(),
}));

import {
  queryPagesAggregate,
  queryReferrerAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import {
  readSitePages,
  readSiteReferrers,
} from "@/lib/edge/analytics/providers/d1/operations/site-pages";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  filters: { version: 1 as const, root: null },
  limit: 20,
};

describe("site pages and referrers runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("executes page and referrer composites through policy-first typed readers", async () => {
    vi.mocked(queryPagesAggregate).mockResolvedValue([
      { pathname: "/pricing", query: "", hash: "", views: 10, sessions: 4 },
    ]);
    vi.mocked(queryReferrerAggregate).mockResolvedValue([
      { referrer: "search.example", views: 10, sessions: 4, visitors: 3 },
    ]);
    await expect(
      readSitePages({ ...input, includeDetails: true }),
    ).resolves.toEqual({
      items: [
        { pathname: "/pricing", query: "", hash: "", views: 10, sessions: 4 },
      ],
    });
    await expect(
      readSiteReferrers({ ...input, includeFullUrl: true }),
    ).resolves.toEqual({
      items: [
        { referrer: "search.example", views: 10, sessions: 4, visitors: 3 },
      ],
    });
    expect(queryPagesAggregate).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      true,
    );
    expect(queryReferrerAggregate).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      true,
    );
  });

  it("rejects invalid filters before either D1 provider", async () => {
    const invalid = {
      version: 1 as const,
      root: {
        kind: "condition" as const,
        target: { kind: "field" as const, field: "forbidden.field" as never },
        operator: "eq" as const,
        value: "x",
      },
    };
    await expect(
      readSitePages({ ...input, includeDetails: false, filters: invalid }),
    ).rejects.toThrow("invalid-input");
    await expect(
      readSiteReferrers({ ...input, includeFullUrl: false, filters: invalid }),
    ).rejects.toThrow("invalid-input");
    expect(queryPagesAggregate).not.toHaveBeenCalled();
    expect(queryReferrerAggregate).not.toHaveBeenCalled();
  });
});
