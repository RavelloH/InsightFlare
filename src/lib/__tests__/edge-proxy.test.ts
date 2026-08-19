import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionToken } from "@/lib/auth";
import {
  buildEdgeUrl,
  buildEdgeUrlWithBase,
  fetchEdgeForServer,
  resolveEdgeBaseUrl,
} from "@/lib/edge-proxy";

vi.mock("@/lib/auth", () => ({
  getSessionToken: vi.fn().mockResolvedValue("session-token"),
}));

const getSessionTokenMock = vi.mocked(getSessionToken);

describe("edge proxy helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getSessionTokenMock.mockReset();
    getSessionTokenMock.mockResolvedValue("session-token");
  });

  it("resolves the edge base URL from request URL or default fallback", () => {
    expect(resolveEdgeBaseUrl("https://app.example.test/path?q=1")).toBe(
      "https://app.example.test",
    );
    expect(resolveEdgeBaseUrl("not a url")).toBe("http://127.0.0.1:8787");
    expect(resolveEdgeBaseUrl()).toBe("http://127.0.0.1:8787");
  });

  it("builds edge URLs with base, path, and query params", () => {
    expect(
      buildEdgeUrlWithBase("https://edge.example.test/base", "/api/test", {
        q: "hello world",
      }),
    ).toBe("https://edge.example.test/api/test?q=hello+world");

    expect(buildEdgeUrl("/api/test", { siteId: "site-1" })).toBe(
      "http://127.0.0.1:8787/api/test?siteId=site-1",
    );
  });

  it("forwards server requests with session authorization and JSON body handling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEdgeForServer({
      baseUrl: "https://edge.example.test",
      pathname: "/api/write",
      method: "PATCH",
      params: { siteId: "site-1" },
      headers: {
        "x-custom": "yes",
        "x-empty": "",
      },
      body: { enabled: true },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;

    expect(url).toBe("https://edge.example.test/api/write?siteId=site-1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ enabled: true }));
    expect(init.cache).toBe("no-store");
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("yes");
    expect(headers.has("x-empty")).toBe(false);
  });

  it("does not attach a body or JSON content type for GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEdgeForServer({
      baseUrl: "https://edge.example.test",
      pathname: "/api/read",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("content-type")).toBeNull();
  });

  it("falls back to the default edge base URL when none is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEdgeForServer({
      pathname: "/api/relay",
      params: { siteId: "site-1" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(url).toBe("http://127.0.0.1:8787/api/relay?siteId=site-1");
    expect(headers.get("authorization")).toBe("Bearer session-token");
  });

  it("handles unavailable sessions and HEAD requests without auth or body", async () => {
    getSessionTokenMock.mockRejectedValue(new Error("outside request scope"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEdgeForServer({
      baseUrl: "https://edge.example.test",
      pathname: "/api/ping",
      method: "HEAD",
      headers: {
        "x-empty": undefined,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(url).toBe("https://edge.example.test/api/ping");
    expect(init.method).toBe("HEAD");
    expect(init.body).toBeUndefined();
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-empty")).toBe(false);
  });

  it("sends empty JSON objects for POST requests without an explicit body", async () => {
    getSessionTokenMock.mockResolvedValue("");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEdgeForServer({
      baseUrl: "https://edge.example.test",
      pathname: "/api/write",
      method: "POST",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(init.body).toBe("{}");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });
});
