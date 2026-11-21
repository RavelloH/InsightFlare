import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import {
  INV_COVERAGE_SHIFT,
  INV_FLAG_HANDLER_PRESENT,
  INV_FLAG_STATUS_PRESENT,
  INV_FLAG_WS_PRESENT,
  INVOCATION_METRICS_BLOBS,
  INVOCATION_METRICS_DATASET,
  INVOCATION_METRICS_DOUBLES,
  INVOCATION_METRICS_SCHEMA_VERSION,
  type InvocationMetricsPoint,
  readInvocationCoverageFlag,
} from "@/lib/edge/analytics-engine/invocation-schema";
import {
  v2BooleanFlag,
  v2CoverageFlag,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";
import {
  encodeInvocationMetricsPoint,
  encodeInvocationMetricsPointV2,
  registerInvocationMetrics,
} from "@/lib/edge/analytics-engine/invocation-writer";
import { getApiKeyByPrefix } from "@/lib/edge/auth/api-key-store";
import {
  type IngestFlushContext,
  resolveSitePk,
} from "@/lib/edge/ingest/flush-types";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  type InvocationLogger,
  type InvocationSource,
  type InvocationTrigger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { dispatchInternalPageRequest } from "@/lib/hono/internal-page-dispatch";
import { observabilityMiddleware } from "@/lib/hono/middleware/observability";
import type { AppEnv } from "@/lib/hono/types";

function fixture(
  source: InvocationSource = "worker",
  trigger: InvocationTrigger = "request",
) {
  const written: InvocationMetricsPoint[] = [];
  const waiting: Promise<unknown>[] = [];
  const writeDataPoint = vi.fn((point: InvocationMetricsPoint) => {
    written.push(point);
  });
  const env = {
    INVOCATION_METRICS: { writeDataPoint },
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
  } as Env;
  const logger = createInvocationLogger({
    source,
    trigger,
    waitUntil: (work) => waiting.push(work),
  });
  const emit = async () => {
    logger.emit();
    await Promise.all(waiting);
  };
  return { env, logger, written, writeDataPoint, waiting, emit };
}
function request(
  logger: InvocationLogger,
  status = 200,
  outcome: "ok" | "error" | "canceled" = "ok",
) {
  logger.setRequest({
    route: "/api/v1/account/private@example.com?token=never",
    method: "GET",
    status,
    outcome,
  });
}
describe("AE invocation recording v1 compatibility and v2 production", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("pins one new dataset and every physical schema slot without changing business datasets", () => {
    expect(INVOCATION_METRICS_DATASET).toBe("insightflare_invocation_metrics");
    expect(INVOCATION_METRICS_SCHEMA_VERSION).toBe(1);
    expect(INVOCATION_METRICS_BLOBS).toHaveLength(20);
    expect(INVOCATION_METRICS_DOUBLES).toHaveLength(20);
    expect(new Set(INVOCATION_METRICS_BLOBS).size).toBe(20);
    expect(new Set(INVOCATION_METRICS_DOUBLES).size).toBe(20);
    expect(INVOCATION_METRICS_BLOBS[18]).toBe("safeDetailsJson");
    expect(INVOCATION_METRICS_DOUBLES[18]).toBe("validityCoverageFlags");
    expect(INVOCATION_METRICS_DOUBLES[19]).toBe("schemaVersion");
    expect(Object.values(INV_COVERAGE_SHIFT)).toEqual([4, 6, 8, 10, 12, 14]);
  });

  it("registers a single completion consumer and emits one point despite repeated emit/register", async () => {
    const f = fixture();
    registerInvocationMetrics(f.env, f.logger);
    registerInvocationMetrics(f.env, f.logger);
    f.logger.setRouteKey("api:/api/v1/overview/:siteId");
    request(f.logger);
    f.logger.setPerformance({ cache: "HIT", dataSource: "rollup" });
    const first = f.logger.emit();
    expect(f.logger.emit()).toBe(first);
    await Promise.all(f.waiting);
    registerInvocationMetrics(f.env, f.logger);
    expect(f.writeDataPoint).toHaveBeenCalledOnce();
    const point = f.written[0];
    expect(point.indexes).toEqual(["api:/api/v1/overview/:siteId:ok"]);
    expect(point.blobs).toHaveLength(20);
    expect(point.doubles).toHaveLength(20);
    expect(point.blobs[7]).toBe("HIT");
    expect(point.blobs[8]).toBe("rollup");
    expect(point.blobs[9]).toMatch(
      /^(?:unknown|[0-9]+\.[0-9]+\.[0-9]+)(?:\+[0-9a-f]{12})?$/,
    );
    expect(point.doubles[19]).toBe(2);
    expect(point.doubles.every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
    expect(
      new TextEncoder().encode(point.indexes[0]).length,
    ).toBeLessThanOrEqual(96);
  });

  it("recognizes a trusted static build commit and rejects malformed deployment identifiers", () => {
    try {
      vi.stubEnv("VITE_APP_VERSION", "0.7.1");
      vi.stubEnv("VITE_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
      const f = fixture();
      expect(encodeInvocationMetricsPoint(f.logger.snapshot()).blobs[9]).toBe(
        "0.7.1+0123456789ab",
      );
      vi.stubEnv("VITE_COMMIT_SHA", "CANARY_private_email@example.com");
      expect(encodeInvocationMetricsPoint(f.logger.snapshot()).blobs[9]).toBe(
        "0.7.1",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves fractional SQL engine duration with distinct partial coverage flags", async () => {
    const f = fixture();
    const statement = {
      bind: vi.fn(),
      all: vi.fn(async () => ({
        results: [],
        meta: {
          rows_read: 0,
          total_attempts: 2,
          timings: { sql_duration_ms: 0.375 },
        },
      })),
    };
    const db = {
      prepare: vi.fn(() => statement),
    } as unknown as D1Database;
    f.env.DB = db;
    registerInvocationMetrics(f.env, f.logger);
    request(f.logger);
    const wrapped = instrumentEnv(f.env, f.logger);
    await wrapped.DB.prepare(
      "SELECT secret_column FROM private_table WHERE token=?",
    ).all();
    // This second result lacks meta, making all D1 metric coverages partial.
    statement.all.mockResolvedValueOnce({ results: [], meta: {} } as never);
    await wrapped.DB.prepare("SELECT 2").all();
    await f.emit();
    const point = f.written[0];
    expect(point.doubles[3]).toBe(2);
    expect(point.doubles[4]).toBe(0);
    expect(point.doubles[7]).toBe(0.375);
    expect(point.doubles[8]).toBeGreaterThanOrEqual(0);
    expect(point.doubles[9]).toBe(1);
    for (const key of ["d1RowsRead", "d1SqlEngine", "d1Attempts"] as const) {
      expect(v2CoverageFlag(point.doubles[18], key)).toBe("partial");
    }
    expect(point.blobs[11]).toBe("");
  });

  it("marks unavailable numbers explicitly; real observed zero is complete", async () => {
    const empty = fixture();
    registerInvocationMetrics(empty.env, empty.logger);
    request(empty.logger);
    await empty.emit();
    expect(empty.written[0].doubles[8]).toBe(0);
    expect(
      readInvocationCoverageFlag(empty.written[0].doubles[18], "rowsRead"),
    ).toBe("unavailable");
    expect(empty.written[0].doubles[18] & INV_FLAG_HANDLER_PRESENT).toBe(0);
    expect(empty.written[0].doubles[18] & INV_FLAG_STATUS_PRESENT).toBeTruthy();
    expect(empty.written[0].doubles[18] & INV_FLAG_WS_PRESENT).toBe(0);

    const complete = fixture();
    complete.logger.setPerformance({
      d1Statements: 1,
      d1RowsRead: 0,
      d1RowsReadCoverage: "complete",
      d1RowsWritten: 0,
      d1RowsWrittenCoverage: "complete",
      d1SqlDurationMs: 0.0125,
      d1SqlDurationCoverage: "complete",
      d1AttemptsCoverage: "complete",
      d1TotalAttempts: 1,
      d1Retries: 0,
    });
    const result = encodeInvocationMetricsPoint(complete.logger.snapshot());
    expect(result.doubles[10]).toBe(0.0125);
    expect(readInvocationCoverageFlag(result.doubles[18], "rowsRead")).toBe(
      "complete",
    );
    expect(readInvocationCoverageFlag(result.doubles[18], "rowsWritten")).toBe(
      "complete",
    );
  });

  it("records bounded API key lookup D1 meta and a trusted query template in one SQL call", async () => {
    const f = fixture();
    const row = {
      id: "key-1",
      team_id: "team-1",
      name: "Internal test",
      key_prefix: "safe-prefix",
      key_hash: "test-hash",
      scopes_json: "[]",
      site_ids_json: "[]",
      created_by_user_id: null,
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
    };
    const statement = {
      bind: vi.fn((..._bindings: unknown[]) => statement),
      all: vi.fn(async () => ({
        results: [row],
        meta: {
          rows_read: 7,
          rows_written: 0,
          total_attempts: 1,
          timings: { sql_duration_ms: 0.375 },
        },
      })),
      first: vi.fn(async () => row),
    };
    const prepare = vi.fn(() => statement);
    f.env.DB = { prepare } as unknown as D1Database;
    registerInvocationMetrics(f.env, f.logger);
    const found = await getApiKeyByPrefix(
      instrumentEnv(f.env, f.logger),
      "safe-prefix",
    );
    expect(found?.id).toBe(row.id);
    expect(prepare).toHaveBeenCalledOnce();
    expect(statement.all).toHaveBeenCalledOnce();
    expect(statement.first).not.toHaveBeenCalled();
    await f.emit();
    expect(f.written).toHaveLength(1);
    const point = f.written[0];
    expect(point.doubles[3]).toBe(1);
    expect(point.doubles[5]).toBe(7);
    expect(point.doubles[6]).toBe(0);
    expect(v2CoverageFlag(point.doubles[18], "d1RowsRead")).toBe("complete");
    expect(v2CoverageFlag(point.doubles[18], "d1RowsWritten")).toBe("complete");
    const detail = JSON.parse(point.blobs[18]) as {
      queries: Array<{ id: string; granularity: string }>;
      coverage: { unknownStatements: number };
    };
    expect(detail.queries[0]?.id).toBe("auth.api_keys.lookup_by_prefix");
    expect(detail.queries[0]?.granularity).toBe("sql-template");
    expect(detail.coverage.unknownStatements).toBe(0);
  });

  it("resolves DO site identities with D1 meta, without a second lookup", async () => {
    const f = fixture("do", "alarm");
    const statement = {
      bind: vi.fn((..._bindings: unknown[]) => statement),
      all: vi.fn(async () => ({
        results: [{ sitePk: 12 }],
        meta: {
          rows_read: 3,
          rows_written: 0,
          total_attempts: 1,
          timings: { sql_duration_ms: 0.12 },
        },
      })),
    };
    const prepare = vi.fn(() => statement);
    f.env.DB = { prepare } as unknown as D1Database;
    registerInvocationMetrics(f.env, f.logger);
    const context = {
      env: instrumentEnv(f.env, f.logger),
      sitePks: new Map<string, number>(),
    } as unknown as IngestFlushContext;
    expect(await resolveSitePk(context, "site-1")).toBe(12);
    expect(await resolveSitePk(context, "site-1")).toBe(12);
    expect(prepare).toHaveBeenCalledOnce();
    await f.emit();
    const point = f.written[0];
    expect(point.doubles[3]).toBe(1);
    expect(point.doubles[5]).toBe(3);
    expect(v2CoverageFlag(point.doubles[18], "d1RowsRead")).toBe("complete");
    const detail = JSON.parse(point.blobs[18]) as {
      queries: Array<{ id: string }>;
    };
    expect(detail.queries[0]?.id).toBe("ingest.site_identities.lookup");
  });

  it("distinguishes complete ranking from omitted query detail and unknown read coverage", () => {
    const f = fixture();
    const collector = new HotspotCollector();
    const ids = [
      "auth.api_keys.lookup_by_prefix",
      "auth.api_keys.lookup_by_id",
      "ingest.site_identities.lookup",
      "ingest.site_identities.insert",
      "ingest.dictionary.name.lookup",
      "ingest.dictionary.name.upsert",
      "ingest.dictionary.key.lookup",
      "ingest.dictionary.key.upsert",
    ];
    ids.forEach((id, index) =>
      collector.record({
        identity: { id, variant: "raw.unfiltered" },
        apiWallMs: index + 1,
        rowsRead: index + 2,
        rowsWritten: 0,
        sqlEngineMs: 0.25,
        attempts: 1,
      }),
    );
    const point = encodeInvocationMetricsPointV2(
      f.logger.snapshot(),
      collector.snapshot(),
    );
    const detail = JSON.parse(point.blobs[18]) as {
      rankingCoverage: string;
      queries: Array<{ id: string }>;
      coverage: {
        queryDetails: string;
        rowsReadObservedStatements: number;
        rowsWrittenObservedStatements: number;
        unknownStatements: number;
      };
      truncation: { queriesDropped: number };
    };
    expect(detail.rankingCoverage).toBe("complete");
    expect(detail.coverage.queryDetails).toBe("partial");
    expect(detail.queries).toHaveLength(6);
    expect(detail.truncation.queriesDropped).toBe(2);
    expect(detail.coverage.rowsReadObservedStatements).toBe(8);
    expect(detail.coverage.rowsWrittenObservedStatements).toBe(8);
    expect(detail.coverage.unknownStatements).toBe(0);
    expect(v2BooleanFlag(point.doubles[18], "detailsTruncated")).toBe(true);

    const missing = new HotspotCollector();
    missing.record({ identity: undefined });
    const unknown = encodeInvocationMetricsPointV2(
      f.logger.snapshot(),
      missing.snapshot(),
    );
    const unknownDetails = JSON.parse(unknown.blobs[18]) as {
      rankingCoverage: string;
      coverage: {
        unknownStatements: number;
        rowsReadObservedStatements: number;
      };
    };
    expect(unknownDetails.rankingCoverage).toBe("incomparable");
    expect(unknownDetails.coverage.unknownStatements).toBe(1);
    expect(unknownDetails.coverage.rowsReadObservedStatements).toBe(0);
    expect(v2BooleanFlag(unknown.doubles[18], "scanQueryPresent")).toBe(false);
  });

  it("keeps HTTP 200 internal D1 failure and multiple errors on a single point", async () => {
    const f = fixture();
    registerInvocationMetrics(f.env, f.logger);
    request(f.logger, 200, "ok");
    f.logger.increment("d1Statements", 2);
    f.logger.increment("failedStatements", 2);
    f.logger.error("d1.all.failed", { errorMessage: "secret" });
    f.logger.error("d1.run.failed", { errorStack: "secret" });
    f.logger.error("request.unhandled_error");
    await f.emit();
    expect(f.writeDataPoint).toHaveBeenCalledOnce();
    const point = f.written[0];
    expect(point.blobs[5]).toBe("failure");
    expect(point.blobs[10]).toBe("database");
    expect(point.blobs[11]).toBe("d1_operation_failed");
    expect(JSON.parse(point.blobs[18]).signals).toContainEqual({
      code: "unhandled_request",
      category: "application",
    });
    expect(JSON.parse(point.blobs[18]).resources.errorEvents).toBe(3);
    expect(point.doubles[17]).toBe(200);
    expect(point.indexes[0]).toBe("api.other:failure");
  });

  it.each([
    [
      "do.websocket.snapshot_failed",
      101,
      "websocket_snapshot_failed",
      "do.websocket.initial_snapshot",
    ],
    [
      "do.flush.visit_batch_failed",
      200,
      "do_flush_visit_batch_failed",
      "do.flush.visit_batch",
    ],
    ["do.flush.visit_failed", 200, "do_flush_visit_failed", "do.flush.visit"],
    [
      "do.flush.custom_event_failed",
      200,
      "do_flush_custom_event_failed",
      "do.flush.custom_event",
    ],
    [
      "query.application-operation.failed",
      200,
      "query_application_failed",
      "query.application",
    ],
  ] as const)(
    "classifies caught internal event %s despite successful HTTP status",
    async (event, status, code, operation) => {
      const f = fixture();
      registerInvocationMetrics(f.env, f.logger);
      request(f.logger, status, "ok");
      f.logger.error(event, {
        errorMessage: "CANARY_private@example.com",
        errorStack: "CANARY_stack_secret",
        operation: "CANARY_attacker_operation",
      });
      await f.emit();
      expect(f.written).toHaveLength(1);
      const point = f.written[0];
      expect(point.indexes[0]).toBe("api.other:failure");
      expect(point.blobs[11]).toBe(code);
      expect(point.blobs[12]).toBe(operation);
      expect(point.doubles[17]).toBe(status);
      expect(JSON.stringify(point)).not.toContain("CANARY");
    },
  );

  it("uses a bounded unknown-error classification only for logged successful invocations", async () => {
    const success = fixture();
    registerInvocationMetrics(success.env, success.logger);
    request(success.logger, 200, "ok");
    success.logger.error("application.some_unmapped_failure", {
      errorMessage: "CANARY_unknown_secret",
    });
    await success.emit();
    expect(success.written[0].indexes).toEqual(["api.other:failure"]);
    expect(success.written[0].blobs[10]).toBe("unknown");
    expect(success.written[0].blobs[11]).toBe("unclassified_logged_error");
    expect(JSON.stringify(success.written[0])).not.toContain("CANARY");

    const client = fixture();
    registerInvocationMetrics(client.env, client.logger);
    request(client.logger, 403, "error");
    client.logger.error("application.expected_failure");
    await client.emit();
    expect(client.written[0].indexes).toEqual(["api.other:client_error"]);
    expect(client.written[0].blobs[11]).toBe("");
  });

  it("never reports normal 4xx or warnings as a server error", async () => {
    const f = fixture();
    registerInvocationMetrics(f.env, f.logger);
    request(f.logger, 403, "error");
    f.logger.warn("permission.denied", { details: "private@example.com" });
    await f.emit();
    const point = f.written[0];
    expect(point.blobs[5]).toBe("client_error");
    expect(point.blobs[10]).toBe("");
    expect(point.blobs[11]).toBe("");
    expect(JSON.parse(point.blobs[18]).resources.errorEvents).toBe(0);
    expect(point.indexes[0]).toBe("api.other:client_error");
  });

  it("records fixed DO Alarm / WS / Scheduled entry classes and duration presence", async () => {
    const alarm = fixture("do", "alarm");
    registerInvocationMetrics(alarm.env, alarm.logger);
    alarm.logger.setRouteKey("do.alarm");
    alarm.logger.error("do.alarm.failed");
    await alarm.emit();
    expect(alarm.written[0].indexes[0]).toBe("do.alarm:failure");
    expect(alarm.written[0].blobs[11]).toBe("do_alarm_failed");
    const ws = fixture("do", "websocket");
    registerInvocationMetrics(ws.env, ws.logger);
    ws.logger.setRouteKey("do.websocket");
    ws.logger.setRequest({
      route: "/ws",
      method: "WEBSOCKET",
      status: 101,
      outcome: "ok",
    });
    ws.logger.setPerformance({ webSocketDurationMs: 123.5 });
    await ws.emit();
    expect(JSON.parse(ws.written[0].blobs[18]).resources.wsLifetimeMs).toBe(
      123.5,
    );
    expect(ws.written[0].doubles[2]).toBe(0);
    expect(
      v2BooleanFlag(ws.written[0].doubles[18], "backgroundDrainPresent"),
    ).toBe(false);
    const scheduled = fixture("worker", "scheduled");
    registerInvocationMetrics(scheduled.env, scheduled.logger);
    scheduled.logger.setRouteKey("scheduled.tasks");
    await scheduled.emit();
    expect(scheduled.written[0].indexes[0]).toBe("scheduled.tasks:ok");
    expect(scheduled.written[0].doubles[17]).toBe(0);
    expect(
      v2BooleanFlag(scheduled.written[0].doubles[18], "httpStatusPresent"),
    ).toBe(false);
  });

  it("skips unbound/disabled and isolates failing AE binding even on rethrown alarm", async () => {
    const disabled = fixture();
    registerInvocationMetrics(
      { ...disabled.env, INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "1" },
      disabled.logger,
    );
    await disabled.emit();
    expect(disabled.writeDataPoint).not.toHaveBeenCalled();
    const missing = fixture();
    registerInvocationMetrics(
      { ...missing.env, INVOCATION_METRICS: undefined },
      missing.logger,
    );
    await missing.emit();
    expect(missing.writeDataPoint).not.toHaveBeenCalled();
    const broken = fixture("do", "alarm");
    broken.writeDataPoint.mockImplementation(() => {
      throw new Error("AE unavailable");
    });
    registerInvocationMetrics(broken.env, broken.logger);
    const original = new Error("alarm retry necessary");
    async function alarm(): Promise<void> {
      try {
        throw original;
      } catch (err) {
        broken.logger.error("do.alarm.failed");
        throw err;
      } finally {
        broken.logger.emit();
      }
    }
    await expect(alarm()).rejects.toBe(original);
    await Promise.all(broken.waiting);
    expect(broken.writeDataPoint).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("never serializes private URL, SQL, parameters, raw error messages or stack canaries", async () => {
    const f = fixture();
    const secret =
      "CANARY_private@example.com_203.0.113.55_sql_PASSWORD_token123";
    registerInvocationMetrics(f.env, f.logger);
    f.logger.setRouteKey(`api:/${secret}`);
    f.logger.setRequest({
      route: `/api/user/${secret}?key=${secret}`,
      method: secret,
      status: 500,
      outcome: "error",
    });
    f.logger.info("request.details", { query: secret, userAgent: secret });
    f.logger.error("request.unhandled_error", {
      errorMessage: secret,
      errorStack: secret,
    });
    f.logger.startSpan(`custom.${secret}`).end();
    f.logger.recordD1Operation(`custom.${secret}`, {
      durationMs: 1,
      rowsReadAvailable: false,
    });
    await f.emit();
    const point = f.written[0];
    expect(JSON.stringify(point)).not.toContain(secret);
    expect(point.blobs[3]).toBe("api.other");
    // The existing safe snapshot may omit an untrusted method entirely.
    expect(point.blobs[4]).toBe("");
    expect(point.blobs[18].length).toBeLessThanOrEqual(4096);
    expect(
      new TextEncoder().encode(point.blobs[18]).length,
    ).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(point.blobs[18]) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "coverage",
      "hotBasis",
      "phases",
      "queries",
      "rankingCoverage",
      "resources",
      "signals",
      "truncation",
      "v",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("errorMessage");
    expect(JSON.stringify(parsed)).not.toContain("errorStack");
    expect(
      point.blobs.reduce(
        (bytes, item) => bytes + new TextEncoder().encode(item).length,
        0,
      ),
    ).toBeLessThanOrEqual(16_384);
  });

  it("bounds operation arrays, JSON depth and drops unknown operation names", () => {
    const f = fixture();
    for (const name of [
      "d1.all",
      "d1.first",
      "d1.run",
      "d1.raw",
      "d1.exec",
      "d1.batch",
      "do.schema_ready",
      "do.maintenance",
      "page.handler",
      "route.handler",
    ]) {
      f.logger.startSpan(name).end();
    }
    f.logger.startSpan("custom.private_sql_column").end();
    const point = encodeInvocationMetricsPoint(f.logger.snapshot());
    const details = JSON.parse(point.blobs[18]) as {
      ops: Array<{ key: string }>;
      truncated: boolean;
    };
    expect(details.ops).toHaveLength(8);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain("custom.private_sql_column");
    expect(
      new TextEncoder().encode(point.blobs[18]).length,
    ).toBeLessThanOrEqual(4096);
  });
});

describe("Hono real middleware invocation integration", () => {
  it("records forged external headers yet skips only code-owned page forwarding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const points: InvocationMetricsPoint[] = [];
    const pending: Promise<unknown>[] = [];
    const env = {
      INVOCATION_METRICS: {
        writeDataPoint: (point: InvocationMetricsPoint) => points.push(point),
      },
      DB: {} as D1Database,
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env;
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const app = new Hono<AppEnv>();
    app.use("*", observabilityMiddleware());
    app.get("/api/sites/:siteId", (c) => c.text("ok"));

    const response = await app.fetch(
      new Request("https://internal.test/api/sites/private-uuid"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await Promise.all(pending);
    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["api:/api/sites/:siteId:ok"]);
    expect(JSON.stringify(points[0])).not.toContain("private-uuid");

    // An external client cannot forge the trusted in-memory Request identity.
    const forged = await app.fetch(
      new Request("https://internal.test/api/sites/private-uuid", {
        headers: { "x-insightflare-internal-page-request": "1" },
      }),
      env,
      ctx,
    );
    expect(forged.status).toBe(200);
    await Promise.all(pending);
    expect(points).toHaveLength(2);
    expect(points[1].indexes).toEqual(["api:/api/sites/:siteId:ok"]);

    let internalRequest: Request | undefined;
    const internal = await dispatchInternalPageRequest(
      new Request("https://internal.test/api/sites/private-uuid"),
      (trustedRequest) => {
        internalRequest = trustedRequest;
        return app.fetch(trustedRequest, env, ctx);
      },
    );
    expect(internal.status).toBe(200);
    await Promise.all(pending);
    expect(points).toHaveLength(2);

    // Trust expires as soon as that internal dispatch has completed.
    expect(internalRequest).toBeDefined();
    const reused = await app.fetch(internalRequest!, env, ctx);
    expect(reused.status).toBe(200);
    await Promise.all(pending);
    expect(points).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it("classifies a real Hono 200 response with caught D1 failure as a single database failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const points: InvocationMetricsPoint[] = [];
    const pending: Promise<unknown>[] = [];
    const sqlError = new Error("CANARY_private_sql_and_token");
    const statement = {
      all: vi.fn(async () => {
        throw sqlError;
      }),
    };
    const env = {
      INVOCATION_METRICS: {
        writeDataPoint: (point: InvocationMetricsPoint) => points.push(point),
      },
      DB: { prepare: vi.fn(() => statement) } as unknown as D1Database,
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env;
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const app = new Hono<AppEnv>();
    app.use("*", observabilityMiddleware());
    app.get("/api/metrics/:metricId", async (c) => {
      try {
        await c.env.DB.prepare("SELECT private_data WHERE password = ?").all();
      } catch {
        // Application-level fallback intentionally responds with HTTP 200.
      }
      return c.text("fallback");
    });
    const response = await app.fetch(
      new Request("https://internal.test/api/metrics/secret-id"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fallback");
    await Promise.all(pending);
    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["api:/api/metrics/:metricId:failure"]);
    expect(points[0].blobs[11]).toBe("d1_operation_failed");
    expect(points[0].doubles[3]).toBe(1);
    expect(points[0].doubles[4]).toBe(1);
    expect(points[0].doubles[17]).toBe(200);
    expect(JSON.stringify(points[0])).not.toContain(
      "CANARY_private_sql_and_token",
    );
    expect(JSON.stringify(points[0])).not.toContain("secret-id");
    vi.restoreAllMocks();
  });
});
