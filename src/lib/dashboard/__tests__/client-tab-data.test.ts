import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchFilterValues,
} from "@/lib/dashboard/client-tab-data";
import { fetchPrivateJson } from "@/lib/dashboard/client-request";

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
    fetchPrivateJsonMock.mockResolvedValue({ data: [] } as any);

    const result = await fetchFilterValues(
      "site-1",
      window,
      "page",
      undefined,
      { search: "  Home  ", limit: 100 },
    );

    expect(result).toEqual([]);
    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/filter-values",
      expect.objectContaining({ search: "Home", limit: 100 }),
      expect.anything(),
    );
  });

  it("omits search and falls back to an empty list when payload.data is not an array", async () => {
    fetchPrivateJsonMock.mockResolvedValue({ data: { dangling: true } } as any);

    const result = await fetchFilterValues(
      "site-1",
      window,
      "page",
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual([]);
    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/filter-values",
      expect.not.objectContaining({ search: expect.anything() }),
      expect.anything(),
    );
  });

  it("returns the empty option list when the request fails", async () => {
    fetchPrivateJsonMock.mockRejectedValue(new Error("network"));

    const result = await fetchFilterValues("site-1", window, "page");

    expect(result).toEqual([]);
  });
});
