import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActor } from "@/lib/edge/admin-auth";
import { handlePerformanceMaintenanceAdmin } from "@/lib/edge/admin-performance-maintenance";
import { runPerformanceMaintenance } from "@/lib/edge/performance-maintenance";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/admin-auth", () => ({
  requireActor: vi.fn(),
}));
vi.mock("@/lib/edge/performance-maintenance", () => ({
  runPerformanceMaintenance: vi.fn(),
}));

const adminActor = {
  isAdmin: true,
  user: { id: "admin-1" },
};
const env = {} as Env;
const requireActorMock = vi.mocked(requireActor);
const runMaintenanceMock = vi.mocked(runPerformanceMaintenance);

function request(method = "POST"): Request {
  return new Request(
    "https://app.test/api/private/admin/performance-foundation/maintenance",
    { method },
  );
}

describe("performance maintenance admin handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(adminActor as never);
    runMaintenanceMock.mockResolvedValue();
  });

  it("requires an authenticated system admin before invoking maintenance", async () => {
    const unauthenticated = new Response(null, { status: 401 });
    requireActorMock.mockResolvedValueOnce(unauthenticated);
    await expect(
      handlePerformanceMaintenanceAdmin(request(), env),
    ).resolves.toBe(unauthenticated);
    expect(runMaintenanceMock).not.toHaveBeenCalled();

    requireActorMock.mockResolvedValueOnce({
      ...adminActor,
      isAdmin: false,
    } as never);
    await expect(
      handlePerformanceMaintenanceAdmin(request(), env),
    ).resolves.toMatchObject({ status: 403 });
    expect(runMaintenanceMock).not.toHaveBeenCalled();
  });

  it("only accepts POST and reports an accepted, fenced run", async () => {
    await expect(
      handlePerformanceMaintenanceAdmin(request("GET"), env),
    ).resolves.toMatchObject({ status: 405 });
    expect(runMaintenanceMock).not.toHaveBeenCalled();

    const response = await handlePerformanceMaintenanceAdmin(request(), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(runMaintenanceMock).toHaveBeenCalledWith(env);
  });
});
