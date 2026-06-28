import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELETE as privateDELETE,
  GET as privateGET,
  PATCH as privatePATCH,
  POST as privatePOST,
} from "@/app/api/private/[...segments]/route";
import {
  DELETE as publicDELETE,
  GET as publicGET,
  PATCH as publicPATCH,
  POST as publicPOST,
} from "@/app/api/public/[...segments]/route";
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

function mockRuntime(pathname: string, method = "GET") {
  const request = new Request(`https://app.test${pathname}`, { method });
  const url = new URL(request.url);
  resolveEdgeRuntimeMock.mockResolvedValue({
    request,
    env,
    ctx,
    url,
  } as any);
  return request;
}

describe("edge query route wrappers", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    resolveEdgeRuntimeMock.mockReset();
    apiFetchMock.mockResolvedValue(new Response("hono"));
  });

  it.each([
    ["private GET", privateGET, "/api/private/admin/users", "GET"],
    ["private POST", privatePOST, "/api/private/archive/manifest", "POST"],
    ["private PATCH", privatePATCH, "/api/private/overview", "PATCH"],
    ["private DELETE", privateDELETE, "/api/private/funnels", "DELETE"],
    ["public GET", publicGET, "/api/public/site/overview", "GET"],
    ["public POST", publicPOST, "/api/public/site/overview", "POST"],
    ["public PATCH", publicPATCH, "/api/public/site/overview", "PATCH"],
    ["public DELETE", publicDELETE, "/api/public/site/overview", "DELETE"],
  ])(
    "delegates %s to the shared Hono app",
    async (_label, handler, path, method) => {
      const original = mockRuntime(path, method);

      const response = await handler(original);

      expect(await response.text()).toBe("hono");
      expect(apiFetchMock).toHaveBeenCalledWith(expect.any(Request), env, ctx);
      expect(resolveEdgeRuntimeMock).toHaveBeenCalledWith(original);
    },
  );
});
