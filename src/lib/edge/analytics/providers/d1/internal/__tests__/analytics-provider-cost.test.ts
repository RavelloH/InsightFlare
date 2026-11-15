// @vitest-environment node
import { readFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import {
  ANALYTICS_COST_SCENARIOS,
  executeAnalyticsCostScenario,
} from "./remote-d1/analytics-cost-scenarios";
import { inspectEntityMembershipPlan } from "./remote-d1/cost-guards";
import {
  observeCostDatabase,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

describe("Analytics provider cost scenarios on the real local SQLite engine", () => {
  const local = createMigratedDatabase();
  beforeAll(() => {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 160 }),
    ])
      local.exec(sql);
  });
  afterAll(() => local.close());
  it.each(ANALYTICS_COST_SCENARIOS)(
    "$name observes actual execution and SQL without fabricated costs",
    async (scenario) => {
      const trace = {
        preparedSql: [] as string[],
        bindings: [] as SQLInputValue[][],
      };
      const observed = observeCostDatabase(
        createSqliteD1Database(local, trace),
      );
      const result = await executeAnalyticsCostScenario(
        { DB: observed.database, MAIN_SECRET: "c01-secret" } as Env,
        scenario,
      );
      expect(result.value).toBeDefined();
      expect(result.actualStrategies.length).toBeGreaterThan(0);
      expect(result.coreCalls).toBe(0);
      const cost = summarizeCost(observed.observations);
      expect(cost).toMatchObject({
        metadataStatus: "unsupported",
        rowsRead: null,
        rowsWritten: null,
        sqlDurationMs: null,
      });
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.maxParameters).toBeLessThanOrEqual(100);
      expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
      if (
        scenario.family !== "pages" &&
        (!scenario.filterDsl ||
          scenario.name === "overview summary / session count + time")
      ) {
        const inspections = trace.preparedSql.flatMap((sql, index) => {
          if (!sql.includes('FROM "custom_events"')) return [];
          const plan = local
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...(trace.bindings[index] ?? []))
            .map((row) => ({
              id: Number(row.id),
              parent: Number(row.parent),
              detail: String(row.detail),
            }));
          return [inspectEntityMembershipPlan(sql, plan)];
        });
        expect(inspections.length, scenario.name).toBeGreaterThan(0);
        // Empty filters can eliminate the entity UNION entirely. The actual
        // remaining event membership must still have a complete indexed probe
        // or enumerate keys into a unique event lookup; neither an unrelated
        // IN nor the absence of UNION establishes that property.
        for (const inspection of inspections) {
          expect(inspection.violations, scenario.name).toEqual([]);
        }
        expect(
          inspections.reduce(
            (sum, inspection) => sum + inspection.protectedMemberships,
            0,
          ),
          scenario.name,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("rejects the actual former internal UNION membership despite unrelated list lookups", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./remote-d1/fixtures/events-membership-before.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { sql: string; params: SQLInputValue[] };
    // Add an unrelated list predicate to demonstrate why any-IN checks miss it.
    const sql = `${fixture.sql} WHERE l11._c3 IN (SELECT event_id || '' FROM custom_events)`;
    expect(local.prepare(sql).all(...fixture.params).length).toBeGreaterThan(0);
    const plan = local
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...fixture.params)
      .map((row) => ({
        id: Number(row.id),
        parent: Number(row.parent),
        detail: String(row.detail),
      }));
    expect(plan.some((row) => row.detail.includes("LIST SUBQUERY"))).toBe(true);
    const result = inspectEntityMembershipPlan(sql, plan);
    expect(result.unionKeySets).toBeGreaterThan(0);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        reason: "union-key-outer-loop-repeats-event-window",
      }),
    );
  });

  it("rejects the former outer event-key scan after internal UNION membership is protected", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./remote-d1/fixtures/overview-membership-before.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { sql: string; params: SQLInputValue[] };
    expect(
      local.prepare(fixture.sql).all(...fixture.params).length,
    ).toBeGreaterThan(0);
    const plan = local
      .prepare(`EXPLAIN QUERY PLAN ${fixture.sql}`)
      .all(...fixture.params)
      .map((row) => ({
        id: Number(row.id),
        parent: Number(row.parent),
        detail: String(row.detail),
      }));
    const result = inspectEntityMembershipPlan(fixture.sql, plan);
    expect(result.listProtectedUnions).toBeGreaterThan(0);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        reason: "materialized-event-key-set-repeats-event-window",
      }),
    );
  });

  it("preserves complete DTOs when another site reuses the session and visitor IDs", async () => {
    const scenarios = ANALYTICS_COST_SCENARIOS.filter(
      (scenario) => scenario.family !== "pages" && !scenario.filterDsl,
    );
    const env = {
      DB: createSqliteD1Database(local),
      MAIN_SECRET: "c01-secret",
    } as Env;
    const before = [];
    for (const scenario of scenarios)
      before.push((await executeAnalyticsCostScenario(env, scenario)).value);
    local.exec("SAVEPOINT other_site");
    try {
      local.exec(
        "INSERT INTO site_identities(site_pk, site_id) VALUES(2, 'other-site')",
      );
      local.exec(
        "INSERT INTO sites(id, team_id, name, domain) VALUES('other-site', 'c01-team', 'other', 'other.invalid')",
      );
      for (const table of [
        "visits",
        "custom_event_names",
        "custom_events",
      ] as const) {
        const columns = local
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String(row.name))
          .filter((name) => name !== "event_pk");
        const values = columns.map((name) => {
          if (name === "site_pk") return "2";
          if (name === "site_id") return "'other-site'";
          if (name === "visit_id" || name === "event_id")
            return `'other-' || "${name}"`;
          if (
            (table === "custom_event_names" && name === "id") ||
            name === "event_name_id"
          )
            return `"${name}" + 100`;
          return `"${name}"`;
        });
        local.exec(
          `INSERT INTO ${table} (${columns.map((name) => `"${name}"`).join(",")}) SELECT ${values.join(",")} FROM ${table} WHERE site_pk = 1`,
        );
      }
      for (const [index, scenario] of scenarios.entries())
        expect(
          (await executeAnalyticsCostScenario(env, scenario)).value,
          scenario.name,
        ).toEqual(before[index]);
    } finally {
      local.exec("ROLLBACK TO other_site; RELEASE other_site");
    }
  });

  it("preserves event bags and empty-set DTOs through membership", async () => {
    const scenarios = ANALYTICS_COST_SCENARIOS.filter(
      (scenario) => scenario.family === "events" && !scenario.filterDsl,
    );
    const env = {
      DB: createSqliteD1Database(local),
      MAIN_SECRET: "c01-secret",
    } as Env;
    function doubled(value: unknown, key = ""): unknown {
      if (
        typeof value === "number" &&
        ["views", "events", "totalEvents", "avgEventsPerSession"].includes(key)
      )
        return value * 2;
      if (Array.isArray(value)) return value.map((item) => doubled(item));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            key === "eventsBySeries" ? Number(item) * 2 : doubled(item, name),
          ]),
        );
      return value;
    }
    const before = [];
    for (const scenario of scenarios)
      before.push((await executeAnalyticsCostScenario(env, scenario)).value);
    local.exec("SAVEPOINT event_bag");
    try {
      const columns = local
        .prepare("PRAGMA table_info(custom_events)")
        .all()
        .map((row) => String(row.name))
        .filter((name) => name !== "event_pk");
      local.exec(
        `INSERT INTO custom_events (${columns.map((name) => `"${name}"`).join(",")}) SELECT ${columns.map((name) => (name === "event_id" ? "'copy-' || event_id" : `"${name}"`)).join(",")} FROM custom_events`,
      );
      for (const [index, scenario] of scenarios.entries())
        expect(
          (await executeAnalyticsCostScenario(env, scenario)).value,
          scenario.name,
        ).toEqual(doubled(before[index]));
      local.exec("DELETE FROM custom_events; DELETE FROM visits");
      for (const scenario of scenarios) {
        const value = (await executeAnalyticsCostScenario(env, scenario)).value;
        if (scenario.operation === "event-summary")
          expect(value).toEqual({
            summary: {
              events: 0,
              eventTypes: 0,
              sessions: 0,
              visitors: 0,
              avgEventsPerSession: 0,
            },
            cards: {
              event: { name: [] },
              page: { path: [], title: [], hostname: [] },
            },
          });
        else if (scenario.operation === "event-types")
          expect(value).toEqual({
            items: [],
            pagination: {
              limit: 20,
              returned: 0,
              hasMore: false,
              nextCursor: null,
            },
          });
        else {
          const baseline = before[2] as unknown as {
            data: { bucket: number; timestampMs: number }[];
          };
          expect(value).toEqual({
            interval: "day",
            series: [],
            data: baseline.data.map(({ bucket, timestampMs }) => ({
              bucket,
              timestampMs,
              totalEvents: 0,
              eventsBySeries: {},
            })),
          });
        }
      }
    } finally {
      local.exec("ROLLBACK TO event_bag; RELEASE event_bag");
    }
  });
});
