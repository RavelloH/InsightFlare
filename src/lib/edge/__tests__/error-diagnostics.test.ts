import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeInvocationView } from "@/lib/edge/admin/observability/invocation-metrics-model";
import { currentHotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import type { InvocationMetricsPoint } from "@/lib/edge/analytics-engine/invocation-schema";
import { registerInvocationMetrics } from "@/lib/edge/analytics-engine/invocation-writer";
import {
  appendErrorDiagnostic,
  captureErrorDiagnostic,
  decodeErrorDiagnostics,
  type ErrorDiagnostics,
} from "@/lib/edge/observability/error-diagnostics";
import {
  createInvocationLogger,
  errorLogData,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const diagnosticId = "00000000-0000-4000-8000-000000000001";
const secret = "CANARY_secret@example.com_TOKEN_123";
const queryId = "analytics.overview.raw.summary";
const d1 = {
  category: "database",
  code: "d1_operation_failed",
  operation: "d1.all",
};
const ae = {
  category: "application",
  code: "ae_reader_invalid_query",
  operation: "ae.reader.sql",
};
function state(): ErrorDiagnostics {
  return { version: 1, diagnosticId, errors: [], dropped: 0 };
}
function fixture() {
  const points: InvocationMetricsPoint[] = [];
  const pending: Promise<unknown>[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
    waitUntil: (work) => pending.push(work),
  });
  const env = {
    INVOCATION_METRICS: {
      writeDataPoint: (point: InvocationMetricsPoint) => {
        points.push(point);
      },
    },
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
  } as Env;
  registerInvocationMetrics(env, logger);
  logger.setRouteKey("api:/collect");
  return {
    logger,
    points,
    async emit() {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const record = logger.emit();
      await Promise.all(pending);
      return { record, point: points[0]! };
    },
  };
}
function readPoint(point: InvocationMetricsPoint) {
  const [b, n] = [point.blobs, point.doubles];
  return normalizeInvocationView("samples", {
    samples: [
      {
        source: b[0],
        trigger: b[1],
        routeKey: b[3],
        appVersion: b[9],
        resultClass: b[5],
        category: b[10],
        code: b[11],
        operation: b[12],
        hotQueryId: b[13],
        variant: b[14],
        filterShape: b[15],
        scanQueryId: b[16],
        dominantPhase: b[17],
        details: b[18],
        filterFamily: b[19],
        timestampSeconds: 1790000000,
        sampleInterval: 1,
        invocationWallMs: n[0],
        handlerWallMs: n[1],
        httpStatus: n[17],
        flags: n[18],
      },
    ],
  }).data.samples[0]!;
}
afterEach(() => vi.restoreAllMocks());

describe("safe invocation error diagnostics", () => {
  it("correlates a real logger error with one AE point and retains only safe error facts", async () => {
    const { logger, emit, points } = fixture();
    const cause = new Error("network error: " + secret, {
      cause: new Error("operation timeout: " + secret),
    });
    const error = new TypeError("no such column: " + secret, { cause });
    error.stack =
      "TypeError: " +
      secret +
      "\n    at leakedFunction (C:/private/" +
      secret +
      "/src/lib/edge/observability/bindings.ts:291:17)" +
      "\n    at unsafe (https://example.com/" +
      secret +
      "/worker.js:8:9)" +
      "\n    at unknown (private-" +
      secret +
      ".js:1:2)";
    const data = {
      ...errorLogData(error),
      queryId,
      variant: "raw.filtered",
      statementCount: 1,
    };
    logger.error("d1.all.failed", data);
    logger.error("d1.all.failed", data);
    expect(logger.snapshot().errorDiagnostics).toBeUndefined();
    expect(
      logger.snapshot({ includeErrorDiagnostics: true }).errorDiagnostics
        ?.errors[0]?.count,
    ).toBe(2);

    const { point, record } = await emit();
    expect(points).toHaveLength(1);
    expect(record.logs[0]?.data?.errorMessage).toContain(secret);
    const details = JSON.parse(point.blobs[18]);
    expect(details.errorDiagnostics.diagnosticId).toBe(record.diagnosticId);
    expect(details.errorDiagnostics.errors[0]).toMatchObject({
      code: "d1_operation_failed",
      name: "TypeError",
      message: "Missing database column",
      stack: [
        {
          file: "src/lib/edge/observability/bindings.ts",
          line: 291,
          column: 17,
        },
      ],
      causes: ["Connection or network failure", "Operation timed out"],
      context: { queryId, variant: "raw.filtered", statementCount: 1 },
      count: 2,
      messageRedacted: true,
    });
    expect(JSON.stringify(point)).not.toContain(secret);
    expect(JSON.stringify(point)).not.toContain("leakedFunction");
    expect(readPoint(point).details?.errorDiagnostics).toEqual(
      details.errorDiagnostics,
    );
    expect(point.blobs).toHaveLength(20);
    expect(point.doubles[19]).toBe(2);
  });

  it("keeps ordinary snapshots unchanged and correlates unclassified 5xx responses", async () => {
    const first = fixture();
    const normal = await first.emit();
    expect(normal.record.diagnosticId).toBeUndefined();
    expect(JSON.parse(normal.point.blobs[18]).errorDiagnostics).toBeUndefined();
    expect(
      new TextEncoder().encode(normal.point.blobs[18]).length,
    ).toBeLessThanOrEqual(4096);
    const second = fixture();
    second.logger.setRequest({
      route: "/api/collect",
      method: "GET",
      status: 500,
      outcome: "error",
    });
    const failed = await second.emit();
    expect(failed.record.diagnosticId).toBeTruthy();
    expect(JSON.parse(failed.point.blobs[18]).errorDiagnostics).toMatchObject({
      diagnosticId: failed.record.diagnosticId,
      errors: [],
      dropped: 0,
    });
  });

  it("retains controlled AE reader diagnostics without raw provider response bodies", () => {
    const item = captureErrorDiagnostic(ae, {
      view: "overview",
      statement: "summary",
      providerStatus: 400,
      reason: "invalid_column",
      errorCode: "invalid_query",
      retryable: false,
      durationMs: 17,
      response: secret,
      errorMessage: secret,
      errorName: secret,
    });
    expect(item).toMatchObject({
      code: ae.code,
      name: "Unknown",
      message: null,
      context: {
        view: "overview",
        statement: "summary",
        providerStatus: 400,
        reason: "invalid_column",
        errorCode: "invalid_query",
        retryable: false,
        durationMs: 17,
      },
    });
    expect(JSON.stringify(item)).not.toContain(secret);
    const invalid = captureErrorDiagnostic(ae, {
      view: secret,
      statement: secret,
      reason: secret,
      errorCode: secret,
      providerStatus: 999,
      retryable: secret,
      durationMs: -1,
    });
    expect(invalid.context).toEqual({});
    expect(
      captureErrorDiagnostic(d1, {
        queryId: secret,
        variant: "raw.filtered",
        statementCount: -1,
      }).context,
    ).toEqual({});
  });

  it.each([
    ["no such table: " + secret, "Missing database table"],
    ["UNIQUE constraint failed: " + secret, "Database constraint violation"],
    ["deadline exceeded: " + secret, "Operation timed out"],
    ["too many terms in compound SELECT " + secret, "Resource limit exceeded"],
    ["database is locked " + secret, "Database busy or locked"],
    ["fetch failed " + secret, "Connection or network failure"],
    ["Cannot read properties of " + secret, "Invalid property access"],
    ["operation aborted " + secret, "Operation aborted"],
    ["syntax error near " + secret, "SQL syntax error"],
    [secret, null],
  ])("projects error messages to finite categories", (raw, expected) => {
    const value = captureErrorDiagnostic(undefined, { errorMessage: raw });
    expect(value.message).toBe(expected);
    expect(value.code).toBe("unclassified_logged_error");
    expect(JSON.stringify(value)).not.toContain(secret);
  });

  it("bounds distinct errors and preserves trusted failures instead of unknown noise", () => {
    const value = state();
    appendErrorDiagnostic(
      value,
      captureErrorDiagnostic(undefined, { errorMessage: "timeout" }),
    );
    appendErrorDiagnostic(
      value,
      captureErrorDiagnostic(undefined, { errorMessage: "fetch failed" }),
    );
    appendErrorDiagnostic(
      value,
      captureErrorDiagnostic(undefined, { errorMessage: "no such table" }),
    );
    appendErrorDiagnostic(
      value,
      captureErrorDiagnostic(d1, { errorMessage: "no such column" }),
    );
    expect(value.errors).toHaveLength(3);
    expect(value.errors.some((error) => error.code === d1.code)).toBe(true);
    expect(value.dropped).toBe(1);
    appendErrorDiagnostic(
      value,
      captureErrorDiagnostic(undefined, { errorMessage: "abort" }),
    );
    expect(value.dropped).toBe(2);
  });

  it("revalidates malformed AE JSON and recomputes fingerprints from safe facts", () => {
    for (const malformed of [
      null,
      [],
      { version: 2 },
      { ...state(), diagnosticId: secret },
      { ...state(), dropped: -1 },
      { ...state(), errors: Array(4).fill(null) },
    ]) {
      expect(decodeErrorDiagnostics(malformed)).toBeNull();
    }
    const captured = captureErrorDiagnostic(d1, {
      errorMessage: "no such column",
      errorStack:
        "Error\n at fn (worker.js:1:2)\n at f (worker.js:0:2)\n at f (worker.js:2:0)",
      queryId,
      variant: "raw.filtered",
      statementCount: 1,
    });
    const malicious = {
      ...captured,
      fingerprint: secret,
      message: secret,
      operation: secret,
      causes: [secret, "Operation timed out"],
      stack: [
        ...captured.stack,
        { file: secret, line: 1, column: 2 },
        { file: "worker.js", line: -1, column: 2 },
        null,
      ],
      context: {
        queryId: secret,
        variant: secret,
        statementCount: 0,
        token: secret,
      },
      privatePayload: secret,
    };
    const decoded = decodeErrorDiagnostics({
      ...state(),
      errors: [malicious, null, { ...captured, count: 0 }],
    })!;
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]).toMatchObject({
      message: null,
      operation: null,
      causes: ["Operation timed out"],
      stack: [{ file: "worker.js", line: 1, column: 2 }],
      context: {},
    });
    expect(JSON.stringify(decoded)).not.toContain(secret);
    expect(decoded.errors[0]?.fingerprint).not.toBe(captured.fingerprint);
  });

  it("keeps the AE budget and correlation even when error events are dropped from Workers Logs", async () => {
    const { logger, emit } = fixture();
    const stack =
      "Error\n" +
      Array.from(
        { length: 20 },
        (_, i) =>
          "    at fn (src/lib/edge/admin/observability/invocation-metrics-transport.ts:" +
          (i + 1) +
          ":2)",
      ).join("\n");
    for (let i = 0; i < 40; i++) {
      logger.error("d1.all.failed", {
        errorName: "Error",
        errorMessage: i % 2 ? "timeout" : "no such table",
        errorStack: stack,
        errorCause: secret,
        queryId,
        variant: "raw.filtered",
      });
    }
    const collector = currentHotspotCollector(logger)!;
    for (const id of [
      "analytics.overview.raw.summary",
      "analytics.trend.raw.series",
      "analytics.overview.raw.latest_activity",
      "analytics.rollup.aggregation_state",
      "analytics.rollup.visit_details",
      "analytics.rollup.hourly_rows",
    ]) {
      collector.record({
        identity: { id, variant: "raw.unfiltered" },
        apiWallMs: 15,
        rowsRead: 100,
        rowsWritten: 0,
        sqlEngineMs: 10,
        attempts: 1,
      });
    }
    logger.error("d1.all.failed", {
      errorName: "Error",
      errorMessage: "no such column",
      errorStack: stack,
      queryId,
      variant: "raw.filtered",
    });
    const { point, record } = await emit();
    const details = JSON.parse(point.blobs[18]);
    expect(details.errorDiagnostics.diagnosticId).toBe(record.diagnosticId);
    expect(details.errorDiagnostics.errors).toHaveLength(3);
    expect(new TextEncoder().encode(point.blobs[18]).length).toBeGreaterThan(
      4096,
    );
    expect(readPoint(point).details?.errorDiagnostics?.errors).toHaveLength(3);
    expect(details.errorDiagnostics.errors[0].stack).toHaveLength(8);
    expect(details.errorDiagnostics.errors[0].count).toBe(20);
    expect(
      new TextEncoder().encode(point.blobs[18]).length,
    ).toBeLessThanOrEqual(8192);
    expect(
      point.blobs.reduce(
        (sum, blob) => sum + new TextEncoder().encode(blob).length,
        0,
      ),
    ).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(point)).not.toContain(secret);
  });
});
