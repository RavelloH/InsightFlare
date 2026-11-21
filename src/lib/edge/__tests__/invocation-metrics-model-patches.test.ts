import { describe, expect, it } from "vitest";

import { normalizeInvocationView } from "@/lib/edge/admin/observability/invocation-metrics-model";

const metricFields = Object.fromEntries(
  [
    "d1RowsRead",
    "d1SqlEngineMs",
    "d1ApiWallMs",
    "doFetchWallMs",
    "doSqlRowsRead",
  ].flatMap((name) =>
    ["Applicable", "Complete", "Partial", "Observed"].map((suffix) => [
      name + suffix,
      0,
    ]),
  ),
);
function summary(handlerWeight: number, value: number | null) {
  return {
    retainedSamples: 1,
    estimatedInvocations: 1,
    maxSampleInterval: 1,
    handlerWeight,
    p50: value,
    p95: value,
    p99: value,
    invocationWallMs: 0,
    workerD1Statements: 0,
    doFetchCalls: 0,
    ...metricFields,
  };
}
describe("v2 handler percentiles are valid only with a real handler sample", () => {
  it("ignores upstream zero placeholders for handler-less windows", () => {
    const result = normalizeInvocationView("overview", {
      summary: [summary(0, 0)],
      trend: [{ ...summary(0, 0), bucket: 1790000000 }],
    });
    expect(result.status).toBe("ready");
    expect(result.data.summary).toMatchObject({
      handlerWeight: 0,
      p50: null,
      p95: null,
      p99: null,
    });
    expect(result.data.trend[0]).toMatchObject({
      p50: null,
      p95: null,
      p99: null,
    });
  });
  it("keeps genuine zero-millisecond handler results", () => {
    const result = normalizeInvocationView("overview", {
      summary: [summary(1, 0)],
      trend: [{ ...summary(1, 0), bucket: 1790000000 }],
    });
    expect(result.data.summary).toMatchObject({
      handlerWeight: 1,
      p50: 0,
      p95: 0,
      p99: 0,
    });
    expect(result.data.trend[0]?.p95).toBe(0);
  });
});
