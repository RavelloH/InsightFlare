import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthModule from "@/lib/edge/admin/auth";
import { requireActor } from "@/lib/edge/admin/auth";
import { buildInvocationStatements } from "@/lib/edge/admin/observability/invocation-metrics-sql";
import { executeRealAdminService } from "@/lib/edge/admin/service/real";
import type * as SecretEncryptionModule from "@/lib/edge/auth/secret-encryption";
import { decryptAnalyticsEngineSecret } from "@/lib/edge/auth/secret-encryption";
import type * as SystemConfigModule from "@/lib/edge/system-config";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/admin/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  requireActor: vi.fn(),
}));
vi.mock("@/lib/edge/system-config", async (importOriginal) => ({
  ...(await importOriginal<typeof SystemConfigModule>()),
  readConfig: vi.fn(),
}));
vi.mock("@/lib/edge/auth/secret-encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof SecretEncryptionModule>()),
  decryptAnalyticsEngineSecret: vi.fn(),
}));

const now = 1_790_000_000_555;
const build = (query: string) =>
  buildInvocationStatements(new URLSearchParams(query), now);

describe("invocation metrics SQL", () => {
  it("defaults to a bounded 24-hour overview", () => {
    expect(build("")?.query).toMatchObject({
      view: "overview",
      window: { from: now - 86_400_000, to: now },
    });
  });

  it("uses fixed slots, weighted handler percentiles and an isolated v1 count", () => {
    const built = build(
      "view=overview&from=1789996400001&to=1790000000555&interval=minute&timeZone=Asia%2FShanghai&routeKey=api%3A%2Fv1%2F%7Bid%7D&appVersion=1.2.3%2Babcdef123456&limit=20",
    )!;
    expect(built.query.window).toEqual({
      from: 1789996400001,
      to: 1790000000555,
      effectiveFrom: 1789996401000,
      effectiveTo: 1790000001000,
    });
    expect(built.statements.map(({ name }) => name)).toEqual([
      "summary",
      "trend",
      "legacy",
    ]);
    const [summary, trend, legacy] = built.statements;
    for (const { sql } of built.statements) {
      expect(sql).toContain(
        "FROM insightflare_invocation_metrics WHERE timestamp >= toDateTime(1789996401) AND timestamp < toDateTime(1790000001)",
      );
      expect(sql).toMatch(/LIMIT (1|20) FORMAT JSONEachRow$/);
    }
    expect(summary.sql).toContain("double20 = 2");
    expect(summary.sql).toContain(
      "blob4 = 'api:/v1/{id}' AND blob10 = '1.2.3+abcdef123456'",
    );
    expect(summary.sql).toContain(
      "COUNT(*) AS retainedSamples, SUM(_sample_interval) AS estimatedInvocations",
    );
    expect(summary.sql).toContain(
      "quantileExactWeighted(0.95)(if(blob1 = 'worker' AND blob2 = 'request' AND intDiv(double19, 1) % 2 = 1, double2, 0), if(blob1 = 'worker' AND blob2 = 'request' AND intDiv(double19, 1) % 2 = 1, _sample_interval, 0))",
    );
    expect(summary.sql).toContain(
      "blob1 = 'worker' AND double4 > 0 AND intDiv(double19, 1024) % 4 IN (1, 2), _sample_interval * double6",
    );
    expect(summary.sql).toContain(
      "blob1 = 'do' AND intDiv(double19, 1048576) % 4 IN (1, 2), _sample_interval * double13",
    );
    expect(trend.sql).toContain("INTERVAL '1' MINUTE, 'Asia/Shanghai'");
    expect(legacy.sql).toBe(
      "SELECT COUNT(*) AS retainedSamples FROM insightflare_invocation_metrics WHERE timestamp >= toDateTime(1789996401) AND timestamp < toDateTime(1790000001) AND double20 = 1 LIMIT 1 FORMAT JSONEachRow",
    );
  });

  it.each([
    "routeKey=api%3A%2Fx%27%20OR%201%3D1--",
    "routeKey=api%3A%2Fx%5C%27",
    "appVersion=1.2.3%27%3BSELECT",
    "appVersion=1.2.3%0A",
    "timeZone=UTC%27",
    "from=0",
    "from=1700000000000",
    "limit=101",
    "limit=10&limit=1",
    "interval=week",
    "source=visit",
    "trigger=fetch",
    "resultClass=error",
  ])("rejects %s before building SQL", (filter) => {
    expect(build(`view=overview&${filter}`)).toBeNull();
  });

  it("keeps independent hotspot bases and only attributes selected-query totals", () => {
    const [_summary, api, fallback, scan] = build("view=hotspots")!.statements;
    expect(api.sql).toContain(
      "intDiv(double19, 16) % 2 = 1 AND intDiv(double19, 512) % 2 = 1",
    );
    expect(api.sql).toContain("SUM(double14 * _sample_interval)");
    expect(fallback.sql).toContain(
      "NOT (intDiv(double19, 512) % 2 = 1) AND intDiv(double19, 4194304) % 4 = 2",
    );
    expect(fallback.sql).toContain("SUM(double15 * _sample_interval)");
    expect(scan.sql).toContain(
      "intDiv(double19, 32) % 2 = 1 AND intDiv(double19, 67108864) % 4 = 2",
    );
    expect(scan.sql).toContain("blob17 AS queryId");
    expect(scan.sql).not.toMatch(/blob16|double6/);
    expect(
      build("view=hotspots&kind=scan")!.statements.map(({ name }) => name),
    ).toEqual(["summary", "scan"]);
  });

  it("uses 1/9 sampling weights, excludes v1 and DO from handler percentiles, and preserves covered zero", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    using db = new DatabaseSync(":memory:");
    db.function("intDiv", (value, divisor) =>
      Math.floor(Number(value) / Number(divisor)),
    );
    db.function("toDateTime", (seconds) => seconds);
    db.function("if", (condition, yes, no) => (condition ? yes : no));
    for (const percentile of [50, 95, 99]) {
      db.aggregate("weighted" + percentile, {
        start: "[]",
        step: (state, value, weight) =>
          JSON.stringify([
            ...(JSON.parse(String(state)) as number[]),
            ...Array<number>(Number(weight)).fill(Number(value)),
          ]),
        result: (state) => {
          const values = (JSON.parse(String(state)) as number[]).sort(
            (a, b) => a - b,
          );
          return (
            values[Math.ceil((values.length * percentile) / 100) - 1] ?? null
          );
        },
      });
    }
    const metricSlots = Array.from(
      { length: 20 },
      (_, index) => `double${index + 1} REAL DEFAULT 0`,
    );
    db.exec(`CREATE TABLE insightflare_invocation_metrics (timestamp INTEGER DEFAULT 1790000000, _sample_interval INTEGER, blob1 TEXT, blob2 TEXT, ${metricSlots.join(", ")});
      INSERT INTO insightflare_invocation_metrics (_sample_interval, blob1, blob2, double2, double4, double6, double19, double20) VALUES
        (1, 'worker', 'request', 90, 1, 0, 2049, 2),
        (9, 'worker', 'request', 0, 1, 4, 1025, 2),
        (50, 'do', 'alarm', 500, 0, 0, 1, 2),
        (100, 'worker', 'request', 500, 1, 8, 2049, 1);`);
    const [statement] = build("view=overview")!.statements;
    const sql = statement.sql
      .replace(/quantileExactWeighted\(0\.(\d+)\)/g, "weighted$1")
      .replace(/ FORMAT JSONEachRow$/, "");
    expect(db.prepare(sql).get()).toMatchObject({
      retainedSamples: 3,
      estimatedInvocations: 60,
      handlerWeight: 10,
      p50: 0,
      p95: 90,
      p99: 90,
      d1RowsReadComplete: 1,
      d1RowsReadPartial: 9,
      d1RowsReadObserved: 36,
    });
  });
});

