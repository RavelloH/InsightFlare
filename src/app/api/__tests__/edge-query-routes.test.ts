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
import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handlePrivateArchive } from "@/lib/edge/archive-query";
import { handlePrivateQuery, handlePublicQuery } from "@/lib/edge/query";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";

vi.mock("@/lib/edge/admin", () => ({
  handlePrivateAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/archive-query", () => ({
  handlePrivateArchive: vi.fn(),
}));

vi.mock("@/lib/edge/query", () => ({
  handlePrivateQuery: vi.fn(),
  handlePublicQuery: vi.fn(),
}));

vi.mock("@/lib/edge/runtime", () => ({
  resolveEdgeRuntime: vi.fn(),
}));

const handlePrivateAdminMock = vi.mocked(handlePrivateAdmin);
const handlePrivateArchiveMock = vi.mocked(handlePrivateArchive);
const handlePrivateQueryMock = vi.mocked(handlePrivateQuery);
const handlePublicQueryMock = vi.mocked(handlePublicQuery);
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
    handlePrivateAdminMock.mockReset();
    handlePrivateArchiveMock.mockReset();
    handlePrivateQueryMock.mockReset();
    handlePublicQueryMock.mockReset();
    resolveEdgeRuntimeMock.mockReset();
    handlePrivateAdminMock.mockResolvedValue(new Response("admin"));
    handlePrivateArchiveMock.mockResolvedValue(new Response("archive"));
    handlePrivateQueryMock.mockResolvedValue(new Response("private-query"));
    handlePublicQueryMock.mockResolvedValue(new Response("public-query"));
  });

  it("routes private admin requests to the admin handler", async () => {
    const original = mockRuntime("/api/private/admin/users");

    const response = await privateGET(original);

    expect(await response.text()).toBe("admin");
    expect(handlePrivateAdminMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/admin/users"),
    );
    expect(handlePrivateArchiveMock).not.toHaveBeenCalled();
    expect(handlePrivateQueryMock).not.toHaveBeenCalled();
  });

  it("routes private archive requests to the archive handler", async () => {
    const original = mockRuntime("/api/private/archive/manifest");

    const response = await privatePOST(original);

    expect(await response.text()).toBe("archive");
    expect(handlePrivateArchiveMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/archive/manifest"),
    );
  });

  it("routes other private requests to the query handler with execution context", async () => {
    const original = mockRuntime("/api/private/overview", "PATCH");

    const response = await privatePATCH(original);

    expect(await response.text()).toBe("private-query");
    expect(handlePrivateQueryMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/overview"),
      ctx,
    );
  });

  it("routes public requests to the public query handler", async () => {
    const original = mockRuntime("/api/public/site/overview");

    const response = await publicGET(original);

    expect(await response.text()).toBe("public-query");
    expect(handlePublicQueryMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/public/site/overview"),
      ctx,
    );
  });

  it("routes public mutation methods to the public query handler for rejection", async () => {
    const post = mockRuntime("/api/public/site/overview", "POST");
    await publicPOST(post);

    const patch = mockRuntime("/api/public/site/overview", "PATCH");
    await publicPATCH(patch);

    const del = mockRuntime("/api/public/site/overview", "DELETE");
    await publicDELETE(del);

    expect(handlePublicQueryMock).toHaveBeenCalledTimes(3);
    expect(
      handlePublicQueryMock.mock.calls.map((call) => call[0].method),
    ).toEqual(["POST", "PATCH", "DELETE"]);
  });

  it("routes DELETE requests to the query handler", async () => {
    const original = mockRuntime("/api/private/funnels?id=abc", "DELETE");

    const response = await privateDELETE(original);

    expect(await response.text()).toBe("private-query");
    expect(handlePrivateQueryMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/funnels?id=abc"),
      ctx,
    );
  });

  it("routes DELETE admin requests to the admin handler", async () => {
    const original = mockRuntime("/api/private/admin/users/123", "DELETE");

    const response = await privateDELETE(original);

    expect(await response.text()).toBe("admin");
    expect(handlePrivateAdminMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/admin/users/123"),
    );
  });

  it("routes DELETE archive requests to the archive handler", async () => {
    const original = mockRuntime("/api/private/archive/data", "DELETE");

    const response = await privateDELETE(original);

    expect(await response.text()).toBe("archive");
    expect(handlePrivateArchiveMock).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/archive/data"),
    );
  });
});
