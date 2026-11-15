// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import {
  createRemoteD1Database,
  type RemoteHttpAttempt,
  type RemoteStatementMeta,
} from "./remote-d1-database";

const options = {
  accountId: "test",
  databaseId: "test",
  token: "private-test-secret",
};
const response = (meta: Record<string, unknown>, status = 200) =>
  new Response(
    JSON.stringify({
      success: true,
      result: [{ results: [{ value: 1 }], meta }],
    }),
    { status },
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("preserves duration provenance, raw values, serving metadata and ordinals", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      response({
        rows_read: 3,
        rows_written: 0,
        timings: { sql_duration_ms: 1.25 },
        duration: 2,
        served_by: "worker",
        served_by_region: "WNAM",
      }),
    ),
  );
  const metas: RemoteStatementMeta[] = [];
  const db = createRemoteD1Database({
    ...options,
    onStatement: (meta) => metas.push(meta),
  });
  await db.prepare("SELECT ?").bind(1).all();
  await db.prepare("SELECT 2").all();
  expect(metas.map((meta) => meta.statementOrdinal)).toEqual([1, 2]);
  expect(metas[0]).toMatchObject({
    sqlDurationMs: 1.25,
    sqlDurationSource: "timings.sql_duration_ms",
    durationRaw: { timingsSqlDurationMs: 1.25, duration: 2 },
    servedBy: "worker",
    servedByRegion: "WNAM",
  });
  expect(JSON.stringify(metas)).not.toContain(options.token);
  expect(JSON.stringify(metas)).not.toContain("Authorization");
});

it("explicitly identifies duration fallback and unknown serving metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response({ rows_read: 1, rows_written: 0, duration: 4 }),
      ),
  );
  const metas: RemoteStatementMeta[] = [];
  await createRemoteD1Database({
    ...options,
    onStatement: (meta) => metas.push(meta),
  })
    .prepare("SELECT 1")
    .all();
  expect(metas[0]).toMatchObject({
    sqlDurationMs: 4,
    sqlDurationSource: "duration",
    durationRaw: { timingsSqlDurationMs: null, duration: 4 },
    servedBy: null,
    servedByRegion: null,
  });
});

it("records bounded retry status and backoff separately from SQL duration", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(
        response({ rows_read: 1, rows_written: 0, duration: 7 }),
      ),
  );
  const attempts: RemoteHttpAttempt[] = [];
  const metas: RemoteStatementMeta[] = [];
  const pending = createRemoteD1Database({
    ...options,
    onHttpAttempt: (attempt) => attempts.push(attempt),
    onStatement: (meta) => metas.push(meta),
  })
    .prepare("SELECT 1")
    .all();
  await vi.runAllTimersAsync();
  await pending;
  expect(
    attempts.map(({ attempt, status, retry, backoffMs }) => ({
      attempt,
      status,
      retry,
      backoffMs,
    })),
  ).toEqual([
    { attempt: 1, status: 503, retry: true, backoffMs: 500 },
    { attempt: 2, status: 200, retry: false, backoffMs: 0 },
  ]);
  expect(metas[0]?.sqlDurationMs).toBe(7);
  expect(metas[0]?.httpAttempts).toEqual(attempts);
});

it("reports a transport failure without success metadata or credential logging", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const attempts: RemoteHttpAttempt[] = [];
  const onStatement = vi.fn();
  await expect(
    createRemoteD1Database({
      ...options,
      onHttpAttempt: (attempt) => attempts.push(attempt),
      onStatement,
    })
      .prepare("SELECT 1")
      .all(),
  ).rejects.toThrow("offline");
  expect(attempts[0]).toMatchObject({
    status: null,
    retry: false,
    backoffMs: 0,
    outcome: "transport-error",
  });
  expect(onStatement).not.toHaveBeenCalled();
  expect(JSON.stringify(attempts)).not.toContain(options.token);
});

it.each([-1, "unknown"])(
  "rejects invalid raw duration %s instead of serializing or accepting it",
  async (duration) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ rows_read: 1, rows_written: 0, duration }),
        ),
    );
    await expect(
      createRemoteD1Database(options).prepare("SELECT 1").all(),
    ).rejects.toThrow("metric_unavailable");
  },
);
