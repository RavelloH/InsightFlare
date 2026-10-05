import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { handleRetentionContract as handleRetention } from "@/lib/edge/analytics/interfaces/dashboard/protocol/analysis";
import {
  parseLimit,
  parseQueryLimit,
  parseSessionListSort,
  parseVisitorListSort,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import { normalizePathname } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  browserMajorVersionExpr,
  clientDimensionDefinition,
  formatPageLabel,
  referrerDomainDimensionDefinition,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import type { Env } from "@/lib/edge/types";
type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;
interface QueryCall {
  kind: "all" | "first";
  sql: string;
  bindings: QueryBinding[];
}
const siteId = "site-team-retention";
const baseMs = Date.UTC(2026, 0, 5, 0);
const window = {
  startMs: baseMs,
  endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};
function createD1Env(resultSets: D1Row[][], firstRows: D1Row[] = []) {
  const calls: QueryCall[] = [];
  const pendingAll = [...resultSets];
  const pendingFirst = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ kind: "all", sql, bindings });
        return { results: pendingAll.shift() ?? [] };
      }),
      first: vi.fn(async () => {
        calls.push({ kind: "first", sql, bindings });
        return pendingFirst.shift() ?? null;
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env,
    calls,
    prepare,
  };
}
function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}
describe("edge query core dimension and parser edge coverage", () => {
  it("normalizes page labels and dimension SQL definitions", () => {
    expect(normalizePathname("  ")).toBe("/");
    expect(formatPageLabel(" /docs ", "?q=1", "#intro", false)).toBe("/docs");
    expect(formatPageLabel("", "?q=1", "#intro", true)).toBe("/?q=1#intro");
    expect(browserMajorVersionExpr("v")).toContain("v.browser_version");
    expect(clientDimensionDefinition("operatingSystem", "v")).toEqual({
      labelExpr: "TRIM(COALESCE(v.os, ''))",
      fallbackKeyBase: "os",
    });
    expect(clientDimensionDefinition("screenSize").fallbackKeyBase).toBe(
      "screen",
    );
    expect(utmDimensionDefinition("term", "v")).toEqual({
      labelExpr: "TRIM(COALESCE(v.utm_term, ''))",
      fallbackKeyBase: "utm-term",
    });
    expect(utmDimensionDefinition("content").fallbackKeyBase).toBe(
      "utm-content",
    );
    expect(referrerDomainDimensionDefinition("v").labelExpr).toContain(
      "v.referrer_host",
    );
  });

  it("parses and clamps query inputs defensively", () => {
    expect(parseLimit(url("/x", { limit: 999 }), 10, 25)).toBe(25);
    expect(parseLimit(url("/x", { limit: 0 }), 10, 25)).toBe(10);
    expect(
      parseQueryLimit(url("/x", { pageSize: -10 }), "pageSize", 20, 1, 50),
    ).toBe(1);
    expect(
      parseQueryLimit(url("/x", { pageSize: 100 }), "pageSize", 20, 1, 50),
    ).toBe(50);
    expect(
      parseVisitorListSort(
        url("/x", { sortBy: "firstSeenAt", sortDir: "asc" }),
      ),
    ).toEqual({ key: "firstSeenAt", direction: "asc" });
    expect(parseVisitorListSort(url("/x", { sortBy: "bad" }))).toEqual({
      key: "lastSeenAt",
      direction: "desc",
    });
    expect(
      parseSessionListSort(url("/x", { sortBy: "durationMs", sortDir: "asc" })),
    ).toEqual({ key: "durationMs", direction: "asc" });
  });
});
describe("edge journey retention coverage", () => {
  it("rejects invalid retention windows before querying D1", async () => {
    const { env, prepare } = createD1Env([]);

    const response = await handleRetention(
      env,
      siteId,
      new URL("https://edge.test/retention?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps cohort periods, zero-size rates, fallback granularity, and filters", async () => {
    const { env, calls } = createD1Env([
      [
        { cohortBucket: 0, visitBucket: 0, visitors: 4 },
        { cohortBucket: 0, visitBucket: 1, visitors: 2 },
        { cohortBucket: 2, visitBucket: 3, visitors: 1 },
      ],
    ]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
        granularity: "bad",
        "filter[geo.country]": "US",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "week",
      cohorts: [
        {
          bucket: window.startMs,
          size: 4,
          periods: [
            { index: 0, visitors: 4, rate: 1 },
            { index: 1, visitors: 2, rate: 0.5 },
          ],
        },
        {
          bucket: 0,
          size: 0,
          periods: [{ index: 1, visitors: 1, rate: 0 }],
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("uses the migrated retention reader while preserving cohort results", async () => {
    const database = createMigratedDatabase();
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run(siteId);
    const sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(siteId) as { site_pk: number }
      ).site_pk,
    );
    const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            calls.push({ sql, bindings });
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, '/', 'example.test')
    `);

    try {
      insert.run(
        "visitor-a-first",
        siteId,
        sitePk,
        "visitor-a",
        "session-a",
        baseMs + 1,
        baseMs + 1,
      );
      insert.run(
        "visitor-a-return",
        siteId,
        sitePk,
        "visitor-a",
        "session-b",
        baseMs + 60 * 60 * 1000 + 1,
        baseMs + 60 * 60 * 1000 + 1,
      );
      insert.run(
        "visitor-b-first",
        siteId,
        sitePk,
        "visitor-b",
        "session-c",
        baseMs + 60 * 60 * 1000 + 2,
        baseMs + 60 * 60 * 1000 + 2,
      );
      insert.run(
        "outside-window",
        siteId,
        sitePk,
        "visitor-outside",
        "session-d",
        window.endExclusiveMs,
        window.endExclusiveMs,
      );

      const response = await handleRetention(
        env,
        siteId,
        url("/retention", {
          from: window.startMs,
          to: window.endExclusiveMs,
          granularity: "hour",
        }),
      );
      await expect(response.json()).resolves.toEqual({
        ok: true,
        granularity: "hour",
        cohorts: [
          {
            bucket: baseMs,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
            ],
          },
          {
            bucket: baseMs + 60 * 60 * 1000,
            size: 1,
            periods: [{ index: 0, visitors: 1, rate: 1 }],
          },
        ],
      });

      expect(calls).toHaveLength(1);
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(plan.length).toBeGreaterThan(0);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("accepts interval as granularity and normalizes sparse cohort rows", async () => {
    const { env } = createD1Env([
      [
        { cohortBucket: null, visitBucket: undefined, visitors: null },
        { cohortBucket: 3, visitBucket: 1, visitors: 2 },
      ],
    ]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "day",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "day",
      cohorts: [
        {
          bucket: window.startMs,
          size: 0,
          periods: [{ index: 0, visitors: 0, rate: 0 }],
        },
        {
          bucket: 0,
          size: 0,
          periods: [{ index: 0, visitors: 2, rate: 0 }],
        },
      ],
    });
  });

  it("defaults retention granularity to week when no interval is provided", async () => {
    const { env } = createD1Env([[]]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "week",
      cohorts: [],
    });
  });
});
