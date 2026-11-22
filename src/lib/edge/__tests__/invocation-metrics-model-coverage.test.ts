import { describe, expect, it } from "vitest";

import { normalizeInvocationView } from "@/lib/edge/admin/observability/invocation-metrics-model";

const dimensions = {
  source: "worker",
  trigger: "request",
  routeKey: "api:/collect",
  appVersion: "1.2.3",
} as const;
const queryId = "analytics.overview.raw.summary";
const coverageNames = [
  "d1RowsRead",
  "d1SqlEngineMs",
  "d1ApiWallMs",
  "doFetchWallMs",
  "doSqlRowsRead",
] as const;
const zeroCoverage = Object.fromEntries(
  coverageNames.flatMap((name) =>
    ["Applicable", "Complete", "Partial", "Observed"].map((suffix) => [
      name + suffix,
      0,
    ]),
  ),
);

function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    retainedSamples: 2,
    estimatedInvocations: 9,
    maxSampleInterval: 8,
    handlerWeight: 5,
    p50: 0,
    p95: 11,
    p99: 30,
    invocationWallMs: 25,
    workerD1Statements: 2,
    doFetchCalls: 1,
    ...zeroCoverage,
    ...overrides,
  };
}

function sampleRow(overrides: Record<string, unknown> = {}) {
  return {
    ...dimensions,
    timestampSeconds: 1790000000,
    resultClass: "failure",
    category: "database",
    code: "d1_query_failed",
    operation: "d1.all",
    hotQueryId: queryId,
    variant: "raw.filtered",
    filterShape: "basic.cx.1.1.o1",
    scanQueryId: "analytics.rollup.hourly_rows",
    dominantPhase: "route.handler",
    filterFamily: "basic",
    sampleInterval: 9,
    invocationWallMs: 12,
    handlerWallMs: 0,
    httpStatus: 500,
    flags: 1 | 2 | 16 | 32 | 64 | 128,
    details: "",
    ...overrides,
  };
}

