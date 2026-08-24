import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/filter-values", () => ({
  queryFilterValuesFromD1: vi.fn(),
}));

import type { FilterFieldId } from "@/lib/edge/analytics/contract";
import { queryFilterValuesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
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

  it("rejects payload or unknown fields before the provider", async () => {
    await expect(
      readSiteFilterValues({ ...input, field: "event.payload" }),
    ).rejects.toThrow("unsupported-filter-field");
    await expect(
      readSiteFilterValues({
        ...input,
        field: "unknown.field",
      }),
    ).rejects.toThrow("unsupported-filter-field");
    expect(queryFilterValuesFromD1).not.toHaveBeenCalled();
  });

  it("rejects invalid filter documents and provider failures", async () => {
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
    ).rejects.toThrow("invalid-input");
    vi.mocked(queryFilterValuesFromD1).mockRejectedValueOnce(
      new Error("D1 unavailable"),
    );
    await expect(readSiteFilterValues(input)).rejects.toThrow("internal");
  });
});
