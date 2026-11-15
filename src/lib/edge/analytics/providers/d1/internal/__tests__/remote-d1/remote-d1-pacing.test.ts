// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import {
  assertDisposableDatabase,
  C01_DATABASE_ID,
  C01_DATABASE_NAME,
  createRemoteD1Database,
  createRemoteRequestPacing,
  type RemoteHttpAttempt,
  type RemoteStatementMeta,
} from "./remote-d1-database";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const result = () =>
  new Response(
    JSON.stringify({
      success: true,
      result: [
        {
          results: [{ value: 1 }],
          meta: {
            rows_read: 1,
            rows_written: 0,
            timings: { sql_duration_ms: 2 },
          },
        },
      ],
    }),
  );

it("shares fixed start spacing across target checks, statements and batches without charging pacing to SQL or HTTP duration", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const attempts: RemoteHttpAttempt[] = [];
  const metas: RemoteStatementMeta[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      starts.push(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 25));
      return init.method === "POST"
        ? result()
        : new Response(
            JSON.stringify({
              success: true,
              result: { name: C01_DATABASE_NAME },
            }),
          );
    }),
  );
  const options = {
    accountId: "test",
    databaseId: C01_DATABASE_ID,
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt: RemoteHttpAttempt) => attempts.push(attempt),
    onStatement: (meta: RemoteStatementMeta) => metas.push(meta),
  };
  const db = createRemoteD1Database(options);
  // Deliberately concurrent callers must still produce serial HTTP requests.
  const pending = Promise.all([
    assertDisposableDatabase(options),
    db.prepare("SELECT 1").all(),
    db.batch([db.prepare("SELECT 1")]),
  ]);
  await vi.runAllTimersAsync();
  await pending;
  expect(starts).toEqual([0, 1000, 2000]);
  expect(
    attempts.map(({ pacingWaitMs, requestStartIntervalMs, elapsedMs }) => ({
      pacingWaitMs,
      requestStartIntervalMs,
      elapsedMs,
    })),
  ).toEqual([
    { pacingWaitMs: 0, requestStartIntervalMs: 1000, elapsedMs: 25 },
    { pacingWaitMs: 1000, requestStartIntervalMs: 1000, elapsedMs: 25 },
    { pacingWaitMs: 2000, requestStartIntervalMs: 1000, elapsedMs: 25 },
  ]);
  expect(metas.map((meta) => meta.sqlDurationMs)).toEqual([2, 2]);
});

it("serializes complete HTTP responses and releases a failed request without changing spacing", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const attempts: RemoteHttpAttempt[] = [];
  let active = 0;
  let maxActive = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const index = starts.length;
      starts.push(performance.now());
      maxActive = Math.max(maxActive, ++active);
      // A response longer than the start interval must keep the queue occupied.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      active--;
      if (index === 0) throw new Error("offline");
      return result();
    }),
  );
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.allSettled([
    db.prepare("SELECT 1").all(),
    db.prepare("SELECT 1").all(),
  ]);
  await vi.runAllTimersAsync();
  const outcomes = await pending;
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(starts).toEqual([0, 1500]);
  expect(maxActive).toBe(1);
  expect(attempts[0]).toMatchObject({
    outcome: "transport-error",
    pacingWaitMs: 0,
    elapsedMs: 1500,
  });
  expect(attempts[1]).toMatchObject({
    outcome: "response",
    pacingWaitMs: 1500,
    elapsedMs: 1500,
  });
});

it("holds the queue through response JSON and paces retry attempts separately from backoff", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const attempts: RemoteHttpAttempt[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const index = starts.length;
      starts.push(performance.now());
      if (index === 0) return new Response("", { status: 503 });
      const response = result();
      const readText = response.text.bind(response);
      response.text = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return readText();
      };
      return response;
    }),
  );
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.all([
    db.prepare("SELECT 1").all(),
    db.prepare("SELECT 1").all(),
  ]);
  await vi.runAllTimersAsync();
  await pending;
  expect(starts).toEqual([0, 1000, 2500]);
  expect(
    attempts.map(({ status, retry, backoffMs, pacingWaitMs, elapsedMs }) => ({
      status,
      retry,
      backoffMs,
      pacingWaitMs,
      elapsedMs,
    })),
  ).toEqual([
    { status: 503, retry: true, backoffMs: 500, pacingWaitMs: 0, elapsedMs: 0 },
    {
      status: 200,
      retry: false,
      backoffMs: 0,
      pacingWaitMs: 1000,
      elapsedMs: 1500,
    },
    {
      status: 200,
      retry: false,
      backoffMs: 0,
      pacingWaitMs: 2000,
      elapsedMs: 1500,
    },
  ]);
});

