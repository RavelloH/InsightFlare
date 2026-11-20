import { afterEach, describe, expect, it, vi } from "vitest";

import { safeFilterShape } from "@/lib/edge/analytics-engine/filter-shape";
import { HotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import {
  v2BooleanFlag,
  v2CoverageFlag,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";
import {
  encodeInvocationMetricsPointV2,
  registerInvocationMetrics,
} from "@/lib/edge/analytics-engine/invocation-writer";
import {
  registeredProviderQuery,
  runWithQueryIdentity,
  setCurrentQueryFilterShape,
} from "@/lib/edge/analytics-engine/query-registry";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

afterEach(() => vi.restoreAllMocks());

function setup() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const points: Array<{
    indexes: string[];
    blobs: string[];
    doubles: number[];
  }> = [];
  const waiting: Promise<unknown>[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
    waitUntil: (p) => waiting.push(p),
  });
  const env = {
    INVOCATION_METRICS: {
      writeDataPoint: (point: (typeof points)[number]) => points.push(point),
    },
    DB: {} as D1Database,
  } as unknown as Env;
  registerInvocationMetrics(env, logger);
  return {
    logger,
    env,
    points,
    waiting,
    emit: async () => {
      logger.emit();
      await Promise.all(waiting);
      expect(points).toHaveLength(1);
      return points[0];
    },
  };
}
function rows(read: number, duration: number) {
  return {
    results: [],
    meta: {
      rows_read: read,
      rows_written: 0,
      total_attempts: 1,
      timings: { sql_duration_ms: duration },
    },
  };
}

describe("v2 D1 Query ID attribution", () => {
  it("tags executed known provider SQL but never copies SQL strings or bind values", async () => {
    const f = setup();
    const secret = "CANARY_SQL_private@example.com_TOKEN123";
    const statement = { all: vi.fn(async () => rows(17, 3.5)), bind: vi.fn() };
    f.env.DB = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const wrapped = instrumentEnv(f.env, f.logger);
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "raw.filtered" },
        () =>
          wrapped.DB.prepare(
            `SELECT * FROM private_ledger WHERE token='${secret}'`,
          ).all(),
      ),
    );
    const point = await f.emit();
    expect(point.doubles[19]).toBe(2);
    expect(point.blobs[13]).toBe("analytics.overview");
    expect(point.blobs[14]).toBe("raw.filtered");
    expect(point.blobs[16]).toBe("analytics.overview");
    expect(point.doubles[3]).toBe(1);
    expect(point.doubles[5]).toBe(17);
    expect(point.doubles[7]).toBe(3.5);
    expect(point.doubles[15]).toBe(17);
    expect(v2CoverageFlag(point.doubles[18], "d1RowsRead")).toBe("complete");
    expect(v2BooleanFlag(point.doubles[18], "queryAttributionComplete")).toBe(
      false,
    );
    // A provider-family ID is not evidence of a concrete SQL template.
    expect(JSON.parse(point.blobs[18]).coverage.queryGranularity).toBe(
      "provider-family",
    );
    expect(JSON.stringify(point)).not.toContain(secret);
  });
  it("does not double-charge shared batch wall and retains per-SQL meta", async () => {
    const f = setup();
    const db = {
      prepare: vi.fn((sql: string) => ({
        sql,
        bind() {
          return this;
        },
      })),
      batch: vi.fn(async () => [rows(10, 2), rows(300, 7)]),
    };
    f.env.DB = db as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    const a = runWithQueryIdentity(
      { id: registeredProviderQuery("overview"), variant: "raw.filtered" },
      () => w.DB.prepare("SELECT 1"),
    );
    const b = runWithQueryIdentity(
      { id: registeredProviderQuery("pages"), variant: "raw.unfiltered" },
      () => w.DB.prepare("SELECT 2"),
    );
    await runWithInvocationLogger(f.logger, () => w.DB.batch([a, b]));
    const point = await f.emit();
    const details = JSON.parse(point.blobs[18]);
    expect(details.queries).toHaveLength(2);
    expect(
      details.queries.every(
        (q: { coverage: { api: string } }) => q.coverage.api === "unavailable",
      ),
    ).toBe(true);
    expect(point.blobs[13]).toBe("analytics.pages");
    expect(point.blobs[16]).toBe("analytics.pages");
    expect(point.doubles[3]).toBe(2);
    expect(point.doubles[5]).toBe(310);
    expect(point.doubles[8]).toBeGreaterThanOrEqual(0);
    expect(details.resources.d1Settled).toBe(1);
    expect(v2CoverageFlag(point.doubles[18], "d1ApiWall")).toBe("complete");
  });
  it("preserves failed and unavailable meta instead of interpreting zero as measured", async () => {
    const f = setup();
    const statement = {
      all: vi
        .fn()
        .mockResolvedValueOnce(rows(0, 0.25))
        .mockResolvedValueOnce({ results: [], meta: {} })
        .mockRejectedValueOnce(new Error("CANARY_secret_SQL_error")),
    };
    f.env.DB = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    const action = async () => {
      await w.DB.prepare("SELECT 1").all();
      await w.DB.prepare("SELECT 2").all();
      await expect(w.DB.prepare("SELECT 3").all()).rejects.toThrow();
    };
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "unknown" },
        action,
      ),
    );
    const point = await f.emit();
    expect(point.blobs[5]).toBe("failure");
    expect(v2CoverageFlag(point.doubles[18], "d1RowsRead")).toBe("partial");
    expect(v2CoverageFlag(point.doubles[18], "d1SqlEngine")).toBe("partial");
    expect(JSON.parse(point.blobs[18]).queries[0].failed).toBe(1);
    expect(JSON.stringify(point)).not.toContain("CANARY");
  });
  it("keeps unregistered dynamic tag in unknown_d1 and does not persist it", async () => {
    const f = setup();
    const statement = { run: vi.fn(async () => rows(4, 0.2)) };
    f.env.DB = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: "CANARY_UNTRUSTED_QUERY_ID", variant: "rollup" as const },
        () => w.DB.prepare("SELECT 1").run(),
      ),
    );
    const point = await f.emit();
    expect(point.blobs[13]).toBe("unknown_d1");
    expect(v2BooleanFlag(point.doubles[18], "queryAttributionComplete")).toBe(
      false,
    );
    expect(JSON.stringify(point)).not.toContain("CANARY");
  });
});

