import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/technology/client-cross",
  () => ({
    queryCrossDimensionFromD1: vi.fn(),
  }),
);

import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import { readSiteCrossBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-cross-breakdown";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  primaryDimension: "page.path",
  secondaryDimension: "client.browser",
  primaryLimit: 5,
  secondaryLimit: 6,
  filters: { version: 1 as const, root: null },
};

describe("site cross-breakdown runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes the typed query and delegates only resolved dimensions", async () => {
    vi.mocked(queryCrossDimensionFromD1).mockResolvedValue({
      columns: [],
      rows: [],
      totalVisitors: 0,
    });
    await expect(readSiteCrossBreakdown(input)).resolves.toEqual({
      columns: [],
      rows: [],
      totalVisitors: 0,
    });
    expect(queryCrossDimensionFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.primaryLimit,
      input.secondaryLimit,
      expect.objectContaining({ fallbackKeyBase: "page" }),
      expect.objectContaining({ fallbackKeyBase: "browser" }),
    );
  });

  it("keeps dimension-pair routing local while leaving filter policy to application", async () => {
    await expect(
      readSiteCrossBreakdown({ ...input, secondaryDimension: "page.path" }),
    ).rejects.toThrow("unsupported-dimension");
    await expect(
      readSiteCrossBreakdown({ ...input, primaryDimension: "event.name" }),
    ).rejects.toThrow("unsupported-dimension");
    await expect(
      readSiteCrossBreakdown({
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
    ).resolves.toBeDefined();
    expect(queryCrossDimensionFromD1).toHaveBeenCalled();
  });
});
