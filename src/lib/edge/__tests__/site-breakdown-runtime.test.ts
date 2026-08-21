import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/query/dimensions", () => ({
  queryDimensionFromD1: vi.fn(),
  querySessionBoundaryDimensionFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-summary", () => ({
  queryEventTypeAggregate: vi.fn(),
}));

import {
  queryDimensionFromD1,
  querySessionBoundaryDimensionFromD1,
} from "@/lib/edge/query/dimensions";
import { queryEventTypeAggregate } from "@/lib/edge/query/events-summary";
import { readSiteBreakdown } from "@/lib/edge/query-runtime/site-breakdown";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  dimension: "page.path",
  limit: 20,
  filters: { version: 1 as const, root: null },
};

describe("site breakdown runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the typed visit dimension provider and shapes stable items", async () => {
    vi.mocked(queryDimensionFromD1).mockResolvedValue([
      { value: "/pricing", views: 4, sessions: 2, visitors: 2 },
    ]);
    await expect(readSiteBreakdown(input)).resolves.toEqual({
      items: [
        {
          key: "/pricing",
          label: "/pricing",
          views: 4,
          sessions: 2,
          visitors: 2,
        },
      ],
    });
    expect(queryDimensionFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      expect.any(String),
      { excludeEmpty: true },
    );
  });

  it("routes session boundaries and event names to their dedicated typed providers", async () => {
    vi.mocked(querySessionBoundaryDimensionFromD1).mockResolvedValue([]);
    vi.mocked(queryEventTypeAggregate).mockResolvedValue([]);
    await readSiteBreakdown({ ...input, dimension: "session.entryPath" });
    await readSiteBreakdown({ ...input, dimension: "event.name" });
    expect(querySessionBoundaryDimensionFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      "entry",
    );
    expect(queryEventTypeAggregate).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
    );
  });

  it("fails closed for unsupported dimensions and filters", async () => {
    await expect(
      readSiteBreakdown({ ...input, dimension: "not.real" }),
    ).rejects.toThrow("unsupported-dimension:not.real");
    await expect(
      readSiteBreakdown({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "forbidden.field" as never },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).rejects.toThrow("invalid-input");
    expect(queryDimensionFromD1).not.toHaveBeenCalled();
  });
});
