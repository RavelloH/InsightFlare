import { describe, expect, it, vi } from "vitest";

import { queryInvocationMetrics } from "@/lib/edge/admin/observability/invocation-metrics-transport";

const input = {
  apiUrl: "https://api.cloudflare.com/client/v4/accounts",
  accountId: "account-1",
  token: "test-token",
  sql: "SELECT retainedSamples FORMAT JSONEachRow",
  limit: 3,
};

describe("AE invocation read transport: bounded errors and strict results", () => {
  it("accepts empty streams and CRLF-separated object rows without returning extra data", async () => {
    await expect(
      queryInvocationMetrics({
        ...input,
        fetchImpl: async () => new Response(null),
      }),
    ).resolves.toEqual({ ok: true, rows: [] });

    await expect(
      queryInvocationMetrics({
        ...input,
        fetchImpl: async () => new Response('{"one":1}\r\n{"two":2}\r\n'),
      }),
    ).resolves.toEqual({
      ok: true,
      rows: [{ one: 1 }, { two: 2 }],
    });
  });

  it("rejects invalid UTF-8, inaccurate declared byte lengths and excessive row counts", async () => {
    await expect(
      queryInvocationMetrics({
        ...input,
        fetchImpl: async () => new Response(new Uint8Array([0xff])),
      }),
    ).resolves.toMatchObject({ ok: false, code: "malformed_response" });

    await expect(
      queryInvocationMetrics({
        ...input,
        fetchImpl: async () =>
          new Response("small", {
            headers: { "content-length": "1048577" },
          }),
      }),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });

    await expect(
      queryInvocationMetrics({
        ...input,
        limit: 1,
        fetchImpl: async () => new Response('{"a":1}\n{"b":2}\n'),
      }),
    ).resolves.toMatchObject({ ok: false, code: "too_many_rows" });
  });

  it("uses controlled upstream-error and HTTP Retry-After date handling", async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const result = await queryInvocationMetrics({
      ...input,
      fetchImpl: async () =>
        new Response("upstream private response", {
          status: 418,
          headers: { "retry-after": future },
        }),
    });
    expect(result).toMatchObject({ ok: false, code: "upstream_error" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(30);
    }
    expect(JSON.stringify(result)).not.toContain("private response");

    const huge = await queryInvocationMetrics({
      ...input,
      fetchImpl: async () =>
        new Response("error", {
          status: 429,
          headers: { "retry-after": "999999999999999999999999" },
        }),
    });
    expect(huge).toEqual({
      ok: false,
      code: "rate_limited",
      retryAfterSeconds: null,
      providerStatus: 429,
    });
  });

  it("fails closed before fetching for unusable URLs, tokens, SQL, and limits", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const invalid = [
      { apiUrl: "ftp://api.example" },
      { apiUrl: "https://user:pass@api.example" },
      { apiUrl: "not-an-http-url" },
      { accountId: "" },
      { token: "" },
      { token: "line\nsecret" },
      { sql: " " },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
    ] as const;
    for (const change of invalid) {
      await expect(
        queryInvocationMetrics({ ...input, ...change, fetchImpl }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps fetch rejection to a safe network error without exposing its message", async () => {
    const result = await queryInvocationMetrics({
      ...input,
      fetchImpl: async () => {
        throw new Error("credential from network stack must remain private");
      },
    });
    expect(result).toEqual({
      ok: false,
      code: "network_error",
      retryAfterSeconds: null,
    });
  });
});