it("consumes a slow 429 body before releasing the queue and preserves exact errors and only diagnostic headers", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const attempts: RemoteHttpAttempt[] = [];
  const body = JSON.stringify({
    success: false,
    errors: [
      {
        code: 7500,
        message:
          "D1 DB is overloaded. Too many resources consumed within a 10 second window.",
      },
    ],
  });
  let consumed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const index = starts.length;
      starts.push(performance.now());
      if (index !== 0) {
        expect(consumed).toBe(true);
        return result();
      }
      const response = new Response(body, {
        status: 429,
        headers: {
          "Retry-After": "10",
          "CF-Ray": "test-ray",
          "X-Request-ID": "test-request",
          "X-RateLimit-Remaining": "0",
          Authorization: "must-not-be-observed",
          "Set-Cookie": "must-not-be-observed",
        },
      });
      const read = response.text.bind(response);
      response.text = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        consumed = true;
        return read();
      };
      return response;
    }),
  );
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.all([
    db.prepare("SELECT 1").all(),
    db.prepare("SELECT 1").all(),
  ]);
  await vi.runAllTimersAsync();
  await pending;
  expect(starts).toEqual([0, 1500, 2500]);
  expect(attempts[0]).toMatchObject({
    status: 429,
    retry: true,
    backoffMs: 500,
    elapsedScope: "response-json",
    elapsedMs: 1500,
    responseHeadersElapsedMs: 0,
    responseBodyElapsedMs: 1500,
    responseBody: body,
    responseErrors: JSON.parse(body).errors,
    responseHeaders: {
      "retry-after": "10",
      "cf-ray": "test-ray",
      "x-request-id": "test-request",
      "x-ratelimit-remaining": "0",
    },
  });
  expect(Object.keys(attempts[0].responseHeaders ?? {})).toHaveLength(4);
  expect(JSON.stringify(attempts)).not.toContain("must-not-be-observed");
  expect(attempts[2]).toMatchObject({ pacingWaitMs: 500, elapsedMs: 0 });
});

it("retains non-JSON retry bodies and fails a final JSON parse without hiding the raw response", async () => {
  vi.useFakeTimers();
  const attempts: RemoteHttpAttempt[] = [];
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("upstream overloaded", {
        status: 503,
        headers: { "CF-Ray": "first-ray" },
      }),
    )
    .mockResolvedValueOnce(
      new Response("invalid final JSON", {
        status: 200,
        headers: { "CF-Ray": "final-ray" },
      }),
    )
    .mockResolvedValueOnce(result());
  vi.stubGlobal("fetch", mockFetch);
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.allSettled([db.prepare("SELECT 1").all()]);
  await vi.runAllTimersAsync();
  expect((await pending)[0].status).toBe("rejected");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({
    status: 503,
    retry: true,
    responseBody: "upstream overloaded",
    responseBodyError: { name: "SyntaxError" },
    responseHeaders: { "cf-ray": "first-ray" },
  });
  expect(attempts[1]).toMatchObject({
    status: 200,
    retry: false,
    responseBody: "invalid final JSON",
    responseBodyError: { name: "SyntaxError" },
    responseHeaders: { "cf-ray": "final-ray" },
  });
  // A parse rejection must also release the shared queue for a new caller.
  const next = db.prepare("SELECT 1").all();
  await vi.runAllTimersAsync();
  await expect(next).resolves.toMatchObject({ success: true });
  expect(mockFetch).toHaveBeenCalledTimes(3);
});

it("records a failed retry-body stream, performs no unobserved retry, and releases the queue", async () => {
  vi.useFakeTimers();
  const attempts: RemoteHttpAttempt[] = [];
  const starts: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const index = starts.length;
      starts.push(performance.now());
      if (index !== 0) return result();
      const response = new Response("", { status: 429 });
      response.text = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        throw new Error("body stream interrupted");
      };
      return response;
    }),
  );
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.allSettled([
    db.prepare("SELECT 1").all(),
    db.prepare("SELECT 1").all(),
  ]);
  await vi.runAllTimersAsync();
  expect((await pending).map((outcome) => outcome.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(starts).toEqual([0, 1500]);
  expect(attempts[0]).toMatchObject({
    status: 429,
    retry: false,
    backoffMs: 0,
    elapsedMs: 1500,
    responseBodyError: { message: "body stream interrupted" },
  });
  expect(attempts[0].responseBody).toBeUndefined();
});