describe("v2 concurrent and batch attribution", () => {
  it("isolates overlapping asynchronous query identities and loggers", async () => {
    const a = setup();
    const b = setup();
    a.env.DB = {
      prepare: () => ({
        all: async () => {
          await new Promise((done) => setTimeout(done, 8));
          return rows(15, 1.5);
        },
      }),
    } as unknown as D1Database;
    b.env.DB = {
      prepare: () => ({ all: async () => rows(200, 4.5) }),
    } as unknown as D1Database;
    const aw = instrumentEnv(a.env, a.logger);
    const bw = instrumentEnv(b.env, b.logger);
    await Promise.all([
      runWithInvocationLogger(a.logger, () =>
        runWithQueryIdentity(
          { id: registeredProviderQuery("overview"), variant: "raw.filtered" },
          () => aw.DB.prepare("SELECT secret FROM a").all(),
        ),
      ),
      runWithInvocationLogger(b.logger, () =>
        runWithQueryIdentity(
          { id: registeredProviderQuery("pages"), variant: "raw.unfiltered" },
          () => bw.DB.prepare("SELECT secret FROM b").all(),
        ),
      ),
    ]);
    const ap = await a.emit();
    const bp = await b.emit();
    expect(ap.blobs[13]).toBe("analytics.overview");
    expect(bp.blobs[13]).toBe("analytics.pages");
    expect(ap.doubles[5]).toBe(15);
    expect(bp.doubles[5]).toBe(200);
  });

  it("retains static query identity when prepared in one scope and executed in another", async () => {
    const f = setup();
    f.env.DB = {
      prepare: vi.fn(() => ({ all: vi.fn(async () => rows(31, 2.5)) })),
    } as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    const prepared = runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("pages"), variant: "raw.unfiltered" },
        () => w.DB.prepare("SELECT safe_template WHERE secret_key = ?"),
      ),
    );
    await prepared.all();
    const point = await f.emit();
    expect(point.blobs[13]).toBe("analytics.pages");
    expect(point.blobs[14]).toBe("raw.unfiltered");
    expect(point.doubles[5]).toBe(31);
    expect(v2BooleanFlag(point.doubles[18], "queryAttributionComplete")).toBe(
      false,
    );
    // A provider-family ID is not evidence of a concrete SQL template.
    expect(JSON.parse(point.blobs[18]).coverage.queryGranularity).toBe(
      "provider-family",
    );
  });

  it("counts missing Batch slots as attempted but not as measured success", async () => {
    const f = setup();
    const db = {
      prepare: vi.fn(() => ({
        bind() {
          return this;
        },
      })),
      // D1 can return a malformed/missing batch slot; null is not a measured result.
      batch: vi.fn(async () => [rows(11, 0.4), null]),
    };
    f.env.DB = db as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "unknown" },
        () => w.DB.batch([w.DB.prepare("SELECT 1"), w.DB.prepare("SELECT 2")]),
      ),
    );
    const p = await f.emit();
    expect(p.doubles[3]).toBe(2);
    expect(p.doubles[5]).toBe(11);
    expect(v2CoverageFlag(p.doubles[18], "d1RowsRead")).toBe("partial");
    expect(JSON.parse(p.blobs[18]).queries[0].count).toBe(2);
    expect(JSON.parse(p.blobs[18]).queries[0].coverage.rowsRead).toBe(
      "partial",
    );
  });
});

