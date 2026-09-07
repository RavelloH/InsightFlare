import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  buildSessionFactsSql,
  buildVisitorFactsSql,
} from "@/lib/edge/analytics/providers/d1/internal/journey-aggregation-sql";
import { executeObservationFilterOnScopedDataset } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { parseFilterDsl } from "@/lib/filter-contract";

const dataset = {
  ctes: "scope_raw_visits AS (...), scope_raw_events AS (...)",
  bindings: [{ value: "base" }],
  visitRelation: "scope_final_visits",
  eventRelation: "scope_final_events",
  sessionRelation: "scope_final_sessions",
  visitorRelation: "scope_final_visitors",
  scope: "event" as const,
};

describe("scoped dataset Observation Filter primitive", () => {
  it("projects a step onto the existing final relations and derives identities", () => {
    const result = executeObservationFilterOnScopedDataset(
      dataset,
      parseFilterDsl('page.path eq "/pricing"', analyticsFilterRegistry),
      "funnel_step_0",
    );

    expect(result.matchedVisitRelation).toBe("funnel_step_0_matched_visits");
    expect(result.matchedEventRelation).toBe("funnel_step_0_matched_events");
    expect(result.ctes).toContain(
      "FROM scope_final_visits funnel_step_0_visit_filter",
    );
    expect(result.ctes).toContain(
      "FROM scope_final_events funnel_step_0_event_filter",
    );
    expect(result.ctes).toContain("SELECT DISTINCT site_pk, session_id");
    expect(result.ctes).toContain("TRIM(COALESCE(session_id, '')) != ''");
    expect(result.ctes).toContain("SELECT DISTINCT site_pk, visitor_id");
    expect(result.bindings).toEqual([
      { value: "/pricing" },
      { value: "/pricing" },
    ]);
  });

  it("keeps per-step CTE namespaces isolated and rejects unsafe names", () => {
    const filter = parseFilterDsl(
      'event.name eq "signup"',
      analyticsFilterRegistry,
    );
    const first = executeObservationFilterOnScopedDataset(
      dataset,
      filter,
      "step_a",
    );
    const second = executeObservationFilterOnScopedDataset(
      dataset,
      filter,
      "step_b",
    );

    expect(first.ctes).not.toContain("step_b_");
    expect(second.ctes).not.toContain("step_a_");
    expect(() =>
      executeObservationFilterOnScopedDataset(dataset, filter, "step;drop"),
    ).toThrow("internal SQL identifier");
  });
});

describe("scoped dataset facts", () => {
  it("keeps fact counts isolated by site and uses the raw observation window", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const sql = `
WITH raw_visits(site_pk, site_id, session_id, visitor_id, duration_ms) AS (
  VALUES
    (1, 'site-1', 's1', 'v1', 100),
    (1, 'site-1', 's1', 'v1', 250),
    (1, 'site-1', 's2', 'v1', 50),
    (2, 'site-2', 's1', 'v1', 99)
), raw_events(site_pk, site_id, session_id, visitor_id) AS (
  VALUES
    (1, 'site-1', 's1', 'v1'),
    (1, 'site-1', 's1', 'v1'),
    (1, 'site-1', 's2', 'v1'),
    (2, 'site-2', 's1', 'v1')
),
${buildSessionFactsSql({ visitsRelation: "raw_visits", eventsRelation: "raw_events" })},
${buildVisitorFactsSql({ visitsRelation: "raw_visits", eventsRelation: "raw_events" })}
SELECT
  sf.site_pk,
  sf.site_id AS session_site_id,
  sf.session_id,
  sf.session_duration_ms,
  sf.session_views,
  sf.session_events,
  sf.session_bounce,
  vf.site_id AS visitor_site_id,
  vf.visitor_id,
  vf.visitor_sessions,
  vf.visitor_views,
  vf.visitor_events
FROM scope_session_facts sf
INNER JOIN scope_visitor_facts vf
  ON vf.site_pk = sf.site_pk
 AND vf.visitor_id = CASE sf.site_pk WHEN 1 THEN 'v1' ELSE 'v1' END
ORDER BY sf.site_pk, sf.session_id`;
      const rows = database.prepare(sql).all() as Array<
        Record<string, number | string>
      >;

      expect(rows).toEqual([
        {
          site_pk: 1,
          session_site_id: "site-1",
          session_id: "s1",
          session_duration_ms: 350,
          session_views: 2,
          session_events: 2,
          session_bounce: 0,
          visitor_site_id: "site-1",
          visitor_id: "v1",
          visitor_sessions: 2,
          visitor_views: 3,
          visitor_events: 3,
        },
        {
          site_pk: 1,
          session_site_id: "site-1",
          session_id: "s2",
          session_duration_ms: 50,
          session_views: 1,
          session_events: 1,
          session_bounce: 1,
          visitor_site_id: "site-1",
          visitor_id: "v1",
          visitor_sessions: 2,
          visitor_views: 3,
          visitor_events: 3,
        },
        {
          site_pk: 2,
          session_site_id: "site-2",
          session_id: "s1",
          session_duration_ms: 99,
          session_views: 1,
          session_events: 1,
          session_bounce: 1,
          visitor_site_id: "site-2",
          visitor_id: "v1",
          visitor_sessions: 1,
          visitor_views: 1,
          visitor_events: 1,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("returns no fact entities for an empty scoped dataset", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const sql = `
WITH raw_visits(site_pk, site_id, session_id, visitor_id, duration_ms) AS (
  SELECT 1, 'site-1', 'unused', 'unused', 0 WHERE 0
), raw_events(site_pk, site_id, session_id, visitor_id) AS (
  SELECT 1, 'site-1', 'unused', 'unused' WHERE 0
),
${buildSessionFactsSql({ visitsRelation: "raw_visits", eventsRelation: "raw_events" })},
${buildVisitorFactsSql({ visitsRelation: "raw_visits", eventsRelation: "raw_events" })}
SELECT
  (SELECT COUNT(*) FROM scope_session_facts) AS sessions,
  (SELECT COUNT(*) FROM scope_visitor_facts) AS visitors`;
      expect(database.prepare(sql).get()).toEqual({ sessions: 0, visitors: 0 });
    } finally {
      database.close();
    }
  });
});
