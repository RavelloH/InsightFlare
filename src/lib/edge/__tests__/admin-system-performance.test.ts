import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSystemPerformanceAdmin } from "@/lib/edge/admin-system";
import type { Env } from "@/lib/edge/types";

type QueryBinding = string | number | null;

describe("system performance trend query", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("materializes its event source once while preserving response data", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE visits (
        site_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      CREATE INDEX idx_visits_created_at_system_performance
        ON visits(created_at, site_id, started_at);
      CREATE TABLE custom_events (
        site_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_custom_events_created_at_system_performance
        ON custom_events(created_at, site_id, occurred_at);
      CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL
      );
    `);
    const nowMs = Date.UTC(2026, 0, 5, 12);
    const nowSec = Math.floor(nowMs / 1000);
    database
      .prepare("INSERT INTO sites (id, name, domain) VALUES (?, ?, ?)")
      .run("site-a", "Site A", "a.example.test");
    const insertVisit = database.prepare(
      "INSERT INTO visits VALUES (?, ?, ?, ?, ?)",
    );
    insertVisit.run(
      "site-a",
      nowMs - 2_000,
      nowSec - 2,
      "closed",
      nowMs - 2_000,
    );
    insertVisit.run("site-a", nowMs - 1_000, nowSec - 1, "open", nowMs - 1_000);
    database
      .prepare("INSERT INTO custom_events VALUES (?, ?, ?)")
      .run("site-a", nowMs - 3_000, nowSec - 1);

    const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            calls.push({ sql, bindings });
            return {
              first: async () =>
                (database.prepare(sql).get(...bindings) ?? null) as Record<
                  string,
                  unknown
                > | null,
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as Array<
                  Record<string, unknown>
                >,
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      const response = await handleSystemPerformanceAdmin(
        new Request("https://edge.test/api/private/admin/system-performance"),
        env,
        new URL(
          "https://edge.test/api/private/admin/system-performance?minutes=60",
        ),
        async () => ({ isAdmin: true }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: { totalEvents: 3, visits: 2, customEvents: 1 },
        topSites: [{ siteId: "site-a", totalEvents: 3 }],
      });

      const trendCall = calls.find((call) =>
        call.sql.includes("trend_aggregate AS"),
      );
      expect(trendCall?.sql).toContain("events AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${trendCall?.sql ?? "SELECT 1"}`)
        .all(...(trendCall?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING")),
      ).toHaveLength(1);
      expect(
        plan.filter((row) => row.detail.includes("SEARCH custom_events USING")),
      ).toHaveLength(1);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_created_at_system_performance"),
        ),
      ).toBe(true);
      expect(
        plan.some((row) =>
          row.detail.includes(
            "idx_custom_events_created_at_system_performance",
          ),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });
});