it.each([0, -1, NaN, Infinity, 0.5])(
  "rejects invalid fixed spacing %s",
  (value) => {
    expect(() => createRemoteRequestPacing(value)).toThrow(
      "c01_invalid_request_start_interval",
    );
  },
);

it.each([429, 503])(
  "strict no-retry consumes the first %s body and diagnostic headers once without backoff",
  async (status) => {
    const body = JSON.stringify({
      success: false,
      errors: [{ code: 7500, message: "resource window" }],
    });
    const attempts: RemoteHttpAttempt[] = [];
    const metas: RemoteStatementMeta[] = [];
    const response = new Response(body, {
      status,
      headers: {
        "Retry-After": "10",
        "CF-Ray": "test-ray",
        Authorization: "not-recorded",
      },
    });
    const read = vi.spyOn(response, "text");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(result());
    vi.stubGlobal("fetch", fetch);
    const db = createRemoteD1Database({
      accountId: "test",
      databaseId: "test",
      token: "test-only",
      retryPolicy: "none",
      onHttpAttempt: (attempt) => attempts.push(attempt),
      onStatement: (meta) => metas.push(meta),
    });
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(
      "7500 resource window",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
    expect(metas).toHaveLength(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status,
      retry: false,
      backoffMs: 0,
      outcome: "response",
      responseBody: body,
      responseErrors: [{ code: 7500, message: "resource window" }],
      responseHeaders: { "retry-after": "10", "cf-ray": "test-ray" },
    });
    expect(JSON.stringify(attempts)).not.toContain("not-recorded");
  },
);

it("strict no-retry keeps a slow failed body in the shared queue then releases the next caller without a hidden retry", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const attempts: RemoteHttpAttempt[] = [];
  let consumed = false;
  const fetch = vi.fn(async () => {
    starts.push(performance.now());
    if (starts.length > 1) {
      expect(consumed).toBe(true);
      return result();
    }
    const response = new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 7500, message: "overload" }],
      }),
      { status: 429 },
    );
    const read = response.text.bind(response);
    response.text = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      consumed = true;
      return read();
    };
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    retryPolicy: "none",
    requestPacing: createRemoteRequestPacing(1000),
    onHttpAttempt: (attempt) => attempts.push(attempt),
  });
  const pending = Promise.allSettled([
    db.prepare("SELECT 1").all(),
    db.prepare("SELECT 1").all(),
  ]);
  await vi.runAllTimersAsync();
  expect((await pending).map((outcome) => outcome.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(starts).toEqual([0, 1500]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    attempts.map(({ attempt, retry, backoffMs }) => ({
      attempt,
      retry,
      backoffMs,
    })),
  ).toEqual([
    { attempt: 1, retry: false, backoffMs: 0 },
    { attempt: 1, retry: false, backoffMs: 0 },
  ]);
  expect(attempts[0]).toMatchObject({
    responseBodyElapsedMs: 1500,
    elapsedMs: 1500,
  });
});

it.each([429, 503, 200])(
  "strict no-retry preserves invalid JSON from status %s and never issues a second request",
  async (status) => {
    const attempts: RemoteHttpAttempt[] = [];
    const fetch = vi.fn().mockResolvedValue(
      new Response("invalid-json", {
        status,
        headers: { "CF-Ray": "invalid-json-ray" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const db = createRemoteD1Database({
      accountId: "test",
      databaseId: "test",
      token: "test-only",
      retryPolicy: "none",
      onHttpAttempt: (attempt) => attempts.push(attempt),
    });
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status,
      retry: false,
      backoffMs: 0,
      responseBody: "invalid-json",
      responseBodyError: { name: "SyntaxError" },
      responseHeaders: { "cf-ray": "invalid-json-ray" },
    });
  },
);

it.each([429, 503])(
  "strict no-retry rejects HTTP %s even when a malformed upstream envelope claims success",
  async (status) => {
    const attempts: RemoteHttpAttempt[] = [];
    const metas: RemoteStatementMeta[] = [];
    const payload = await result().text();
    const fetch = vi.fn().mockResolvedValue(new Response(payload, { status }));
    vi.stubGlobal("fetch", fetch);
    const db = createRemoteD1Database({
      accountId: "test",
      databaseId: "test",
      token: "test-only",
      retryPolicy: "none",
      onHttpAttempt: (attempt) => attempts.push(attempt),
      onStatement: (meta) => metas.push(meta),
    });
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(
      `d1_rest_error:${status}`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metas).toHaveLength(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status,
      retry: false,
      backoffMs: 0,
      responseBody: payload,
    });
  },
);
