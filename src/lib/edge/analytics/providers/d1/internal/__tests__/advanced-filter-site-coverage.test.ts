import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { siteCoverage } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-site-coverage";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const databases = new Set<DatabaseSync>();

function createFixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  // Leave created_at without an affinity or NOT NULL constraint so the test
  // can model reachable historical values that violate current declarations.
  database.exec(`
    CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'team',
      name TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      public_enabled INTEGER NOT NULL DEFAULT 0,
      public_slug TEXT,
      created_at,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  return database;
}

function addSite(
  database: DatabaseSync,
  siteId: string,
  createdAt: SQLInputValue,
): void {
  database
    .prepare("INSERT INTO sites (id, created_at) VALUES (?, ?)")
    .run(siteId, createdAt);
}

function testEnv(database: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: database,
    INGEST_DO: {} as DurableObjectNamespace,
    ...extra,
  } as Env;
}

function legacySiteCoverage(
  database: DatabaseSync,
  siteIds: readonly string[],
): { readonly coverage: Map<string, number>; readonly queries: string[] } {
  const coverage = new Map<string, number>();
  const queries: string[] = [];
  for (let index = 0; index < siteIds.length; index += 90) {
    const chunk = siteIds.slice(index, index + 90);
    const sql = `SELECT id AS siteId, created_at AS createdAtSeconds FROM sites WHERE id IN (${chunk.map(() => "?").join(", ")})`;
    queries.push(sql);
    const rows = database.prepare(sql).all(...chunk) as Array<{
      readonly siteId: string;
      readonly createdAtSeconds: unknown;
    }>;
    for (const row of rows) {
      if (typeof row.createdAtSeconds === "number")
        coverage.set(row.siteId, Math.trunc(row.createdAtSeconds * 1_000));
    }
  }
  return { coverage, queries };
}

function createAllOnlyDatabase(
  onAll: (
    sql: string,
    bindings: readonly SQLInputValue[],
  ) => Promise<D1Result<object>>,
  preparedSql: string[],
): D1Database {
  return {
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        bind(...bindings: SQLInputValue[]) {
          return {
            all: <Row extends object>() =>
              onAll(sql, bindings) as Promise<D1Result<Row>>,
          } as D1PreparedStatement;
        },
      } as D1PreparedStatement;
    },
    batch: async () => [],
  } as unknown as D1Database;
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("advanced filter site coverage", () => {
  it("matches legacy behavior for whitespace, Unicode, quotes, duplicates, missing and malformed timestamps", async () => {
    const database = createFixture();
    addSite(database, " leading and trailing ", 1.2349);
    addSite(database, "引号'与雪🌍", 2);
    addSite(database, "duplicate", 3.9999);
    addSite(database, "null-created-at", null);
    addSite(database, "text-created-at", "4");
    const siteIds = [
      " leading and trailing ",
      "引号'与雪🌍",
      "duplicate",
      "duplicate",
      "missing",
      "null-created-at",
      "text-created-at",
    ];
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const diagnostics = createD1ReadDiagnostics();
    const expected = legacySiteCoverage(database, siteIds);
    const actual = await siteCoverage(
      testEnv(createSqliteD1Database(database, trace)),
      siteIds,
      diagnostics,
    );

    expect(actual).toEqual(expected.coverage);
    expect(actual).toEqual(
      new Map([
        [" leading and trailing ", 1_234],
        ["引号'与雪🌍", 2_000],
        ["duplicate", 3_999],
      ]),
    );
    expect(trace.preparedSql).toHaveLength(expected.queries.length);
    expect(trace.bindings).toEqual([siteIds]);
    expect(trace.preparedSql[0]).not.toContain("引号");
    expect(trace.preparedSql[0]).not.toContain(" leading and trailing ");
    expect(diagnostics).toMatchObject({
      rowsRead: 0,
      rowsReadAvailable: false,
    });
  });

  it("preserves the 90-id chunk count and result across 90, 91 and multi-chunk inputs", async () => {
    const database = createFixture();
    const allSiteIds = Array.from(
      { length: 181 },
      (_unused, index) => `site-${index.toString().padStart(3, "0")}`,
    );
    allSiteIds.forEach((siteId, index) =>
      addSite(database, siteId, index + 0.25),
    );

    for (const count of [90, 91, 181]) {
      const siteIds = allSiteIds.slice(0, count);
      const expected = legacySiteCoverage(database, siteIds);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const actual = await siteCoverage(
        testEnv(createSqliteD1Database(database, trace)),
        siteIds,
      );

      expect(actual).toEqual(expected.coverage);
      expect(trace.preparedSql).toHaveLength(expected.queries.length);
      expect(trace.bindings.map((bindings) => bindings.length)).toEqual(
        count === 90 ? [90] : count === 91 ? [90, 1] : [90, 90, 1],
      );
      expect(
        trace.bindings.every(
          (bindings) => bindings.length <= D1_MAX_BOUND_PARAMETERS,
        ),
      ).toBe(true);
      expect(
        trace.preparedSql.every(
          (sql) =>
            new TextEncoder().encode(sql).byteLength <= D1_MAX_SQL_UTF8_BYTES,
        ),
      ).toBe(true);
      expect(
        trace.preparedSql.every((sql) => sql.includes('FROM "sites"')),
      ).toBe(true);
    }
  });

  it("keeps abort checks between sequential chunks and propagates DB failures", async () => {
    const siteIds = Array.from(
      { length: 91 },
      (_unused, index) => `site-${index}`,
    );
    const controller = new AbortController();
    const preparedSql: string[] = [];
    const abortingDatabase = createAllOnlyDatabase(async () => {
      controller.abort();
      return {
        success: true,
        results: [],
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }, preparedSql);

    await expect(
      siteCoverage(
        testEnv(abortingDatabase),
        siteIds,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preparedSql).toHaveLength(1);

    const failure = new Error("site coverage read failed");
    const failingSql: string[] = [];
    const failingDatabase = createAllOnlyDatabase(
      async () => Promise.reject(failure),
      failingSql,
    );
    await expect(siteCoverage(testEnv(failingDatabase), siteIds)).rejects.toBe(
      failure,
    );
    expect(failingSql).toHaveLength(1);

    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedSql: string[] = [];
    await expect(
      siteCoverage(
        testEnv(
          createAllOnlyDatabase(
            async () => ({
              success: true,
              results: [],
              meta: {
                duration: 0,
                size_after: 0,
                rows_read: 0,
                rows_written: 0,
                last_row_id: 0,
                changed_db: false,
                changes: 0,
              },
            }),
            preAbortedSql,
          ),
        ),
        siteIds,
        undefined,
        preAborted.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortedSql).toHaveLength(0);
  });

  it("records one typed statement per chunk with diagnostics and the active operation tag", async () => {
    const database = createFixture();
    addSite(database, "observed-site", 2.5);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const diagnostics = createD1ReadDiagnostics();
    const env = instrumentEnv(
      testEnv(createSqliteD1Database(database, trace)),
      logger,
    );

    await runWithInvocationLogger(logger, () =>
      runWithD1Operation("advanced_filter.site_coverage", () =>
        siteCoverage(env, ["observed-site"], diagnostics),
      ),
    );
    const record = await logger.emitWhenComplete();
    const observation = record.logs.find((event) =>
      event.message.startsWith("db.query.v1.all.success"),
    );

    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings).toHaveLength(1);
    expect(observation?.data).toMatchObject({
      tag: "advanced_filter.site_coverage",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      bindings: 1,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(
      record.performance.operations?.["advanced_filter.site_coverage"],
    ).toMatchObject({
      d1Statements: 1,
      d1RowsReadAvailable: false,
    });
    expect(diagnostics).toMatchObject({
      rowsRead: 0,
      rowsReadAvailable: false,
    });
  });
});
