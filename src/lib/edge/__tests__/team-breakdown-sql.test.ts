import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { queryDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryTeamDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/team";
import type { Env } from "@/lib/edge/types";

const window = {
  startMs: 1_000,
  endExclusiveMs: 5_000,
  nowMs: 5_000,
  timeZone: "UTC",
};
const siteIds = ["site-1", "site-2"];

function makeDatabase() {
  const database = new DatabaseSync(":memory:");
  const columns = VISIT_SOURCE_COLUMNS.split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  database.exec(`
    CREATE TABLE site_identities (
      site_id TEXT PRIMARY KEY, site_pk INTEGER NOT NULL UNIQUE
    );
    CREATE TABLE visits (
      ${columns
        .map((column) =>
          column === "site_pk" || column === "started_at"
            ? `${column} INTEGER`
            : `${column} TEXT`,
        )
        .join(",\n")}
    );
    CREATE INDEX idx_visits_site_pk_started_at
      ON visits(site_pk, started_at);
    CREATE TABLE custom_event_names (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT,
      site_id TEXT,
      site_pk INTEGER,
      visit_id TEXT,
      event_name_id INTEGER,
      occurred_at INTEGER,
      received_at INTEGER,
      sequence INTEGER,
      node_count INTEGER,
      value_count INTEGER
    );
  `);
  const identity = database.prepare(
    "INSERT INTO site_identities (site_id, site_pk) VALUES (?, ?)",
  );
  for (const [index, site] of ["site-1", "site-2", "site-3"].entries()) {
    identity.run(site, index + 1);
  }
  const insert = database.prepare(
    "INSERT INTO visits (site_id, site_pk, visit_id, started_at, pathname, country, session_id, visitor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("site-1", 1, "one", 1_100, "/pricing", "CN", "shared", "shared");
  insert.run("site-1", 1, "two", 1_200, "/pricing", "CN", "shared", "shared");
  insert.run(
    "site-1",
    1,
    "qualifying",
    1_250,
    "/docs",
    "US",
    "shared",
    "shared",
  );
  insert.run("site-2", 2, "three", 1_300, "/pricing", "CN", "shared", "shared");
  insert.run("site-2", 2, "four", 1_400, "/docs", "US", "other", "other");
  insert.run("site-2", 2, "five", 1_500, "/no-identity", "JP", "", "");
  insert.run("site-1", 1, "empty", 1_600, "", "", "empty", "empty");
  insert.run(
    "site-3",
    3,
    "unauthorized",
    1_700,
    "/pricing",
    "CN",
    "not-allowed",
    "not-allowed",
  );
  insert.run(
    "site-1",
    1,
    "outside-window",
    6_000,
    "/pricing",
    "CN",
    "outside",
    "outside",
  );
  const preparedSql: string[] = [];
  const bindings: (string | number | null)[][] = [];
  const env = {
    DB: createSqliteD1Database(database, { preparedSql, bindings }),
  } as Env;
  return { database, env, preparedSql, bindings };
}

describe("team dimension SQL batching", () => {
  it.each(["geo.country", "page.path"] as const)(
    "matches the per-site precise identity sum for %s in one D1 statement",
    async (dimension) => {
      const { database, env, preparedSql, bindings } = makeDatabase();
      try {
        const expression = resolveCrossBreakdownDimension(dimension)!.labelExpr;
        const oldRows = await Promise.all(
          siteIds.map((siteId) =>
            queryDimensionFromD1(
              env,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              0,
              expression,
              { excludeEmpty: true },
            ),
          ),
        );
        const expected = new Map<
          string,
          { value: string; views: number; sessions: number; visitors: number }
        >();
        for (const rows of oldRows) {
          for (const row of rows) {
            const prev = expected.get(row.value);
            expected.set(row.value, {
              value: row.value,
              views: (prev?.views ?? 0) + row.views,
              sessions: (prev?.sessions ?? 0) + row.sessions,
              visitors: (prev?.visitors ?? 0) + row.visitors,
            });
          }
        }

        const before = preparedSql.length;
        const actual = await queryTeamDimensionFromD1(
          env,
          siteIds,
          window,
          EMPTY_FILTER_DOCUMENT,
          expression,
        );
        expect(preparedSql.length - before).toBe(1);
        expect(actual).toEqual(
          [...expected.values()].sort(
            (a, b) => b.views - a.views || a.value.localeCompare(b.value),
          ),
        );
        expect(
          actual.find(
            (row) =>
              row.value === (dimension === "geo.country" ? "CN" : "/pricing"),
          ),
        ).toMatchObject({
          views: 3,
          sessions: 2,
          visitors: 2,
        });
        const plan = database
          .prepare("EXPLAIN QUERY PLAN " + preparedSql.at(-1))
          .all(...bindings.at(-1)!) as Array<{ detail: string }>;
        expect(
          plan.some((row) =>
            row.detail.includes(
              "SEARCH visits USING INDEX idx_visits_site_pk_started_at",
            ),
          ),
        ).toBe(true);
      } finally {
        database.close();
      }
    },
  );

  it("splits large teams by D1 binding budget and merges exact totals", async () => {
    const allSites = Array.from({ length: 101 }, (_, i) => "s-" + i);
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...bindings: unknown[]) {
              calls.push({ sql, bindings });
              return {
                async all() {
                  return {
                    results: [
                      { value: "US", views: 2, sessions: 1, visitors: 1 },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    await expect(
      queryTeamDimensionFromD1(
        env,
        allSites,
        window,
        EMPTY_FILTER_DOCUMENT,
        "TRIM(COALESCE(country, ''))",
      ),
    ).resolves.toEqual([{ value: "US", views: 4, sessions: 2, visitors: 2 }]);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.bindings.length)).toEqual([100, 5]);
    expect(calls[0]!.sql).toContain("GROUP BY site_pk, value");
  });

  it("returns immediately without a D1 query when there are no sites", async () => {
    const { database, env, preparedSql } = makeDatabase();
    try {
      await expect(
        queryTeamDimensionFromD1(
          env,
          [],
          window,
          EMPTY_FILTER_DOCUMENT,
          "TRIM(COALESCE(country, ''))",
        ),
      ).resolves.toEqual([]);
      expect(preparedSql).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

describe("team dimension scoped-filter batching", () => {
  it("compiles prepared filters once for the authorized multi-site scope", async () => {
    const prepared = prepareScopedQuery("team-dashboard", {
      context: teamQueryContext("team-1", "private-dashboard", siteIds),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      } as unknown as QueryTime,
      filters: {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: "/pricing",
        },
      },
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });
    const filters = prepared.filters!;
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...bindings: unknown[]) {
              calls.push({ sql, bindings });
              return {
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    await expect(
      queryTeamDimensionFromD1(
        env,
        siteIds,
        window,
        filters,
        "TRIM(COALESCE(pathname, ''))",
      ),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("scope_final_visits");
    expect(calls[0]!.sql).toContain("GROUP BY site_pk, value");
    expect(
      calls[0]!.bindings.filter((value) => value === "site-1"),
    ).toHaveLength(2);
    expect(
      calls[0]!.bindings.filter((value) => value === "site-2"),
    ).toHaveLength(2);
    expect(calls[0]!.bindings.length).toBeLessThanOrEqual(100);
  });
});

describe("prepared session-scope isolation", () => {
  it("does not leak a qualifying session to another site with the same session ID", async () => {
    const { database, env, preparedSql } = makeDatabase();
    try {
      const prepared = prepareScopedQuery("team-dashboard", {
        context: teamQueryContext("team-1", "private-dashboard", siteIds),
        time: {
          range: {
            startMs: window.startMs,
            endExclusiveMs: window.endExclusiveMs,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: window.nowMs,
        } as unknown as QueryTime,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: "/docs",
          },
        },
        scopePreference: "session",
      } as QueryInput & { time: QueryTime });
      const filters = prepared.filters!;
      const expression = resolveCrossBreakdownDimension("page.path")!.labelExpr;
      const oldRows = await Promise.all(
        siteIds.map((siteId) =>
          queryDimensionFromD1(env, siteId, window, filters, 0, expression, {
            excludeEmpty: true,
          }),
        ),
      );
      const previousCalls = preparedSql.length;
      const combined = await queryTeamDimensionFromD1(
        env,
        siteIds,
        window,
        filters,
        expression,
      );
      expect(preparedSql.length - previousCalls).toBe(1);
      const expected = new Map<
        string,
        { views: number; sessions: number; visitors: number }
      >();
      for (const rows of oldRows) {
        for (const row of rows) {
          const prior = expected.get(row.value);
          expected.set(row.value, {
            views: (prior?.views ?? 0) + row.views,
            sessions: (prior?.sessions ?? 0) + row.sessions,
            visitors: (prior?.visitors ?? 0) + row.visitors,
          });
        }
      }
      expect(
        combined.map(({ value, views, sessions, visitors }) => [
          value,
          views,
          sessions,
          visitors,
        ]),
      ).toEqual(
        [...expected]
          .sort((a, b) => b[1].views - a[1].views || a[0].localeCompare(b[0]))
          .map(([value, item]) => [
            value,
            item.views,
            item.sessions,
            item.visitors,
          ]),
      );
      expect(combined).toHaveLength(2);
      expect(combined.find((row) => row.value === "/pricing")).toMatchObject({
        views: 2,
        sessions: 1,
        visitors: 1,
      });
      expect(combined.find((row) => row.value === "/docs")).toMatchObject({
        views: 2,
        sessions: 2,
        visitors: 2,
      });
    } finally {
      database.close();
    }
  });
});
