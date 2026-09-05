import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/filter-values", () => ({
  queryFilterValuesFromD1: vi.fn(),
  queryFilterValuesPageFromD1: vi.fn(),
}));

import type { FilterFieldId } from "@/lib/edge/analytics/contract";
import {
  queryFilterValuesFromD1,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import {
  readSiteFilterValues,
  type ReadSiteFilterValuesInput,
} from "@/lib/edge/analytics/providers/d1/operations/site-filter-values";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  filters: {
    version: 1 as const,
    root: {
      kind: "and" as const,
      children: [
        {
          kind: "condition" as const,
          target: {
            kind: "field" as const,
            field: "page.path" as FilterFieldId,
          },
          operator: "eq" as const,
          value: "/pricing",
        },
        {
          kind: "condition" as const,
          target: {
            kind: "field" as const,
            field: "geo.country" as FilterFieldId,
          },
          operator: "eq" as const,
          value: "US",
        },
      ],
    },
  },
  field: "page.path",
  search: "/",
  limit: 50,
} satisfies ReadSiteFilterValuesInput;

describe("site filter-values runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips the selected top-level facet before querying candidates", async () => {
    vi.mocked(queryFilterValuesFromD1).mockResolvedValue([
      { value: "/pricing", occurrences: 10 },
    ]);
    await expect(readSiteFilterValues(input)).resolves.toMatchObject({
      field: "page.path",
      items: [{ value: "/pricing", label: "/pricing", occurrences: 10 }],
      page: { limit: 50, hasMore: false, nextCursor: null },
    });
    expect(queryFilterValuesFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      { version: 1, root: input.filters.root.children[1] },
      "page.path",
      50,
      "/",
    );
  });

  it("passes field selection to the provider without audience policy", async () => {
    await expect(
      readSiteFilterValues({ ...input, field: "event.payload" }),
    ).resolves.toBeDefined();
    await expect(
      readSiteFilterValues({
        ...input,
        field: "unknown.field",
      }),
    ).resolves.toBeDefined();
    expect(queryFilterValuesFromD1).toHaveBeenCalled();
  });

  it("passes canonical filters through and preserves provider failures", async () => {
    await expect(
      readSiteFilterValues({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: {
              kind: "field",
              field: "unknown.field" as FilterFieldId,
            },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).resolves.toBeDefined();
    vi.mocked(queryFilterValuesFromD1).mockRejectedValueOnce(
      new Error("D1 unavailable"),
    );
    await expect(readSiteFilterValues(input)).rejects.toThrow("D1 unavailable");
  });

  it("returns the provider pagination contract for candidate pages", async () => {
    vi.mocked(queryFilterValuesPageFromD1).mockResolvedValue({
      items: [{ value: "/docs", occurrences: 7 }],
      pagination: {
        limit: 1,
        returned: 1,
        hasMore: true,
        nextCursor: "next-filter-cursor",
      },
    });

    await expect(
      readSiteFilterValues({
        ...input,
        audience: "public-share",
        page: { limit: 1, cursor: "filter-cursor" },
      }),
    ).resolves.toEqual({
      field: "page.path",
      items: [{ value: "/docs", label: "/docs", occurrences: 7 }],
      pagination: {
        limit: 1,
        returned: 1,
        hasMore: true,
        nextCursor: "next-filter-cursor",
      },
    });
    expect(queryFilterValuesPageFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      { version: 1, root: input.filters.root.children[1] },
      input.field,
      1,
      "filter-cursor",
      input.search,
      "public-share",
    );
  });
});
