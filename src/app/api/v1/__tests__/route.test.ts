import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, PATCH, POST } from "@/app/api/v1/[[...path]]/route";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import apiApp from "@/lib/hono/app";

vi.mock("@/lib/edge/runtime", () => ({
  resolveEdgeRuntime: vi.fn(),
}));

vi.mock("@/lib/hono/app", () => ({
  default: {
    fetch: vi.fn(),
  },
}));

const apiFetchMock = vi.mocked(apiApp.fetch);
const resolveEdgeRuntimeMock = vi.mocked(resolveEdgeRuntime);

const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
};

function mockRuntime(method: string) {
  const request = new Request("https://app.test/api/v1/sites", { method });
  const url = new URL(request.url);
  resolveEdgeRuntimeMock.mockResolvedValue({
    request,
    env,
    ctx,
    url,
  } as any);
  return request;
}

describe("API v1 Next route fallback", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    resolveEdgeRuntimeMock.mockReset();
    apiFetchMock.mockResolvedValue(new Response("hono"));
  });

  it.each([
    ["GET", GET],
    ["POST", POST],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])(
    "delegates %s requests to the shared Hono app",
    async (method, handler) => {
      const request = mockRuntime(method);

      const response = await handler(request);

      expect(await response.text()).toBe("hono");
      expect(resolveEdgeRuntimeMock).toHaveBeenCalledWith(request);
      expect(apiFetchMock).toHaveBeenCalledWith(expect.any(Request), env, ctx);
    },
  );
});
