import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSavedFilter,
  deleteSavedFilter,
  fetchSavedFilters,
  updateSavedFilter,
} from "@/lib/dashboard/saved-filter-data";
import type { SavedFilterInput } from "@/lib/saved-filters";

const request = vi.hoisted(() => ({
  fetchPrivateJson: vi.fn(),
  fetchPrivateJsonMutate: vi.fn(),
}));

vi.mock("@/lib/dashboard/client/request", () => request);

const INPUT = {
  name: "Docs traffic",
  filters: null,
} as unknown as SavedFilterInput;

describe("saved filter client data", () => {
  beforeEach(() => {
    request.fetchPrivateJson.mockReset().mockResolvedValue({ items: [] });
    request.fetchPrivateJsonMutate.mockReset().mockResolvedValue({ id: "f1" });
  });

  it("lists saved filters with the default page size", async () => {
    await expect(fetchSavedFilters("site-1")).resolves.toEqual({ items: [] });

    expect(request.fetchPrivateJson).toHaveBeenCalledWith(
      "/api/private/saved-filters",
      { siteId: "site-1", limit: 100 },
      { signal: undefined },
    );
  });

  it("forwards the page size, cursor and abort signal when given", async () => {
    const controller = new AbortController();
    await fetchSavedFilters("site-1", {
      limit: 25,
      cursor: "cursor-token",
      signal: controller.signal,
    });

    expect(request.fetchPrivateJson).toHaveBeenCalledWith(
      "/api/private/saved-filters",
      { siteId: "site-1", limit: 25, cursor: "cursor-token" },
      { signal: controller.signal },
    );
  });

  it("omits an empty cursor from the list request", async () => {
    await fetchSavedFilters("site-1", { cursor: null });

    expect(request.fetchPrivateJson).toHaveBeenCalledWith(
      "/api/private/saved-filters",
      { siteId: "site-1", limit: 100 },
      { signal: undefined },
    );
  });

  it("creates a saved filter with POST for the site", async () => {
    await expect(createSavedFilter("site-1", INPUT)).resolves.toEqual({
      id: "f1",
    });

    expect(request.fetchPrivateJsonMutate).toHaveBeenCalledWith(
      "/api/private/saved-filters",
      "POST",
      { siteId: "site-1" },
      INPUT,
    );
  });

  it("updates a saved filter with PUT and encodes the filter id", async () => {
    await updateSavedFilter("site-1", "id/with space", INPUT);

    expect(request.fetchPrivateJsonMutate).toHaveBeenCalledWith(
      "/api/private/saved-filters/id%2Fwith%20space",
      "PUT",
      { siteId: "site-1" },
      INPUT,
    );
  });

  it("deletes a saved filter with DELETE and no body", async () => {
    await deleteSavedFilter("site-1", "id/with space");

    expect(request.fetchPrivateJsonMutate).toHaveBeenCalledWith(
      "/api/private/saved-filters/id%2Fwith%20space",
      "DELETE",
      { siteId: "site-1" },
    );
  });
});
