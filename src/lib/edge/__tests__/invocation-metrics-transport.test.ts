import { afterEach, describe, expect, it, vi } from "vitest";

import { queryInvocationMetrics } from "@/lib/edge/admin/observability/invocation-metrics-transport";

const input = {
  apiUrl: "https://api.cloudflare.com/client/v4/accounts",
  accountId: "account-1",
  token: "test-token",
  sql: "SELECT value FROM invocation_metrics FORMAT JSONEachRow",
  limit: 10,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("invocation metrics transport", () => {
  it("uses the Cloudflare SQL endpoint and parses strict JSONEachRow", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql",
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      expect(init?.body).toBe(input.sql);
      expect(init?.redirect).toBe("manual");
      return new Response('{"invocationId":"a"}\n{"invocationId":"b"}\n');
    });

    await expect(
      queryInvocationMetrics({ ...input, fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      rows: [{ invocationId: "a" }, { invocationId: "b" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "rate_limited"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [503, "service_unavailable"],
    [507, "insufficient_storage"],
  ] as const)(
    "maps upstream HTTP %i without returning its body",
    async (status, code) => {
      const secretBody = "upstream-secret-response";
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(secretBody, {
            status,
            headers: { "retry-after": "12" },
          }),
      );
      const result = await queryInvocationMetrics({ ...input, fetchImpl });

      expect(result).toEqual({
        ok: false,
        code,
        retryAfterSeconds: 12,
      });
      expect(JSON.stringify(result)).not.toContain(secretBody);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects redirects without following them", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("redirect body", {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        }),
    );

    await expect(
      queryInvocationMetrics({ ...input, fetchImpl }),
    ).resolves.toMatchObject({ ok: false, code: "redirect_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["not-json\n", "[]\n", "null\n", '{"ok":true}\n\n{"ok":false}\n'])(
    "rejects malformed JSONEachRow response %j",
    async (body) => {
      await expect(
        queryInvocationMetrics({
          ...input,
          fetchImpl: async () => new Response(body),
        }),
      ).resolves.toMatchObject({ ok: false, code: "malformed_response" });
    },
  );

  it("enforces the hard 100-row cap and response byte cap", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      JSON.stringify({ index }),
    ).join("\n");
    await expect(
      queryInvocationMetrics({
        ...input,
        limit: 100,
        fetchImpl: async () => new Response(rows),
      }),
    ).resolves.toMatchObject({ ok: false, code: "too_many_rows" });

    await expect(
      queryInvocationMetrics({
        ...input,
        fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
      }),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });
  });

  it("times out stalled fetches and response bodies", async () => {
    vi.useFakeTimers();
    const stalledFetch = queryInvocationMetrics({
      ...input,
      fetchImpl: async () => new Promise<Response>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stalledFetch).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    });

    const stalledBody = queryInvocationMetrics({
      ...input,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
          }),
        ),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stalledBody).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("caps concurrent requests without queuing or retrying", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    const pending = Array.from({ length: 4 }, () =>
      queryInvocationMetrics({ ...input, fetchImpl }),
    );

    await expect(
      queryInvocationMetrics({ ...input, fetchImpl: vi.fn<typeof fetch>() }),
    ).resolves.toEqual({
      ok: false,
      code: "concurrency_limited",
      retryAfterSeconds: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    for (const resolve of resolvers) resolve(new Response('{"ok":true}\n'));
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ ok: true, rows: [{ ok: true }] })),
    );
  });

  it("maps TimeoutError signals to timeout and user cancellation to aborted", async () => {
    await expect(
      queryInvocationMetrics({
        ...input,
        signal: AbortSignal.abort(new DOMException("deadline", "TimeoutError")),
      }),
    ).resolves.toEqual({ ok: false, code: "timeout", retryAfterSeconds: null });

    const controller = new AbortController();
    const pending = queryInvocationMetrics({
      ...input,
      signal: controller.signal,
      fetchImpl: async () => new Promise<Response>(() => {}),
    });
    controller.abort();
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "aborted",
      retryAfterSeconds: null,
    });
  });
});
