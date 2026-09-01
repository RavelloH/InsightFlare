import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDemoQueryResponse: vi.fn(
    (payload: unknown, status: number) =>
      new Response(JSON.stringify(payload), { status }),
  ),
  executeDemoQueryPayload: vi.fn(async () => ({
    payload: { ok: true },
    status: 200,
  })),
}));

vi.mock("@/lib/edge/analytics/providers/mock/demo-query", () => ({
  createDemoQueryResponse: mocks.createDemoQueryResponse,
  executeDemoQueryPayload: mocks.executeDemoQueryPayload,
}));

import { executeMockQuery } from "@/lib/edge/analytics/adapters/mock";
import { siteQueryContext } from "@/lib/edge/analytics/contract";

describe("mock query provider", () => {
  it("forwards an authorized typed operation to the demo source", async () => {
    const input = {
      operation: "overview" as const,
      request: new Request("https://example.test/api/private/overview"),
      url: new URL("https://example.test/api/private/overview"),
      siteId: "site-1",
      queryContext: siteQueryContext("site-1", "private-dashboard"),
    };
    const response = await executeMockQuery(input);
    expect(response).toBeInstanceOf(Response);
    expect(mocks.executeDemoQueryPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        resolvedScope: "session",
      }),
    );
    expect(mocks.createDemoQueryResponse).toHaveBeenCalledWith(
      { ok: true },
      200,
      false,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("does not invoke the demo source when the typed operation is denied", async () => {
    mocks.executeDemoQueryPayload.mockClear();
    const input = {
      operation: "event-context" as const,
      request: new Request("https://example.test/api/public/share/site/events"),
      url: new URL("https://example.test/api/public/share/site/events"),
      siteId: "site-1",
      publicQuery: true,
      queryContext: siteQueryContext("site-1", "public-share"),
    };
    const response = await executeMockQuery(input);
    expect(response.status).toBe(400);
    expect(mocks.executeDemoQueryPayload).not.toHaveBeenCalled();
  });
});
