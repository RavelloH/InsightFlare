import { describe, expect, it } from "vitest";

import { buildInvocationStatements } from "@/lib/edge/admin/observability/invocation-metrics-sql";

const now = 1_800_000_000_000;
const from = now - 3_600_000;
const queryId = "analytics.overview.raw.summary";

function statements(values: Record<string, string>) {
  return buildInvocationStatements(
    new URLSearchParams({
      from: String(from),
      to: String(now),
      limit: "20",
      ...values,
    }),
    now,
  );
}

describe("AE invocation SQL fixed-query builder and read isolation", () => {
  it("builds bounded, weighted overview and legacy version-aware SQL", () => {
    const built = statements({
      view: "overview",
      source: "worker",
      interval: "hour",
      timeZone: "UTC",
    });
    expect(built).not.toBeNull();
    expect(built?.query.window).toMatchObject({
      from,
      to: now,
      effectiveFrom: from,
      effectiveTo: now,
    });
    expect(built?.statements.map((item) => item.name)).toEqual([
      "summary",
      "trend",
      "legacy",
    ]);
    const summary = built!.statements[0]!;
    expect(summary.limit).toBe(1);
    expect(summary.sql).toContain("FROM insightflare_invocation_metrics");
    expect(summary.sql).toContain("double20 = 2");
    expect(summary.sql).toContain("blob1 = 'worker'");
    expect(summary.sql).toContain("quantileExactWeighted");
    expect(summary.sql).toContain("_sample_interval");
    expect(summary.sql).toContain("LIMIT 1 FORMAT JSONEachRow");
    expect(built!.statements[1]!.sql).toContain(
      "toStartOfInterval(timestamp, INTERVAL '1' HOUR, 'UTC')",
    );
    expect(built!.statements[1]!.sql).toContain(
      "GROUP BY bucket ORDER BY bucket DESC LIMIT 20",
    );
    expect(built!.statements[2]!.sql).toContain("double20 = 1");
    expect(built!.statements[2]!.sql).not.toContain("double20 = 2");
  });

  it("groups routes with a bounded time range and trusted filters", () => {
    const built = statements({
      view: "routes",
      source: "do",
      trigger: "alarm",
      routeKey: "do.flush",
      appVersion: "1.2.3",
    });
    expect(built?.statements).toHaveLength(1);
    const route = built!.statements[0]!;
    expect(route.name).toBe("routes");
    expect(route.limit).toBe(20);
    expect(route.sql).toContain("blob1 = 'do'");
    expect(route.sql).toContain("blob2 = 'alarm'");
    expect(route.sql).toContain("blob4 = 'do.flush'");
    expect(route.sql).toContain("blob10 = '1.2.3'");
    expect(route.sql).toContain(
      "GROUP BY blob1, blob2, blob4, blob10 ORDER BY estimatedInvocations DESC",
    );
    expect(route.sql).toContain("SUM(double1 * _sample_interval)");
    expect(route.sql).toContain("LIMIT 20 FORMAT JSONEachRow");
  });

  it("groups safe error categories and preserves the failure predicate", () => {
    const built = statements({
      view: "errors",
      resultClass: "failure",
      source: "worker",
    });
    expect(built?.statements).toHaveLength(1);
    const item = built!.statements[0]!;
    expect(item.name).toBe("errors");
    expect(item.sql).toContain("blob6 = 'failure'");
    expect(item.sql).toContain("blob11 AS category");
    expect(item.sql).toContain("blob12 AS code");
    expect(item.sql).toContain("blob13 AS operation");
    expect(item.sql).toContain(
      "AND (blob12 != '' OR blob6 = 'failure') GROUP BY",
    );
    expect(item.sql).toContain("LIMIT 20 FORMAT JSONEachRow");
  });

  it("selects the correct hot-query metric and scan-query columns", () => {
    const all = statements({ view: "hotspots" });
    expect(all?.statements.map((item) => item.name)).toEqual([
      "summary",
      "api-hot",
      "sql-engine-fallback",
      "scan",
    ]);
    const api = all!.statements[1]!.sql;
    const engine = all!.statements[2]!.sql;
    const scan = all!.statements[3]!.sql;
    expect(api).toContain("blob14 AS queryId");
    expect(api).toContain("SUM(double14 * _sample_interval)");
    expect(api).toContain("blob16 AS filterShape");
    expect(engine).toContain("SUM(double15 * _sample_interval)");
    expect(engine).toContain("blob14 AS queryId");
    expect(scan).toContain("blob17 AS queryId");
    expect(scan).toContain("SUM(double17 * _sample_interval)");
    expect(scan).not.toContain("blob16 AS filterShape");

    const only = statements({ view: "hotspots", kind: "scan" });
    expect(only?.statements.map((item) => item.name)).toEqual([
      "summary",
      "scan",
    ]);
    expect(
      only?.statements.every((item) => item.sql.includes("double20 = 2")),
    ).toBe(true);
  });

  it("matches only registered primary hot or scan query IDs in retained samples", () => {
    const all = statements({
      view: "samples",
      sampleQueryId: queryId,
      sampleErrorCode: "d1_query_failed",
    });
    expect(all?.statements).toHaveLength(1);
    const sql = all!.statements[0]!.sql;
    expect(sql).toContain(`blob14 = '${queryId}'`);
    expect(sql).toContain(`blob17 = '${queryId}'`);
    expect(sql).toContain("blob12 = 'd1_query_failed'");
    expect(sql).toContain("substring(blob19, 1, 4097) AS details");
    expect(sql).toContain("ORDER BY timestampSeconds DESC LIMIT 20");
    expect(sql).not.toContain("JSONExtract");
    const scan = statements({
      view: "samples",
      sampleQueryId: queryId,
      sampleKind: "scan",
      trigger: "request",
    })!.statements[0]!.sql;
    expect(scan).toContain(`blob17 = '${queryId}'`);
    expect(scan).not.toContain(`blob14 = '${queryId}'`);
    expect(scan).toContain("blob2 = 'request'");
  });

  it("rejects unsupported datasets, SQL fragments, and incompatible query combinations", () => {
    const invalidQueries: Record<string, string>[] = [
      { view: "custom_sql" },
      { view: "routes", routeKey: "api:/collect' OR 1=1" },
      { view: "routes", appVersion: "1.2.3';DROP TABLE sites" },
      { view: "hotspots", kind: "injection" },
      { view: "routes", kind: "scan" },
      { view: "samples", sampleKind: "scan" },
      { view: "samples", sampleQueryId: "private.user.sql" },
      { view: "overview", dataset: "custom_events" },
      { view: "overview", limit: "999" },
      { view: "overview", timeZone: "bad<zone" },
    ];
    for (const query of invalidQueries) {
      expect(statements(query)).toBeNull();
    }
  });
});
