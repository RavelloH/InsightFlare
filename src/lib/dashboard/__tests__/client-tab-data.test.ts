import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPrivateJson } from "@/lib/dashboard/client-request";
import { fetchFilterValues } from "@/lib/dashboard/client-tab-data";
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";
import { attachFilterScopePreference } from "@/lib/filter-contract";

vi.mock("@/lib/dashboard/client-request", () => ({
  fetchPrivateJson: vi.fn(),
  fetchPrivateJsonMutate: vi.fn(),
}));

const fetchPrivateJsonMock = vi.mocked(fetchPrivateJson);

const window = {
  preset: "custom" as const,
  from: 1000,
  to: 2000,
  timeZone: "UTC",
  interval: "day" as const,
};

beforeEach(() => {
  fetchPrivateJsonMock.mockReset();
});

describe("fetchFilterValues", () => {
  it("passes a trimmed search term through to the filter-values payload", async () => {
    fetchPrivateJsonMock.mockResolvedValue({
      data: {
        items: [],
        pagination: {
          limit: 100,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    } as any);

    const result = await fetchFilterValues(
      "site-1",
      window,
      "page.path",
      undefined,
      { search: "  Home  ", limit: 100 },
    );

    expect(result.items).toEqual([]);
    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/filter-values",
      expect.objectContaining({ search: "Home", limit: 100 }),
      expect.anything(),
    );
  });

  it("passes the resolved scope with the inherited filter document", async () => {
    fetchPrivateJsonMock.mockResolvedValue({
      data: {
        items: [],
        pagination: {
          limit: 200,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    } as any);
    const filters = attachFilterScopePreference(
      dashboardFilterDocumentFromPresentation({ path: "/pricing" }),
      "visitor",
    );

    await fetchFilterValues("site-1", window, "geo.country", filters, {
      resolvedScope: "session",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/filter-values",
      expect.objectContaining({
        scope: "session",
        "filter[page.path]": "/pricing",
      }),
      expect.anything(),
    );
  });

  it("omits search when no search term is provided", async () => {
    fetchPrivateJsonMock.mockResolvedValue({
      data: {
        items: [],
        pagination: {
          limit: 200,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    } as any);

    const result = await fetchFilterValues(
      "site-1",
      window,
      "page.path",
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result.items).toEqual([]);
    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/filter-values",
      expect.not.objectContaining({ search: expect.anything() }),
      expect.anything(),
    );
  });

  it("returns the empty option list when the request fails", async () => {
    fetchPrivateJsonMock.mockRejectedValue(new Error("network"));

    const result = await fetchFilterValues("site-1", window, "page.path");

    expect(result).toEqual({
      items: [],
      pagination: {
        limit: 0,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    });
  });
});