describe("system-performance invocation read dispatch", () => {
  const fetcher = vi.fn<typeof fetch>();
  const env = {
    INVOCATION_METRICS: { writeDataPoint: vi.fn() },
  } as unknown as Env;
  const read = (override: Partial<Env> = {}, query = "view=samples") => {
    const url = new URL(
      `https://example.test/api/private/admin/system-performance?${query}`,
    );
    return executeRealAdminService({
      route: "system-performance",
      request: new Request(url),
      env: { ...env, ...override },
      url,
    });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(requireActor).mockResolvedValue({ isAdmin: true } as Awaited<
      ReturnType<typeof requireActor>
    >);
    vi.mocked(readConfig).mockResolvedValue({
      accountId: "a".repeat(32),
      configured: true,
      apiTokenEncrypted: "ciphertext",
    });
    vi.mocked(decryptAnalyticsEngineSecret).mockResolvedValue("PRIVATE_TOKEN");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("denies a non-admin before inspecting config or invoking AE", async () => {
    vi.mocked(requireActor).mockResolvedValue({ isAdmin: false } as Awaited<
      ReturnType<typeof requireActor>
    >);
    expect((await read()).status).toBe(403);
    expect(readConfig).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports disabled, unbound and missing reader separately", async () => {
    expect(
      await (
        await read({ INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "1" })
      ).json(),
    ).toMatchObject({ data: { status: "disabled" } });
    expect(
      await (await read({ INVOCATION_METRICS: undefined })).json(),
    ).toMatchObject({ data: { status: "writer_not_bound" } });
    vi.mocked(readConfig).mockResolvedValue(null);
    expect(await (await read({}, "")).json()).toMatchObject({
      data: { status: "reader_not_configured", view: "overview" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns no_data on a valid empty response and rejects an invalid view", async () => {
    fetcher.mockResolvedValue(new Response(""));
    expect(await (await read()).json()).toMatchObject({
      data: { view: "samples", status: "no_data", schemaVersion: 2 },
    });
    expect((await read({}, "view=unknown")).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 401, 403, 503, 507, 200])(
    "safely maps upstream %s with no retry or leaked body",
    async (status) => {
      fetcher.mockResolvedValue(
        new Response("PRIVATE_TOKEN SELECT PRIVATE_SQL", {
          status,
          headers: { "Retry-After": "12" },
        }),
      );
      const response = await read();
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        data: { status: "query_failed", error: { code: expect.any(String) } },
      });
      if (status === 429)
        expect(response.headers.get("retry-after")).toBe("12");
      expect(body).not.toMatch(/PRIVATE_TOKEN|PRIVATE_SQL|SELECT/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
