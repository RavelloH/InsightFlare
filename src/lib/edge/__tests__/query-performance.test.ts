import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import * as database from "@/lib/db";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { handlePerformanceContract as handlePerformance } from "@/lib/edge/analytics/interfaces/dashboard/protocol/analysis";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
  queryPerformanceTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";
import { installVisitSiteIdentityFixture } from "./site-identity-fixture";

const reportCompilerBoundary = vi.hoisted(() => ({
  enabled: false,
  entries: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof database>();
  return {
    ...actual,
    lowerLogicalPlan: (
      relation: Parameters<typeof actual.lowerLogicalPlan>[0],
    ) => {
      const physical = actual.lowerLogicalPlan(relation);
      if (reportCompilerBoundary.enabled) {
        reportCompilerBoundary.entries.push({
          genericRelation: relation,
          physicalPlan: physical,
          compilerInput: null,
          compilerOptions: null,
          compiledQuery: null,
        });
      }
      return physical;
    },
    compileD1Query: (
      plan: Parameters<typeof actual.compileD1Query>[0],
      options: Parameters<typeof actual.compileD1Query>[1],
    ) => {
      const query = actual.compileD1Query(plan, options);
      if (reportCompilerBoundary.enabled) {
        const entry = [...reportCompilerBoundary.entries]
          .reverse()
          .find(
            (candidate) =>
              candidate.physicalPlan === plan &&
              candidate.compiledQuery === null,
          );
        if (entry) {
          entry.compilerInput = plan;
          entry.compilerOptions = options;
          entry.compiledQuery = query;
        } else {
          reportCompilerBoundary.entries.push({
            genericRelation: null,
            physicalPlan: plan,
            compilerInput: plan,
            compilerOptions: options,
            compiledQuery: query,
          });
        }
      }
      return query;
    },
  };
});

interface PreparedQuery {
  sql: string;
  bindings: Array<string | number | null>;
}
function createD1Env(rowSets: Record<string, unknown>[][] = []) {
  const calls: PreparedQuery[] = [];
  const prepare = vi.fn((sql: string) => {
    const call: PreparedQuery = { sql, bindings: [] };
    calls.push(call);
    return {
      bind: vi.fn((...bindings: Array<string | number | null>) => {
        call.bindings = bindings;
        return {
          all: vi.fn(async () => ({ results: rowSets.shift() ?? [] })),
        };
      }),
    };
  });

  return {
    env: { DB: { prepare } as unknown as D1Database } as Env,
    calls,
    prepare,
  };
}
type D1Row = Record<string, unknown>;
type Binding = string | number | null;
const PERFORMANCE_METRICS = ["ttfb", "fcp", "lcp", "cls", "inp"] as const;
function performanceWireRow(
  rowType: string,
  metric: string,
  values: {
    readonly bucket?: number | null;
    readonly pathname?: string | null;
    readonly country?: string | null;
    readonly views?: number | string | null;
    readonly samples?: number | string | null;
    readonly avgValue?: number | string | null;
    readonly p50?: number | null;
    readonly p75?: number | null;
    readonly p95?: number | null;
  } = {},
): D1Row {
  const stats = Object.fromEntries(
    PERFORMANCE_METRICS.flatMap((key) => [
      [`${key}Samples`, null],
      [`${key}AvgValue`, null],
      [`${key}P50`, null],
      [`${key}P75`, null],
      [`${key}P95`, null],
    ]),
  );
  return {
    rowType,
    metric,
    bucket: values.bucket ?? null,
    pathname: values.pathname ?? null,
    country: values.country ?? null,
    views: values.views ?? null,
    ...stats,
    [`${metric}Samples`]: values.samples,
    [`${metric}AvgValue`]: values.avgValue,
    [`${metric}P50`]: values.p50,
    [`${metric}P75`]: values.p75,
    [`${metric}P95`]: values.p95,
  };
}
class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Binding[],
  ) {}

  async all<T extends D1Row>(): Promise<{ results: T[] }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...this.bindings)
        .map((row) => ({ ...row }) as T),
    };
  }
}
class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: PreparedQuery[] = [];

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) => {
        this.calls.push({ sql, bindings });
        return new SqliteStatement(this.database, sql, bindings);
      },
    };
  }

  close(): void {
    this.database.close();
  }
}
function createSqlitePerformanceEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      visitor_id TEXT, session_id TEXT, status TEXT, started_at INTEGER,
      last_activity_at INTEGER, ended_at INTEGER, finalized_at INTEGER,
      duration_ms INTEGER, duration_source TEXT, exit_reason TEXT,
      pathname TEXT, query_string TEXT, hash_fragment TEXT, hostname TEXT,
      title TEXT, referrer_url TEXT, referrer_host TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT,
      utm_content TEXT, is_eu INTEGER, country TEXT, region TEXT,
      region_code TEXT, city TEXT, continent TEXT, latitude REAL,
      longitude REAL, postal_code TEXT, metro_code TEXT, timezone TEXT,
      as_organization TEXT, ua_raw TEXT, browser TEXT, browser_version TEXT,
      os TEXT, os_version TEXT, device_type TEXT, screen_width INTEGER,
      screen_height INTEGER, language TEXT, user_id TEXT, user_name TEXT,
      perf_ttfb_ms REAL,
      perf_fcp_ms REAL, perf_lcp_ms REAL, perf_cls REAL, perf_inp_ms REAL,
      ae_synced_at INTEGER
    );
    CREATE INDEX idx_visits_site_started_at
      ON visits(site_id, started_at);
  `);
  installVisitSiteIdentityFixture(d1.database);
  d1.database.exec(`
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL DEFAULT 1,
      visit_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      node_count INTEGER NOT NULL,
      value_count INTEGER NOT NULL,
      ae_synced_at INTEGER
    );
  `);
  return {
    env: {
      DB: d1 as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {},
    } as unknown as Env,
    d1,
  };
}
const siteId = "site-1";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 2, 1, 30),
  endExclusiveMs: Date.UTC(2026, 0, 2, 3, 5),
  nowMs: Date.UTC(2026, 0, 2, 3, 5),
  timeZone: "UTC",
};
const visitBindings = [siteId, window.startMs, window.endExclusiveMs];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCompilerObjectGraph(roots: Record<string, unknown>) {
  const ids = new WeakMap<object, string>();
  const objects: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  let nextId = 0;

  const schemaSummary = (value: Record<string, unknown>) => {
    const columns = isObjectRecord(value.columns)
      ? Object.entries(value.columns).map(([key, column]) => ({
          key,
          ...(isObjectRecord(column)
            ? {
                propertyName: column.propertyName,
                sqlName: column.sqlName,
                declaredType: column.declaredType,
                affinity: column.affinity,
                nullable: column.nullable,
                rowidAlias: column.rowidAlias ?? false,
                primaryKeyPosition: column.primaryKeyPosition,
                generated: column.generated,
                hidden: column.hidden,
              }
            : { value: column }),
        }))
      : [];
    return {
      kind: value.kind,
      name: value.name,
      defaultCollation: value.defaultCollation ?? null,
      primaryKey: value.primaryKey ?? [],
      columns,
      indexes: value.indexes ?? [],
      foreignKeys: value.foreignKeys ?? [],
    };
  };

  const reference = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : String(value);
    if (typeof value === "undefined") return { kind: "undefined" };
    if (typeof value === "symbol")
      return { kind: "symbol", description: value.description ?? null };
    if (typeof value === "function")
      return { kind: "function", name: value.name || null };
    if (typeof value !== "object") return String(value);

    const existing = ids.get(value);
    if (existing) return { ref: existing };
    const id = `o${nextId++}`;
    ids.set(value, id);
    objects[id] = null;

    if (Array.isArray(value)) {
      objects[id] = { kind: "array", items: value.map(reference) };
      return { ref: id };
    }
    if (value instanceof Map) {
      objects[id] = {
        kind: "map",
        entries: [...value.entries()].map(([key, item]) => [
          reference(key),
          reference(item),
        ]),
      };
      return { ref: id };
    }
    if (value instanceof Set) {
      objects[id] = { kind: "set", items: [...value].map(reference) };
      return { ref: id };
    }

    const record = value as Record<string, unknown>;
    const properties: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(record).sort()) {
      if (key === "__row") continue;
      const property = record[key];
      if (
        key === "table" &&
        isObjectRecord(property) &&
        (property.kind === "table" || property.kind === "view") &&
        typeof property.name === "string"
      ) {
        properties[key] = schemaSummary(property);
      } else {
        properties[key] = reference(property);
      }
    }
    objects[id] = {
      kind:
        typeof record.kind === "string"
          ? record.kind
          : value.constructor?.name || "object",
      properties,
    };
    return { ref: id };
  };

  const rootReferences = reference(roots);
  return {
    roots: rootReferences,
    objects,
    idOf(value: unknown) {
      return typeof value === "object" && value !== null
        ? (ids.get(value) ?? null)
        : null;
    },
  };
}

function compilerStructuralHash(value: unknown): string {
  const active = new WeakSet<object>();
  const localScopes = new WeakMap<object, number>();
  let nextScope = 0;
  const canonicalize = (current: unknown): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (typeof current === "number")
      return Number.isFinite(current) ? current : String(current);
    if (typeof current === "undefined") return { kind: "undefined" };
    if (typeof current === "symbol")
      return { kind: "symbol", description: current.description ?? null };
    if (typeof current === "function")
      return { kind: "function", name: current.name || null };
    if (typeof current !== "object") return String(current);
    if (Array.isArray(current)) return current.map(canonicalize);
    if (active.has(current))
      return {
        kind: "cycle",
        nodeKind:
          isObjectRecord(current) && typeof current.kind === "string"
            ? current.kind
            : "object",
      };
    active.add(current);
    try {
      const record = current as Record<string, unknown>;
      if (
        Object.hasOwn(record, "marker") &&
        typeof record.marker === "symbol"
      ) {
        let scope = localScopes.get(current);
        if (scope === undefined) {
          scope = nextScope++;
          localScopes.set(current, scope);
        }
        return { kind: "relation-scope", localScope: scope };
      }
      if (
        (record.kind === "table" || record.kind === "view") &&
        typeof record.name === "string"
      )
        return {
          kind: record.kind,
          name: record.name,
          primaryKey: record.primaryKey ?? [],
          columns: isObjectRecord(record.columns)
            ? Object.entries(record.columns).map(([name, column]) => ({
                name,
                ...(isObjectRecord(column)
                  ? {
                      declaredType: column.declaredType,
                      affinity: column.affinity,
                      nullable: column.nullable,
                      rowidAlias: column.rowidAlias ?? false,
                      primaryKeyPosition: column.primaryKeyPosition,
                    }
                  : { value: canonicalize(column) }),
              }))
            : [],
        };
      if (current instanceof Map)
        return [...current.entries()].map(([key, item]) => [
          canonicalize(key),
          canonicalize(item),
        ]);
      if (current instanceof Set) return [...current].map(canonicalize);
      return Object.fromEntries(
        Object.keys(record)
          .filter((key) => key !== "__row")
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    } finally {
      active.delete(current);
    }
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function summarizeCompilerPhysical(
  physical: unknown,
  graph: ReturnType<typeof createCompilerObjectGraph>,
) {
  if (!isObjectRecord(physical)) return null;
  const objectRef = (value: unknown) => ({ ref: graph.idOf(value) });
  const sharedRelations = Array.isArray(physical.sharedRelations)
    ? physical.sharedRelations.map((shared) => {
        if (!isObjectRecord(shared)) return shared;
        const node = shared.node;
        return {
          name: shared.name,
          materialization: shared.materialization,
          dependencies: shared.dependencies,
          scope: objectRef(shared.scope),
          fields: shared.fields,
          node: objectRef(node),
          structuralShapeSha256: compilerStructuralHash(node),
        };
      })
    : [];
  const summarizeChoice = (value: unknown) => {
    if (!isObjectRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "object" && item !== null ? objectRef(item) : item,
      ]),
    );
  };
  const choices = [
    "directScanProjections",
    "passthroughProjectFusions",
    "constantFilterJoinProjections",
    "positiveTupleMembershipCandidates",
    "joinOrderStrategies",
    "conditionalLookupChoices",
  ];
  return {
    root: objectRef(physical.root),
    scope: objectRef(physical.scope),
    fields: physical.fields,
    sharedRelations,
    choices: Object.fromEntries(
      choices.map((key) => [
        key,
        Array.isArray(physical[key]) ? physical[key].map(summarizeChoice) : [],
      ]),
    ),
    membershipOptimization: physical.membershipOptimization ?? null,
  };
}

function findVisitScans(
  roots: Record<string, unknown>,
  graph: ReturnType<typeof createCompilerObjectGraph>,
) {
  const results = new Map<
    string,
    { object: object; paths: string[]; fields: unknown; scope: unknown }
  >();
  const visit = (value: unknown, path: string, active: WeakSet<object>) => {
    if (typeof value !== "object" || value === null) return;
    if (active.has(value)) return;
    active.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, active));
    } else {
      const record = value as Record<string, unknown>;
      if (
        record.kind === "scan" &&
        isObjectRecord(record.table) &&
        record.table.name === "visits"
      ) {
        const id = graph.idOf(value) ?? `unindexed-${results.size}`;
        const previous = results.get(id);
        results.set(id, {
          object: value,
          paths: [...(previous?.paths ?? []), path],
          fields: record.fields,
          scope: record.scope,
        });
      }
      for (const key of Object.keys(record).sort()) {
        if (key === "table" || key === "__row") continue;
        visit(record[key], `${path}.${key}`, active);
      }
    }
    active.delete(value);
  };
  for (const [name, root] of Object.entries(roots))
    visit(root, name, new WeakSet());
  return [...results.entries()].map(([id, scan]) => ({
    objectId: id,
    paths: [...new Set(scan.paths)].slice(0, 64),
    fields: scan.fields,
    scopeObjectId: graph.idOf(scan.scope),
    structuralShapeSha256: compilerStructuralHash(scan.object),
  }));
}

describe("edge query performance D1 helpers", () => {
  it("maps metric summaries, leaves missing metrics empty, and binds filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          ttfbSamples: "4",
          ttfbAvgValue: "50.1234",
          ttfbP50: 40,
          ttfbP75: 60.9876,
          ttfbP95: 80.4567,
          lcpSamples: 8,
          lcpAvgValue: 123.4567,
          lcpP50: 100,
          lcpP75: 150.1114,
          lcpP95: 250.9999,
        },
      ],
    ]);
    const filters: FilterDocument = filterFixture({
      country: "US",
      hostname: "Example.COM",
      clientDeviceType: "desktop",
    });

    const result = await queryPerformanceSummariesFromD1(
      env,
      siteId,
      window,
      filters,
    );

    expect(result).toEqual({
      ttfb: { avg: 50.123, p50: 40, p75: 60.988, p95: 80.457, samples: 4 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: {
        avg: 123.457,
        p50: 100,
        p75: 150.111,
        p95: 251,
        samples: 8,
      },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('"visits"');
    expect(calls[0]?.sql).toContain("ROW_NUMBER() OVER");
    expect(calls[0]?.sql).toContain("COUNT(*) OVER");
    expect(calls[0]?.sql).toContain("perf_cls");
    expect(calls[0]?.bindings).toEqual(
      expect.arrayContaining([
        siteId,
        window.startMs,
        window.endExclusiveMs,
        "desktop",
        "us",
        "example.com",
      ]),
    );
  });

  it("normalizes sparse metric summary rows", async () => {
    const { env } = createD1Env([
      [
        {
          ttfbSamples: 0,
          ttfbAvgValue: null,
          ttfbP50: null,
          ttfbP75: null,
          ttfbP95: null,
        },
      ],
    ]);

    const result = await queryPerformanceSummariesFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
    );

    expect(result.ttfb).toEqual({
      avg: null,
      p50: null,
      p75: null,
      p95: null,
      samples: 0,
    });
    expect(result.fcp).toEqual({
      avg: null,
      p50: null,
      p75: null,
      p95: null,
      samples: 0,
    });
  });

  it("maps metric trend buckets and constrains the requested metric column", async () => {
    const { env, calls } = createD1Env([
      [
        {
          bucket: "0",
          samples: "3",
          avgValue: 100.3333,
          p50: 80,
          p75: 120.5555,
          p95: 250.9999,
        },
        {
          bucket: 1,
          samples: 5,
          avgValue: "200",
          p50: 190,
          p75: 220,
          p95: 250,
        },
      ],
    ]);

    const result = await queryPerformanceTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      filterFixture({ path: "/pricing" }),
      "lcp",
    );

    expect(result).toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        avg: 100.333,
        p50: 80,
        p75: 120.556,
        p95: 251,
        samples: 3,
      },
      {
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        avg: 200,
        p50: 190,
        p75: 220,
        p95: 250,
        samples: 5,
      },
    ]);
    expect(calls[0]?.sql).toContain("perf_lcp_ms");
    expect(calls[0]?.sql).toContain("ROW_NUMBER() OVER");
    expect(calls[0]?.sql).toContain("COUNT(*) OVER");
    expect(calls[0]?.sql).toContain("IS NOT NULL");
    expect(calls[0]?.sql).toContain("ORDER BY");
    expect(calls[0]?.bindings).toEqual(
      expect.arrayContaining([
        siteId,
        "/pricing",
        window.startMs,
        window.endExclusiveMs,
      ]),
    );
  });

  it("normalizes sparse metric trend rows", async () => {
    const { env } = createD1Env([
      [
        {
          bucket: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        },
      ],
    ]);

    await expect(
      queryPerformanceTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        "ttfb",
      ),
    ).resolves.toEqual([]);
  });

  it("queries and groups every metric trend in one D1 statement", async () => {
    const { env, calls } = createD1Env([
      [
        performanceWireRow("trend", "lcp", {
          bucket: 0,
          samples: 3,
          avgValue: 100.3333,
          p50: 80,
          p75: 120.5555,
          p95: 250.9999,
        }),
        performanceWireRow("trend", "ttfb", {
          bucket: 1,
          samples: 2,
          avgValue: 50,
          p50: 40,
          p75: 60,
          p95: 70,
        }),
        performanceWireRow("trend", "unknown", {
          bucket: 0,
          samples: 99,
        }),
      ],
    ]);

    const result = await queryAllPerformanceTrendsFromD1(
      env,
      siteId,
      window,
      "hour",
      filterFixture({ country: "US" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("UNION ALL");
    expect(calls[0]?.sql).toContain('AS "ttfbAvgValue"');
    expect(calls[0]?.sql).toContain('AS "clsP95"');
    expect(calls[0]?.bindings).toContain("us");
    expect(result.lcp).toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        avg: 100.333,
        p50: 80,
        p75: 120.556,
        p95: 251,
        samples: 3,
      },
    ]);
    expect(result.ttfb).toHaveLength(1);
    expect(result.fcp).toEqual([]);
    expect(result.cls).toEqual([]);
    expect(result.inp).toEqual([]);
  });

  it("groups route metrics by normalized pathname and preserves empty metric buckets", async () => {
    const { env, calls } = createD1Env([
      [
        performanceWireRow("route", "lcp", {
          pathname: " /pricing ",
          views: "9",
          samples: "3",
          avgValue: 100.4444,
          p50: 90,
          p75: 120,
          p95: 150,
        }),
        performanceWireRow("route", "ttfb", {
          pathname: "/pricing",
          views: 9,
          samples: 2,
          avgValue: 50,
          p50: 40,
          p75: 60,
          p95: 70,
        }),
        performanceWireRow("route", "fcp", {
          pathname: "",
          views: 2,
          samples: 1,
          avgValue: 80,
          p50: 80,
          p75: 80,
          p95: 80,
        }),
        performanceWireRow("route", "bad", {
          pathname: "/ignored",
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
      ],
    ]);

    const result = await queryPerformanceRoutesFromD1(
      env,
      siteId,
      window,
      filterFixture({ browser: "Chrome" }),
      2,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      pathname: "/pricing",
      views: 9,
      metrics: {
        ttfb: { avg: 50, p50: 40, p75: 60, p95: 70, samples: 2 },
        lcp: { avg: 100.444, p50: 90, p75: 120, p95: 150, samples: 3 },
        cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(result[1]).toMatchObject({
      pathname: "/",
      views: 2,
      metrics: {
        fcp: { avg: 80, p50: 80, p75: 80, p95: 80, samples: 1 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(calls[0]?.sql).toContain('AS "pathname"');
    expect(calls[0]?.sql).toContain('AS "views"');
    expect(calls[0]?.bindings).toContain("Chrome");
  });

  it("normalizes sparse route metric rows", async () => {
    const { env } = createD1Env([
      [
        performanceWireRow("route", "ttfb", {
          pathname: null,
          views: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        }),
        performanceWireRow("route", "bad", {
          pathname: "/ignored",
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
      ],
    ]);

    await expect(
      queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        1,
      ),
    ).resolves.toMatchObject([
      {
        pathname: "/",
        views: 0,
        metrics: {
          ttfb: {
            avg: 0,
            p50: null,
            p75: 0,
            p95: null,
            samples: 0,
          },
        },
      },
    ]);
  });

  it("groups country metrics by uppercase country and skips invalid rows", async () => {
    const { env, calls } = createD1Env([
      [
        performanceWireRow("country", "ttfb", {
          country: " us ",
          views: "6",
          samples: "3",
          avgValue: 30.3333,
          p50: 20,
          p75: 40,
          p95: 50,
        }),
        performanceWireRow("country", "cls", {
          country: "US",
          views: 6,
          samples: 1,
          avgValue: 0.1234,
          p50: 0.1,
          p75: 0.12,
          p95: 0.2,
        }),
        performanceWireRow("country", "fcp", {
          country: "ca",
          views: 2,
          samples: 1,
          avgValue: 111.1111,
          p50: 111.1111,
          p75: 111.1111,
          p95: 111.1111,
        }),
        performanceWireRow("country", "lcp", {
          country: "",
          views: 1,
          samples: 1,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
        performanceWireRow("country", "bad", {
          country: "MX",
          views: 1,
          samples: 1,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
      ],
    ]);

    const result = await queryPerformanceCountriesFromD1(
      env,
      siteId,
      window,
      filterFixture({
        geoContinent: "NA",
        geoOrganization: "Example ISP",
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      country: "US",
      views: 6,
      metrics: {
        ttfb: { avg: 30.333, p50: 20, p75: 40, p95: 50, samples: 3 },
        cls: { avg: 0.123, p50: 0.1, p75: 0.12, p95: 0.2, samples: 1 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(result[1]).toMatchObject({
      country: "CA",
      views: 2,
      metrics: {
        fcp: {
          avg: 111.111,
          p50: 111.111,
          p75: 111.111,
          p95: 111.111,
          samples: 1,
        },
      },
    });
    expect(calls[0]?.sql).toContain("UPPER(TRIM(COALESCE(");
    expect(calls[0]?.sql).toContain('AS "country"');
    expect(calls[0]?.bindings).toContain("na");
  });

  it("normalizes sparse country metric rows", async () => {
    const { env } = createD1Env([
      [
        performanceWireRow("country", "ttfb", {
          country: null,
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
        performanceWireRow("country", "bad", {
          country: "US",
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        }),
        performanceWireRow("country", "lcp", {
          country: "ca",
          views: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        }),
      ],
    ]);

    await expect(
      queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
      ),
    ).resolves.toMatchObject([
      {
        country: "CA",
        views: 0,
        metrics: {
          lcp: {
            avg: 0,
            p50: null,
            p75: 0,
            p95: null,
            samples: 0,
          },
        },
      },
    ]);
  });

  it("keeps Performance summaries compatible with the remaining legacy readers", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    const insert = d1.database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, started_at, pathname, country,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
      ) VALUES (?, 'site-1', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const at = (minutes: number) => Date.UTC(2026, 0, 2, 1, 30 + minutes);

    insert.run(
      "pricing-fast",
      at(5),
      "/pricing",
      "us",
      50,
      null,
      100,
      0.2,
      null,
    );
    insert.run(
      "pricing-slow",
      at(10),
      " /pricing ",
      "US",
      100,
      null,
      200,
      0.1,
      50,
    );
    insert.run("blog", at(40), "/blog", " ca ", 150, 80, 300, null, 100);
    insert.run(
      "pricing-without-performance",
      at(45),
      "/pricing",
      "US",
      null,
      null,
      null,
      null,
      null,
    );
    insert.run("unknown", at(50), "", "", null, null, null, null, null);
    insert.run("outside-window", at(-1), "/outside", "US", 1, 1, 1, 1, 1);
    insert.run(
      "end-exclusive",
      window.endExclusiveMs,
      "/excluded",
      "US",
      1,
      1,
      1,
      1,
      1,
    );

    try {
      await expect(
        queryPerformanceSummariesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
        ),
      ).resolves.toMatchObject({
        ttfb: { avg: 100, p50: 100, p75: 150, p95: 150, samples: 3 },
        lcp: { avg: 200, p50: 200, p75: 300, p95: 300, samples: 3 },
        fcp: { avg: 80, p50: 80, p75: 80, p95: 80, samples: 1 },
      });
      await expect(
        queryAllPerformanceTrendsFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
        ),
      ).resolves.toMatchObject({
        ttfb: [
          { bucket: 0, avg: 75, p50: 50, p75: 100, p95: 100, samples: 2 },
          { bucket: 1, avg: 150, p50: 150, p75: 150, p95: 150, samples: 1 },
        ],
      });
      await expect(
        queryPerformanceRoutesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          1,
        ),
      ).resolves.toMatchObject([
        {
          pathname: "/pricing",
          views: 3,
          metrics: {
            ttfb: { avg: 75, p50: 50, p75: 100, p95: 100, samples: 2 },
          },
        },
      ]);
      await expect(
        queryPerformanceCountriesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
        ),
      ).resolves.toMatchObject([
        {
          country: "US",
          views: 3,
          metrics: {
            lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 2 },
          },
        },
        {
          country: "CA",
          views: 1,
          metrics: {
            inp: { avg: 100, p50: 100, p75: 100, p95: 100, samples: 1 },
          },
        },
      ]);

      expect(d1.calls).toHaveLength(4);
      for (const call of d1.calls.slice(1)) {
        expect(call.sql).toContain("AS MATERIALIZED");
        const plan = d1.database
          .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
          .all(...call.bindings) as Array<{ detail: string }>;
        expect(
          plan.filter((row) =>
            row.detail.includes("idx_visits_site_pk_started_at"),
          ),
        ).toHaveLength(1);
      }

      reportCompilerBoundary.entries.length = 0;
      reportCompilerBoundary.enabled = true;
      let response: Response;
      try {
        response = await handlePerformance(
          env,
          siteId,
          new URL(
            `https://edge.test/performance?from=${window.startMs}&to=${window.endExclusiveMs}&interval=hour`,
          ),
        );
      } finally {
        reportCompilerBoundary.enabled = false;
      }
      const payload = (await response.json()) as {
        summaries: Record<string, { p50: number | null }>;
        trends: Record<string, Array<{ bucket: number; p50: number | null }>>;
        routes: Array<{ pathname: string; views: number }>;
        countries: Array<{ country: string; views: number }>;
      };
      expect(payload.summaries.ttfb).toMatchObject({ p50: 100 });
      expect(payload.trends.ttfb?.[0]).toMatchObject({ bucket: 0, p50: 50 });
      expect(payload.routes[0]).toMatchObject({
        pathname: "/pricing",
        views: 3,
      });
      expect(payload.countries[0]).toMatchObject({ country: "US", views: 3 });
      expect(d1.calls).toHaveLength(5);
      const dashboardPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${d1.calls[4]?.sql}`)
        .all(...(d1.calls[4]?.bindings ?? [])) as Array<{
        id: number;
        parent: number;
        notused: number;
        detail: string;
      }>;
      const performanceDiagnosticPath =
        process.env.INSIGHTFLARE_WAVE92D_PERF_DIAG_PATH;
      if (performanceDiagnosticPath) {
        const actual = d1.calls[4];
        if (!actual)
          throw new Error("wave92d_performance_dashboard_query_missing");
        const completePlan = dashboardPlan;
        const byId = new Map(completePlan.map((row) => [row.id, row]));
        const visitIndexUses = completePlan
          .filter((row) => row.detail.includes("idx_visits_site_pk_started_at"))
          .map((row) => {
            const ancestors: Array<{
              id: number;
              parent: number;
              detail: string;
            }> = [];
            let parentId = row.parent;
            for (let depth = 0; depth < completePlan.length; depth += 1) {
              const parent = byId.get(parentId);
              if (!parent) break;
              ancestors.push({
                id: parent.id,
                parent: parent.parent,
                detail: parent.detail,
              });
              if (parent.parent === parent.id) break;
              parentId = parent.parent;
            }
            return { row, ancestors };
          });
        const exactCaptures = reportCompilerBoundary.entries.filter(
          (entry) =>
            isObjectRecord(entry.compiledQuery) &&
            entry.compiledQuery.sql === actual.sql &&
            JSON.stringify(entry.compiledQuery.bindings) ===
              JSON.stringify(actual.bindings),
        );
        const exactCapture = exactCaptures[0] ?? null;
        const genericRelation = exactCapture?.genericRelation ?? null;
        const initialPhysical = exactCapture?.physicalPlan ?? null;
        const compilerInput = exactCapture?.compilerInput ?? null;
        const compilerOutput = exactCapture?.compiledQuery ?? null;
        const compilerOptions = exactCapture?.compilerOptions ?? null;
        const objectRoots = {
          genericRelation,
          initialPhysical,
          compilerInput,
        };
        const objectGraph = createCompilerObjectGraph(objectRoots);
        const visitScans = findVisitScans(objectRoots, objectGraph);
        const compilerResult = isObjectRecord(compilerOutput)
          ? compilerOutput
          : null;
        let recompiled: ReturnType<typeof database.compileD1Query> | null =
          null;
        let recompileError: string | null = null;
        if (initialPhysical && compilerOptions) {
          try {
            recompiled = database.compileD1Query(
              compilerInput as Parameters<typeof database.compileD1Query>[0],
              compilerOptions as Parameters<typeof database.compileD1Query>[1],
            );
          } catch (error) {
            recompileError =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
          }
        }
        const recompileMatches =
          recompiled && compilerResult
            ? {
                sql: recompiled.sql === actual.sql,
                bindings:
                  JSON.stringify(recompiled.bindings) ===
                  JSON.stringify(actual.bindings),
                physicalPlanShape:
                  JSON.stringify(recompiled.physicalPlanShape) ===
                  JSON.stringify(compilerResult.physicalPlanShape),
              }
            : null;
        const visitAliases = [
          ...actual.sql.matchAll(
            /FROM\s+"visits"\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/giu,
          ),
        ].map((match) => ({
          alias: match[1],
          sqlOffset: match.index,
        }));
        const sharedAliases = [
          ...actual.sql.matchAll(
            /(?:WITH|,)\s*(_d1_shared_[0-9]+)\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/giu,
          ),
        ].map((match) => ({
          name: match[1],
          sqlOffset: match.index,
        }));
        writeFileSync(
          performanceDiagnosticPath,
          JSON.stringify(
            {
              captureBoundary: "analytics-report-query.executeReportRelation",
              assertion: {
                expectedVisitsIndexUses: 1,
                actualVisitsIndexUses: visitIndexUses.length,
              },
              actual: {
                sql: actual.sql,
                bindings: actual.bindings,
                sqlBytes: Buffer.byteLength(actual.sql, "utf8"),
                sqlSha256: createHash("sha256")
                  .update(actual.sql)
                  .digest("hex"),
                visitAliases,
                sharedAliases,
                explainQueryPlan: completePlan,
                visitIndexUses,
              },
              compilerBoundary: {
                captureCountForExactD1Statement: exactCaptures.length,
                capturedCandidates: reportCompilerBoundary.entries.map(
                  (entry) => {
                    const query = isObjectRecord(entry.compiledQuery)
                      ? entry.compiledQuery
                      : null;
                    return {
                      genericRelationObjectId: objectGraph.idOf(
                        entry.genericRelation,
                      ),
                      physicalObjectId: objectGraph.idOf(entry.physicalPlan),
                      compilerInputObjectId: objectGraph.idOf(
                        entry.compilerInput,
                      ),
                      sqlBytes:
                        typeof query?.sql === "string"
                          ? Buffer.byteLength(query.sql, "utf8")
                          : null,
                      sqlSha256:
                        typeof query?.sql === "string"
                          ? createHash("sha256").update(query.sql).digest("hex")
                          : null,
                      bindingCount: Array.isArray(query?.bindings)
                        ? query.bindings.length
                        : null,
                    };
                  },
                ),
                compileOptions: compilerOptions,
                genericRelationObjectId: objectGraph.idOf(genericRelation),
                initialPhysicalObjectId: objectGraph.idOf(initialPhysical),
                compilerInputObjectId: objectGraph.idOf(compilerInput),
                sameInitialPhysicalPassedToCompiler:
                  initialPhysical === compilerInput,
                compilerResult: compilerResult
                  ? {
                      kind: compilerResult.kind,
                      tag: compilerResult.tag ?? null,
                      sqlBytes: Buffer.byteLength(actual.sql, "utf8"),
                      sqlSha256: createHash("sha256")
                        .update(actual.sql)
                        .digest("hex"),
                      bindingCount: actual.bindings.length,
                      bindings: actual.bindings,
                      physicalPlanShape:
                        compilerResult.physicalPlanShape ?? null,
                    }
                  : null,
                recompileError,
                recompileMatches,
              },
              initialPhysicalSummary: summarizeCompilerPhysical(
                initialPhysical,
                objectGraph,
              ),
              visitScanObjects: visitScans,
              objectGraph,
              exactCapture: {
                sqlEqualsD1Execution: compilerResult?.sql === actual.sql,
                bindingsEqualD1Execution:
                  JSON.stringify(compilerResult?.bindings) ===
                  JSON.stringify(actual.bindings),
              },
            },
            null,
            2,
          ) + "\n",
          { encoding: "utf8", flag: "wx" },
        );
        expect(exactCaptures).toHaveLength(1);
        expect(genericRelation).toBeTruthy();
        expect(initialPhysical).toBe(compilerInput);
        expect(recompileError).toBeNull();
        expect(recompileMatches).toEqual({
          sql: true,
          bindings: true,
          physicalPlanShape: true,
        });
      }
      expect(
        dashboardPlan.filter((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toHaveLength(1);
      expect(d1.calls[4]?.sql).toContain("_d1_shared_0 AS MATERIALIZED");
    } finally {
      d1.close();
    }
  });

  it("rejects invalid handlePerformance windows before querying D1", async () => {
    const { env, prepare } = createD1Env();

    const response = await handlePerformance(
      env,
      siteId,
      new URL("https://edge.test/performance?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serves the performance dashboard with one shared D1 statement", async () => {
    const { env, prepare } = createD1Env([
      [
        performanceWireRow("summary", "lcp", {
          samples: 3,
          avgValue: 150,
          p50: 100,
          p75: 200,
          p95: 200,
        }),
        performanceWireRow("trend", "lcp", {
          bucket: 0,
          samples: 2,
          avgValue: 150,
          p50: 100,
          p75: 200,
          p95: 200,
        }),
      ],
    ]);

    const response = await handlePerformance(
      env,
      siteId,
      new URL(
        "https://edge.test/performance?from=1767317400000&to=1767323100000&interval=hour",
      ),
    );

    expect(response.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summaries: {
        lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 3 },
      },
      trends: {
        lcp: [{ bucket: 0, avg: 150, p75: 200, samples: 2 }],
      },
    });
  });
});