describe("AE v2 reader normalization with real coverage and trust boundaries", () => {
  it("normalizes complete, partial, and unavailable cost metrics without conflating zero and missing", () => {
    const result = normalizeInvocationView("overview", {
      summary: [
        aggregate({
          d1RowsReadApplicable: 9,
          d1RowsReadComplete: 4,
          d1RowsReadPartial: 3,
          d1RowsReadObserved: 125,
          d1SqlEngineMsApplicable: 9,
          d1SqlEngineMsComplete: 9,
          d1SqlEngineMsObserved: 0,
          d1ApiWallMsApplicable: 9,
        }),
      ],
      trend: [{ ...aggregate(), bucket: 1790000000 }],
      legacy: [{ retainedSamples: 5 }],
    });
    expect(result.status).toBe("ready");
    expect(result.data.legacy).toEqual({ retainedSamples: 5 });
    expect(result.data.trend[0]?.bucket).toBe(1790000000);
    expect(result.data.summary).toMatchObject({
      retainedSamples: 2,
      estimatedInvocations: 9,
      handlerWeight: 5,
      p50: 0,
      p95: 11,
      p99: 30,
      weighted: {
        d1RowsRead: {
          coverage: "partial",
          lowerBound: true,
          observed: 125,
          value: 125,
        },
        d1SqlEngineMs: {
          coverage: "complete",
          lowerBound: false,
          value: 0,
        },
        d1ApiWallMs: { coverage: "unavailable", value: null },
        doFetchWallMs: { coverage: "unavailable", value: null },
      },
    });
  });

  it("handles no samples and v1-only history without inventing valid v2 latency", () => {
    const noData = normalizeInvocationView("overview", {});
    expect(noData.status).toBe("no_data");
    expect(noData.data).toEqual({ summary: null, trend: [], legacy: null });

    const oldOnly = normalizeInvocationView("overview", {
      legacy: [{ retainedSamples: 6 }],
    });
    expect(oldOnly.status).toBe("insufficient_coverage");

    const empty: Record<string, unknown> = Object.fromEntries(
      Object.keys(aggregate()).map((key) => [key, null]),
    );
    empty.retainedSamples = 0;
    const emptyResult = normalizeInvocationView("overview", {
      summary: [empty],
    });
    expect(emptyResult.status).toBe("no_data");
    expect(emptyResult.data.summary).toMatchObject({
      estimatedInvocations: 0,
      maxSampleInterval: null,
      p50: null,
      p95: null,
      p99: null,
      invocationWallMs: 0,
      weighted: { d1RowsRead: { value: null, coverage: "unavailable" } },
    });
  });

  it("reads trusted route dimensions and safely normalizes optional versions", () => {
    const data = normalizeInvocationView("routes", {
      routes: [
        { ...dimensions, ...aggregate() },
        { ...dimensions, appVersion: "", ...aggregate({ p95: 0 }) },
      ],
    });
    expect(data.status).toBe("ready");
    expect(data.data.routes).toHaveLength(2);
    expect(data.data.routes[0]).toMatchObject({
      routeKey: "api:/collect",
      appVersion: "1.2.3",
      p95: 11,
    });
    expect(data.data.routes[1]?.appVersion).toBeNull();
    expect(normalizeInvocationView("routes", {}).status).toBe("no_data");
  });

  it("parses safe error groups, rejects unsafe codes, and distinguishes empty results", () => {
    const valid = {
      ...dimensions,
      retainedSamples: 1,
      estimatedInvocations: 4,
      maxSampleInterval: 4,
      resultClass: "failure",
      category: "database",
      code: "d1_query_failed",
      operation: "d1.all",
    };
    const result = normalizeInvocationView("errors", { errors: [valid] });
    expect(result.status).toBe("ready");
    expect(result.data.errors[0]).toMatchObject({
      resultClass: "failure",
      category: "database",
      code: "d1_query_failed",
      operation: "d1.all",
      estimatedInvocations: 4,
    });
    expect(normalizeInvocationView("errors", {}).status).toBe("no_data");
    for (const patch of [
      { resultClass: "server_error" },
      { code: "SQL SELECT *" },
      { category: "customer@example.com" },
      { operation: "drop table;" },
    ]) {
      expect(() =>
        normalizeInvocationView("errors", {
          errors: [{ ...valid, ...patch }],
        }),
      ).toThrow("Invalid invocation metrics result");
    }
  });

  it("distinguishes API, engine fallback, and scan-query cost attribution", () => {
    const base = {
      ...dimensions,
      retainedSamples: 1,
      estimatedInvocations: 9,
      maxSampleInterval: 9,
      queryId,
      variant: "raw.filtered",
      filterShape: "basic.cx.1.1.o1",
      filterFamily: "basic",
      weightedValue: 14,
    };
    const result = normalizeInvocationView("hotspots", {
      summary: [aggregate()],
      "api-hot": [base],
      "sql-engine-fallback": [{ ...base, variant: "batch" }],
      scan: [
        {
          ...base,
          queryId: "unknown_d1",
          variant: "discarded",
          filterShape: "unsafe",
          filterFamily: "unsafe",
        },
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.data.summary?.retainedSamples).toBe(2);
    expect(result.data.hotspots["api-hot"][0]).toMatchObject({
      queryId,
      granularity: "sql-template",
      variant: "raw.filtered",
      filterShape: "basic.cx.1.1.o1",
      weightedValue: 14,
    });
    expect(result.data.hotspots["api-hot"][0]?.owner).toBeTruthy();
    expect(result.data.hotspots["sql-engine-fallback"][0]?.variant).toBe(
      "batch",
    );
    expect(result.data.hotspots.scan[0]).toMatchObject({
      queryId: "unknown_d1",
      variant: null,
      filterShape: null,
      filterFamily: null,
      granularity: "unknown",
      owner: null,
    });
    expect(normalizeInvocationView("hotspots", {}).status).toBe("no_data");
    for (const patch of [
      { queryId: "unregistered_query" },
      { variant: "not-a-variant" },
      { filterShape: "user.email='secret'" },
      { filterFamily: "arbitrary-user-data" },
      { weightedValue: -2 },
    ]) {
      expect(() =>
        normalizeInvocationView("hotspots", {
          "api-hot": [{ ...base, ...patch }],
        }),
      ).toThrow("Invalid invocation metrics result");
    }
  });

  it("decodes bounded, whitelisted sample phases, queries, coverage and truncation", () => {
    const details = JSON.stringify({
      v: 2,
      phases: [
        { id: "route.handler", count: 1, wallMs: 12 },
        { id: "private.user.data", count: 1, wallMs: 100 },
        { id: "d1.all", count: -1, wallMs: 5 },
        null,
      ],
      queries: [
        {
          id: queryId,
          variant: "raw.filtered",
          count: 1,
          apiWallMs: 3,
          sqlEngineMs: 2,
          rowsRead: 120,
          rowsWritten: 0,
          attempts: 1,
          failed: false,
          coverage: {
            api: "complete",
            engine: "partial",
            rowsRead: "partial",
            rowsWritten: "complete",
            attempts: "complete",
          },
        },
        { id: "user_specific_sql", variant: "raw.filtered" },
        { id: queryId, variant: "invalid_variant" },
        {
          id: "unknown_d1",
          variant: "unknown",
          count: 1,
          apiWallMs: 0,
          sqlEngineMs: 0,
          rowsRead: 0,
          rowsWritten: 0,
          attempts: 0,
          coverage: { api: "not_applicable" },
        },
      ],
      coverage: {
        query: "complete",
        queryGranularity: "sql-template",
        templateStatements: 2,
        familyStatements: 0,
      },
      truncation: { queriesDropped: 1, phasesDropped: 2, signalsDropped: 0 },
    });
    const result = normalizeInvocationView("samples", {
      samples: [sampleRow({ details })],
    });
    expect(result.status).toBe("ready");
    const parsed = result.data.samples[0]!;
    expect(parsed).toMatchObject({
      hotQueryId: queryId,
      scanQueryId: "analytics.rollup.hourly_rows",
      variant: "raw.filtered",
      filterShape: "basic.cx.1.1.o1",
      dominantPhase: "route.handler",
      httpStatus: 500,
      handlerWallMs: 0,
      detailsTruncated: true,
    });
    expect(parsed.details).toMatchObject({
      version: 2,
      phases: [{ id: "route.handler", count: 1, wallMs: 12 }],
      coverage: {
        query: "complete",
        queryGranularity: "sql-template",
        templateStatements: 2,
        familyStatements: 0,
      },
      truncation: { queriesDropped: 1, phasesDropped: 2, signalsDropped: 0 },
    });
    expect(parsed.details?.queries).toHaveLength(2);
    expect(parsed.details?.queries[0]).toMatchObject({
      id: queryId,
      granularity: "sql-template",
      rowsRead: 120,
      coverage: { api: "complete", engine: "partial", rowsRead: "partial" },
    });
    expect(parsed.details?.queries[1]).toMatchObject({
      id: "unknown_d1",
      granularity: "unknown",
      failed: false,
      coverage: { api: "unavailable" },
    });
  });

  it("treats absent flags and malformed details as unavailable instead of false measurements", () => {
    const result = normalizeInvocationView("samples", {
      samples: [
        sampleRow({
          flags: 0,
          hotQueryId: "untrusted_id",
          scanQueryId: "untrusted_id",
          variant: "untrusted_variant",
          filterShape: "private",
          filterFamily: "private",
          handlerWallMs: -5,
          httpStatus: 999,
          dominantPhase: "",
          details: "{ malformed",
        }),
        sampleRow({ details: JSON.stringify({ v: 1 }) }),
        sampleRow({ details: JSON.stringify([]) }),
        sampleRow({ details: "x".repeat(4097) }),
        sampleRow({
          details: JSON.stringify({ v: 2, phases: [], queries: [] }),
        }),
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.data.samples[0]).toMatchObject({
      hotQueryId: null,
      scanQueryId: null,
      variant: null,
      filterShape: null,
      filterFamily: null,
      handlerWallMs: null,
      httpStatus: null,
      details: null,
    });
    expect(
      result.data.samples.slice(1, 4).every((item) => item.details === null),
    ).toBe(true);
    expect(result.data.samples[4]?.details).toMatchObject({
      phases: [],
      queries: [],
      coverage: null,
      truncation: null,
    });
    expect(normalizeInvocationView("samples", {}).status).toBe("no_data");
  });

  it("rejects invalid public sample columns, dimensions, numeric values, and unsafe enum values", () => {
    const cases: Record<string, unknown>[] = [
      { source: "unknown" },
      { trigger: "timer" },
      { routeKey: "api:/collect'; DROP TABLE visits" },
      { appVersion: "../../secret" },
      { resultClass: "stacktrace" },
      { category: "sensitive" },
      { code: "private.email@example.com" },
      { operation: "select * from visits" },
      { hotQueryId: "unknown_sql" },
      { scanQueryId: "unknown_sql" },
      { variant: "sql_raw" },
      { filterShape: "private_user_value" },
      { filterFamily: "arbitrary" },
      { dominantPhase: "trace.private_user" },
      { sampleInterval: 0 },
      { httpStatus: 600 },
      { handlerWallMs: -1 },
      { invocationWallMs: Number.NaN },
      { flags: -1 },
      { timestampSeconds: -1 },
    ];
    for (const patch of cases) {
      expect(() =>
        normalizeInvocationView("samples", {
          samples: [sampleRow(patch)],
        }),
      ).toThrow("Invalid invocation metrics result");
    }
    expect(() =>
      normalizeInvocationView("samples", {
        samples: [null as never],
      }),
    ).toThrow("Invalid invocation metrics result");
    expect(() =>
      normalizeInvocationView("samples", {
        samples: {} as never,
      }),
    ).toThrow("Invalid invocation metrics result");
  });

  it("rejects impossible aggregate coverage and non-finite or negative weighted values", () => {
    const badAggregates: Record<string, unknown>[] = [
      { d1RowsReadApplicable: 4, d1RowsReadComplete: 5 },
      { d1RowsReadApplicable: 4, d1RowsReadPartial: 5 },
      { d1RowsReadApplicable: 4, d1RowsReadComplete: 3, d1RowsReadPartial: 3 },
      { retainedSamples: -1 },
      { retainedSamples: 1.5 },
      { maxSampleInterval: 0 },
      { estimatedInvocations: -10 },
      { invocationWallMs: Number.POSITIVE_INFINITY },
      { p95: -1 },
    ];
    for (const bad of badAggregates) {
      expect(() =>
        normalizeInvocationView("overview", {
          summary: [aggregate(bad)],
        }),
      ).toThrow("Invalid invocation metrics result");
    }
  });

  it("preserves safe nested diagnostics while dropping malformed individual phases and queries", () => {
    const details = JSON.stringify({
      v: 2,
      phases: [
        null,
        7,
        [],
        { id: "route.handler", count: 1, wallMs: 4 },
        { id: "d1.all", count: -1, wallMs: 2 },
      ],
      queries: [
        null,
        [],
        {
          id: queryId,
          variant: "raw.filtered",
          count: -1,
          apiWallMs: 0,
          sqlEngineMs: 0,
          rowsRead: 0,
          rowsWritten: 0,
          attempts: 0,
        },
        {
          id: queryId,
          variant: "raw.filtered",
          count: 1,
          apiWallMs: 4,
          sqlEngineMs: 2,
          rowsRead: 3,
          rowsWritten: 0,
          attempts: 1,
          failed: true,
          coverage: ["not an accepted coverage object"],
        },
      ],
      coverage: {
        query: "partial",
        queryGranularity: "mixed",
        templateStatements: 1,
        familyStatements: 1,
      },
      truncation: { queriesDropped: 2, phasesDropped: 1, signalsDropped: 1 },
    });
    const result = normalizeInvocationView("samples", {
      samples: [sampleRow({ details })],
    });
    expect(result.data.samples[0]?.details).toMatchObject({
      phases: [{ id: "route.handler", count: 1, wallMs: 4 }],
      queries: [
        {
          id: queryId,
          failed: true,
          coverage: {
            api: "unavailable",
            engine: "unavailable",
            rowsRead: "unavailable",
          },
        },
      ],
      coverage: {
        query: "partial",
        queryGranularity: "mixed",
        templateStatements: 1,
        familyStatements: 1,
      },
      truncation: { queriesDropped: 2, phasesDropped: 1, signalsDropped: 1 },
    });
  });

  it("discards invalid optional coverage metadata without exposing untrusted JSON fields", () => {
    const malformed = normalizeInvocationView("samples", {
      samples: [
        sampleRow({
          details: JSON.stringify({
            v: 2,
            phases: { id: "route.handler" },
            queries: "not-an-array",
            coverage: {
              query: "complete",
              queryGranularity: "sql-template",
              templateStatements: -1,
              familyStatements: 1,
            },
            truncation: {
              queriesDropped: -1,
              phasesDropped: 0,
              signalsDropped: 0,
            },
            privateUserId: "must never be returned",
          }),
        }),
        sampleRow({
          details: JSON.stringify({
            v: 2,
            phases: [],
            queries: [],
            coverage: ["invalid"],
            truncation: ["invalid"],
          }),
        }),
        sampleRow({ details: JSON.stringify(null) }),
        sampleRow({ details: { v: 2 } }),
      ],
    });
    expect(malformed.status).toBe("ready");
    expect(malformed.data.samples[0]?.details).toEqual({
      version: 2,
      phases: [],
      queries: [],
      coverage: null,
      truncation: null,
    });
    expect(malformed.data.samples[1]?.details).toMatchObject({
      coverage: null,
      truncation: null,
    });
    expect(malformed.data.samples[2]?.details).toBeNull();
    expect(malformed.data.samples[3]?.details).toBeNull();
  });
});
