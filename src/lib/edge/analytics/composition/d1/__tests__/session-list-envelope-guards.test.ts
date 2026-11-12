import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { CanonicalQuery, QueryInput } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { executeSessionListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-program";
import { deferredSessionListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "session-list-envelope-guards";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const FILTER_DSL =
  'page.path eq "/match" and count(page { page.path eq "/match" }) gte 1';

type Row = Record<string, unknown>;

function seedFixture(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const site = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'guards-team', 'Envelope guards', 'baseline.test', 0)`,
    )
    .run(SITE_ID);
  const insert = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'baseline.test')`,
  );
  for (const [index, id] of ["one", "two"].entries()) {
    insert.run(
      `visit-${id}`,
      SITE_ID,
      Number(site.site_pk),
      `visitor-${id}`,
      `session-${id}`,
      BASE + 1_000 * (index + 1),
      BASE + 1_000 * (index + 1) + 400,
      "/match",
    );
  }
}

/** Replaces the whole envelope result set returned by the qualification query. */
function d1WithEnvelopeResults(
  database: DatabaseSync,
  rewrite: (results: Row[]) => unknown,
): NonNullable<Env["DB"]> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const base = createSqliteD1Database(database, trace);
  const proxy = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      const prepared = {
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return prepared;
        },
        first<R>() {
          return statement.first<R>();
        },
        async all<R>() {
          const result = await statement.all<R>();
          if (!sql.includes('"rowKind"') || !sql.includes('"outputId"'))
            return result;
          return {
            ...result,
            results: rewrite(result.results as Row[]) as R[],
          };
        },
        run() {
          return statement.run();
        },
      };
      return prepared;
    },
    batch(statements: Parameters<typeof base.batch>[0]) {
      return base.batch(statements);
    },
  };
  return proxy as unknown as NonNullable<Env["DB"]>;
}

async function execute(rewrite: (results: Row[]) => unknown) {
  const database = createMigratedDatabase();
  try {
    seedFixture(database);
    const env = {
      DB: d1WithEnvelopeResults(database, rewrite),
      MAIN_SECRET: "session-list-envelope-guards-secret",
    } as unknown as Env;
    const request = {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: createQueryTime(BASE, END, "UTC", END),
      filters: parseFilterDsl(FILTER_DSL, analyticsFilterRegistry),
      scopePreference: "session",
      page: { limit: 5, cursor: null },
      search: "baseline.test",
      sort: { key: "startedAt", direction: "desc" },
    } as unknown as CanonicalQuery<"sessions">;
    const prepared = prepareScopedQuery(
      "sessions",
      request,
    ) as unknown as QueryInput & Record<string, unknown>;
    let query: (QueryInput & Record<string, unknown>) | undefined;
    await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
      "sessions",
      prepared,
      async (next) => {
        query = next as QueryInput & Record<string, unknown>;
        return next;
      },
    );
    const deferred = deferredSessionListQualificationFromQuery(query!);
    return await executeSessionListQualificationProgram({
      query: query!,
      deferred: deferred!,
      env,
    });
  } finally {
    database.close();
  }
}

const mapRows =
  (transform: (row: Row, index: number) => unknown) => (results: Row[]) =>
    results.map(transform);

describe("session list qualification envelope guards", () => {
  it("accepts the untouched envelope as the executed baseline", async () => {
    const result = await execute((results) => results);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      expect(result.controlRowCount).toBe(1);
      expect(result.result.items.map((item) => item.sessionId).sort()).toEqual([
        "session-one",
        "session-two",
      ]);
    }
  });

  it.each([null, 7, "row", []])(
    "rejects the non-record envelope row %j",
    async (bad) => {
      await expect(
        execute(mapRows((_row, index) => (index === 0 ? bad : _row))),
      ).rejects.toThrow("session_list_qualification_envelope_row_invalid");
    },
  );

  it("rejects rows whose own keys cannot be enumerated", async () => {
    await expect(
      execute(
        mapRows(
          () =>
            new Proxy(
              {},
              {
                ownKeys() {
                  throw new Error("hostile ownKeys");
                },
              },
            ),
        ),
      ),
    ).rejects.toThrow("session_list_qualification_envelope_row_invalid");
  });

  it("rejects rows with extra, symbol or accessor columns", async () => {
    await expect(
      execute(mapRows((row) => ({ ...row, extra: 1 }))),
    ).rejects.toThrow("session_list_qualification_envelope_row_schema_invalid");

    await expect(
      execute(mapRows((row) => ({ ...row, [Symbol("hidden")]: 1 }))),
    ).rejects.toThrow("session_list_qualification_envelope_row_schema_invalid");

    await expect(
      execute(
        mapRows((row) => {
          const hostile: Row = { ...row };
          Object.defineProperty(hostile, "rowKind", {
            enumerable: true,
            get: () => row.rowKind,
          });
          return hostile;
        }),
      ),
    ).rejects.toThrow("session_list_qualification_envelope_row_schema_invalid");
  });

  it("requires exactly one control row", async () => {
    await expect(
      execute((results) => results.filter((row) => row.rowKind !== "control")),
    ).rejects.toThrow("session_list_qualification_control_row_invalid");
    await expect(
      execute((results) => {
        const control = results.find((row) => row.rowKind === "control")!;
        return [...results, control];
      }),
    ).rejects.toThrow("session_list_qualification_control_row_invalid");
  });

  it("rejects control rows of another entity kind and report rows of another output", async () => {
    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "control" ? { ...row, entityKind: "visitor" } : row,
        ),
      ),
    ).rejects.toThrow("session_list_qualification_control_kind_mismatch");

    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "report" ? { ...row, outputId: "other-output" } : row,
        ),
      ),
    ).rejects.toThrow("session_list_qualification_report_row_invalid");
  });

  it("rejects report rows that carry control values", async () => {
    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "report" ? { ...row, rawCount: 1 } : row,
        ),
      ),
    ).rejects.toThrow("session_list_qualification_report_row_invalid");
  });
});
