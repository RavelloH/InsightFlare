import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestAdminService } from "@/lib/admin-service-client";
import { fetchEdgeJson } from "@/lib/edge-client";

vi.mock("@/lib/edge-client", () => ({
  fetchEdgeJson: vi.fn(),
}));

const fetchEdgeJsonMock = vi.mocked(fetchEdgeJson);

describe("admin service client", () => {
  beforeEach(() => {
    fetchEdgeJsonMock.mockReset();
  });

  it("uses the shared management route contract", async () => {
    fetchEdgeJsonMock.mockResolvedValue({
      ok: true,
      data: [{ id: "team-1" }],
    });
    const controller = new AbortController();

    await expect(
      requestAdminService<{ id: string }[]>("teams", {
        params: { userId: "user-1", includeArchived: false },
        signal: controller.signal,
      }),
    ).resolves.toEqual([{ id: "team-1" }]);

    expect(fetchEdgeJsonMock).toHaveBeenCalledWith({
      path: "/api/private/admin/teams",
      params: { userId: "user-1", includeArchived: "false" },
      signal: controller.signal,
    });
  });

  it("accepts diagnostic payloads that intentionally omit the data envelope", async () => {
    fetchEdgeJsonMock.mockResolvedValue({
      ok: true,
      summary: { healthy: true },
    });

    await expect(
      requestAdminService<{ ok: boolean; summary: { healthy: boolean } }>(
        "system-performance",
      ),
    ).resolves.toEqual({ ok: true, summary: { healthy: true } });
  });

  it("raises the shared API error message for unsuccessful responses", async () => {
    fetchEdgeJsonMock.mockResolvedValue({
      ok: false,
      error: { message: "Team access denied" },
    });

    await expect(requestAdminService("teams")).rejects.toThrow(
      "Team access denied",
    );
  });
});
