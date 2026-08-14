import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActor } from "@/lib/edge/admin-auth";
import { handlePerformanceDiagnosticBypassAdmin } from "@/lib/edge/admin-performance-diagnostic-bypass";
import { issueDiagnosticCacheBypassToken } from "@/lib/edge/diagnostic-cache-bypass";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/admin-auth", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/edge/diagnostic-cache-bypass", () => ({
  DIAGNOSTIC_CACHE_BYPASS_HEADER: "x-insightflare-diagnostics-bypass",
  issueDiagnosticCacheBypassToken: vi.fn(),
}));

const actor = { isAdmin: true, user: { id: "admin-1" } };
const env = {} as Env;
const requireActorMock = vi.mocked(requireActor);
const issueTokenMock = vi.mocked(issueDiagnosticCacheBypassToken);

function request(method = "POST", target?: unknown): Request {
  return new Request(
    "https://app.test/api/private/admin/performance-foundation/diagnostic-cache-bypass",
    {
      method,
      headers:
        target === undefined
          ? undefined
          : { "content-type": "application/json" },
      body: target === undefined ? undefined : JSON.stringify({ target }),
    },
  );
}

describe("performance diagnostic bypass admin handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(actor as never);
    issueTokenMock.mockResolvedValue("signed-token");
  });

  it("requires an authenticated system admin before minting a token", async () => {
    const unauthenticated = new Response(null, { status: 401 });
    requireActorMock.mockResolvedValueOnce(unauthenticated);
    await expect(
      handlePerformanceDiagnosticBypassAdmin(
        request("POST", "/api/private/v2/journeys/visitors"),
        env,
      ),
    ).resolves.toBe(unauthenticated);
    expect(issueTokenMock).not.toHaveBeenCalled();

    requireActorMock.mockResolvedValueOnce({
      ...actor,
      isAdmin: false,
    } as never);
    await expect(
      handlePerformanceDiagnosticBypassAdmin(
        request("POST", "/api/private/v2/journeys/visitors"),
        env,
      ),
    ).resolves.toMatchObject({ status: 403 });
    expect(issueTokenMock).not.toHaveBeenCalled();
  });

  it("only mints a GET token for allowlisted same-origin v2 targets", async () => {
    await expect(
      handlePerformanceDiagnosticBypassAdmin(request("GET"), env),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      handlePerformanceDiagnosticBypassAdmin(
        request("POST", "https://evil.test/api/private/v2/journeys/visitors"),
        env,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handlePerformanceDiagnosticBypassAdmin(
        request("POST", "/api/private/overview"),
        env,
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(issueTokenMock).not.toHaveBeenCalled();

    const response = await handlePerformanceDiagnosticBypassAdmin(
      request(
        "POST",
        "/api/private/v2/journeys/visitors?siteId=site-1&from=1&to=2",
      ),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      header: "x-insightflare-diagnostics-bypass",
      target: "/api/private/v2/journeys/visitors?siteId=site-1&from=1&to=2",
      token: "signed-token",
    });
    expect(issueTokenMock).toHaveBeenCalledWith({
      actorId: "admin-1",
      env,
      request: expect.objectContaining({ method: "GET" }),
    });
  });

  it("fails closed when a token cannot be reserved", async () => {
    issueTokenMock.mockResolvedValueOnce(null);

    const response = await handlePerformanceDiagnosticBypassAdmin(
      request("POST", "/api/private/admin/v2/scheduled-tasks"),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "diagnostic_bypass_unavailable" },
    });
  });
});