describe("review R1 F1: real D1 proxy preserves each statement's Filter Shape", () => {
  const shape = (kind: "and" | "or") =>
    safeFilterShape({
      version: 1,
      root: {
        kind,
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" as never },
            operator: "eq",
            value: "CANARY_PRIVATE_A",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "session.durationMS" as never },
            operator: "gte",
            value: 1,
          },
        ],
      },
    });

  it("keeps prepared Batch statements with the same ID/Variant but distinct shapes separate", async () => {
    const f = setup();
    const and = shape("and"),
      or = shape("or");
    f.env.DB = {
      prepare: vi.fn(() => ({
        bind() {
          return this;
        },
      })),
      batch: vi.fn(async () => [rows(2, 1), rows(99_000, 70)]),
    } as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    const prepare = (filter: typeof and) =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "raw.filtered" },
        () => {
          setCurrentQueryFilterShape(filter);
          return w.DB.prepare("SELECT 1 WHERE key = ?").bind(
            "CANARY_PRIVATE_TOKEN",
          );
        },
      );
    const a = prepare(and);
    const b = prepare(or);
    await runWithInvocationLogger(f.logger, () => w.DB.batch([a, b]));
    const point = await f.emit();
    const details = JSON.parse(point.blobs[18]);
    expect(details.queries).toHaveLength(2);
    expect(details.queries).toContainEqual(
      expect.objectContaining({
        filterShape: and.code,
        rowsRead: 2,
        sqlEngineMs: 1,
      }),
    );
    expect(details.queries).toContainEqual(
      expect.objectContaining({
        filterShape: or.code,
        rowsRead: 99_000,
        sqlEngineMs: 70,
      }),
    );
    expect(point.blobs[15]).toBe(or.code);
    expect(point.blobs[13]).toBe("analytics.overview");
    expect(point.doubles[15]).toBe(99_000);
    expect(JSON.stringify(point)).not.toContain("CANARY_PRIVATE");
  });

  it("isolates overlapping query scopes with the same ID and different safe shapes", async () => {
    const f = setup();
    const and = shape("and"),
      or = shape("or");
    f.env.DB = {
      prepare: vi.fn((sql: string) => ({
        all: async () => {
          if (sql === "SLOW") await new Promise((done) => setTimeout(done, 7));
          return sql === "SLOW" ? rows(9000, 30) : rows(3, 1);
        },
      })),
    } as unknown as D1Database;
    const w = instrumentEnv(f.env, f.logger);
    const execute = (sql: string, filter: typeof and) =>
      runWithInvocationLogger(f.logger, () =>
        runWithQueryIdentity(
          { id: registeredProviderQuery("overview"), variant: "raw.filtered" },
          () => {
            setCurrentQueryFilterShape(filter);
            return w.DB.prepare(sql).all();
          },
        ),
      );
    await Promise.all([execute("SLOW", or), execute("FAST", and)]);
    const point = await f.emit();
    const details = JSON.parse(point.blobs[18]);
    expect(details.queries).toHaveLength(2);
    expect(details.queries).toContainEqual(
      expect.objectContaining({
        filterShape: or.code,
        rowsRead: 9000,
      }),
    );
    expect(details.queries).toContainEqual(
      expect.objectContaining({
        filterShape: and.code,
        rowsRead: 3,
      }),
    );
    expect(point.blobs[15]).toBe(or.code);
  });
});

describe("v2 bounded Hot/Scan Query ranking", () => {
  it("retains a different slowest and largest-scan ID", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    logger.setPerformance({
      d1Statements: 2,
      d1RowsRead: 510,
      d1RowsReadCoverage: "complete",
      d1SqlDurationMs: 14,
      d1SqlDurationCoverage: "complete",
    });
    const c = new HotspotCollector();
    c.record({
      identity: { id: "analytics.overview", variant: "raw.filtered" },
      apiWallMs: 90,
      rowsRead: 10,
      sqlEngineMs: 12,
    });
    c.record({
      identity: { id: "analytics.pages", variant: "raw.unfiltered" },
      apiWallMs: 5,
      rowsRead: 500,
      sqlEngineMs: 2,
    });
    const point = encodeInvocationMetricsPointV2(
      logger.snapshot(),
      c.snapshot(),
    );
    expect(point.blobs[13]).toBe("analytics.overview");
    expect(point.blobs[16]).toBe("analytics.pages");
    expect(point.doubles[13]).toBe(90);
    expect(point.doubles[15]).toBe(10);
    expect(point.doubles[16]).toBe(500);
    expect(point.doubles[18]).toBeLessThan(2 ** 30);
  });
});
