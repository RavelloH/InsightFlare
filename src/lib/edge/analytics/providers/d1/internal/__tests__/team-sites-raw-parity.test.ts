// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import {
  queryLatestSiteActivity,
  queryOverviewFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  queryTeamLatestActivityFromD1,
  queryTeamOverviewFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import type { Env } from "@/lib/edge/types";

const filters = { version: 1 as const, root: null };
const window = {
  startMs: 100,
  endExclusiveMs: 300,
  nowMs: 400,
  timeZone: "UTC",
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  const columns = VISIT_SOURCE_COLUMNS.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  db.exec(`
CREATE TABLE site_identities(site_pk INTEGER PRIMARY KEY,site_id TEXT UNIQUE);
CREATE TABLE visits(${columns.map((col) => `${col} ${["site_pk", "started_at", "last_activity_at", "duration_ms"].includes(col) ? "INTEGER" : "TEXT"}`).join(",")});
INSERT INTO site_identities VALUES (1,'a'),(2,'b');
INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,started_at,last_activity_at,duration_ms)
VALUES
(1,'a','a0','sa0','ua0',50,90,80),
(1,'a','a1','sa1','ua1',120,130,10),
(1,'a','a2','sa1','ua1',150,190,20),
(1,'a','a3','sa2','ua2',240,260,30),
(2,'b','b1','sb1','ub1',135,140,40),
(2,'b','b2','sb2','ub2',230,280,50),
(2,'b','b3','sb2','ub2',301,320,20);
`);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  return { db, trace, env: { DB: createSqliteD1Database(db, trace) } as Env };
}
describe("team-sites grouped Raw fallback equivalence (real SQLite)", () => {
  it("matches single-site Overview, including session dedup, bounces, duration and half-open windows", async () => {
    const f = fixture();
    try {
      const grouped = await queryTeamOverviewFromD1(
        f.env,
        ["a", "b"],
        window,
        undefined,
        filters,
      );
      expect(f.trace.preparedSql).toHaveLength(1);
      for (const id of ["a", "b"]) {
        const single = await queryOverviewFromD1(f.env, id, window, filters);
        expect(grouped.get(id)).toEqual(single);
      }
      expect(grouped.get("a")).toEqual({
        views: 3,
        sessions: 2,
        visitors: 2,
        bounces: 1,
        totalDuration: 60,
        durationViews: 3,
      });
      expect(grouped.get("b")).toEqual({
        views: 2,
        sessions: 2,
        visitors: 2,
        bounces: 2,
        totalDuration: 90,
        durationViews: 2,
      });
    } finally {
      f.db.close();
    }
  });

  it("matches single-site MAX(last_activity_at) and does not access unauthorized/empty-window sites", async () => {
    const f = fixture();
    try {
      const grouped = await queryTeamLatestActivityFromD1(
        f.env,
        ["a", "b", "missing"],
        window,
      );
      expect(f.trace.preparedSql).toHaveLength(1);
      expect(grouped.get("a")).toBe(260);
      expect(grouped.get("b")).toBe(280);
      expect(grouped.has("missing")).toBe(false);
      expect(grouped.has("outside")).toBe(false);
      for (const id of ["a", "b"]) {
        expect(grouped.get(id)).toBe(
          await queryLatestSiteActivity(f.env, id, window, filters),
        );
      }
      const noSites = await queryTeamLatestActivityFromD1(f.env, [], window);
      expect(noSites.size).toBe(0);
      expect(f.trace.preparedSql).toHaveLength(3);
    } finally {
      f.db.close();
    }
  });
});
