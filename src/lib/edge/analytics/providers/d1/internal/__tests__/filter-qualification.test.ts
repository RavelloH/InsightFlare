// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  attachScopedFilterMetadata,
  createQueryTime,
} from "@/lib/edge/analytics/contract";
import { createScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import {
  boundCte,
  composeBoundCtes,
} from "@/lib/edge/analytics/providers/d1/internal/filter-qualification";
import {
  compileScopedDatasetSql,
  compileSqlQualification,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import {
  analyticsFilterRegistry,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const RAW_SOURCES = `
scope_raw_visits(site_pk, site_id, visit_id, session_id, visitor_id, pathname, duration_ms, started_at) AS (
  VALUES
    (1, 'site-a', 'v1', 'same-session', 'same-visitor', '/pricing', 50, 10),
    (1, 'site-a', 'v2', 'same-session', 'same-visitor', '/home', 20, 20),
    (1, 'site-a', 'v3', 'other-session', 'other-visitor', '/docs', 30, 30),
    (2, 'site-b', 'v1', 'same-session', 'same-visitor', '/home', 100, 10)
),
scope_raw_events(site_pk, site_id, event_id, event_pk, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
  VALUES
    (1, 'site-a', 'e1', 101, 'v2', 'same-session', 'same-visitor', '/home', 'purchase', 25),
    (1, 'site-a', 'e2', 102, 'v3', 'other-session', 'other-visitor', '/docs', 'view', 35),
    (2, 'site-b', 'e1', 201, 'v1', 'same-session', 'same-visitor', '/home', 'view', 15)
)`;

type Filter = ReturnType<typeof parseFilterDsl>;

function qualify(
  document: Filter,
  operation: "overview" | "sessions" | "visitors" = "overview",
) {
  const plan = createScopedFilterPlan(operation, document);
  if (!plan) throw new Error("Unexpected unscoped operation");
  return compileSqlQualification(document, plan);
}

function withSqlite<T>(run: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(":memory:");
  try {
    return run(database);
  } finally {
    database.close();
  }
}

function rows(
  database: DatabaseSync,
  sql: string,
  values: readonly (string | number | null)[] = [],
) {
  return database.prepare(sql).all(...values) as Array<Record<string, unknown>>;
}

describe("P1 SQL qualification", () => {
  it("emits CTE bindings in SQL order, not AST order, and rejects unsafe or repeated identifiers", () => {
    const compiled = composeBoundCtes([
      boundCte("first_cte", "first_cte AS (SELECT ? AS value)", [1]),
      boundCte("second_cte", "second_cte AS (SELECT ? AS value)", ["second"]),
    ]);
    expect(compiled.bindings).toEqual([{ value: 1 }, { value: "second" }]);
    withSqlite((db) => {
      expect(
        rows(
          db,
          `WITH ${compiled.ctes} SELECT first_cte.value AS a, second_cte.value AS b FROM first_cte, second_cte`,
          compiled.bindings.map((b) => b.value),
        ),
      ).toEqual([{ a: 1, b: "second" }]);
    });
    expect(() => boundCte("DROP;TABLE", "DROP;TABLE AS (SELECT 1)")).toThrow();
    expect(() => boundCte("expected", "other AS (SELECT 1)")).toThrow();
    expect(() =>
      composeBoundCtes([
        boundCte("same", "same AS (SELECT 1)"),
        boundCte("same", "same AS (SELECT 2)"),
      ]),
    ).toThrow("Duplicate");
  });

  it("compiles basic Visit fields as two typed identity relations with multi-site isolation", () => {
    const qualification = qualify(
      parseFilterDsl('page.path eq "/pricing"', analyticsFilterRegistry),
    );
    expect(qualification.kind).toBe("observation");
    if (qualification.kind !== "observation") return;
    const compiled = composeBoundCtes(qualification.ctes);
    withSqlite((db) => {
      const result = rows(
        db,
        `WITH ${RAW_SOURCES}, ${compiled.ctes}
        SELECT 'visit' AS kind, site_pk, visit_id AS id FROM ${qualification.matchedVisitRelation}
        UNION ALL
        SELECT 'event', site_pk, event_id FROM ${qualification.matchedEventRelation}`,
        compiled.bindings.map((b) => b.value),
      );
      expect(result).toEqual([{ kind: "visit", site_pk: 1, id: "v1" }]);
    });
  });

  it("distinguishes a matching Event from its report-expanded Visit", () => {
    const qualification = qualify(
      parseFilterDsl('event.name eq "purchase"', analyticsFilterRegistry),
    );
    expect(qualification.kind).toBe("observation");
    if (qualification.kind !== "observation") return;
    const compiled = composeBoundCtes(qualification.ctes);
    withSqlite((db) => {
      const result = rows(
        db,
        `WITH ${RAW_SOURCES}, ${compiled.ctes},
      report_visits AS (
        SELECT site_pk, visit_id FROM ${qualification.matchedVisitRelation}
        UNION
        SELECT raw.site_pk, raw.visit_id FROM scope_raw_events raw
        JOIN ${qualification.matchedEventRelation} matched
          ON raw.site_pk = matched.site_pk AND raw.event_id = matched.event_id
      )
      SELECT
        (SELECT COUNT(*) FROM ${qualification.matchedVisitRelation}) AS matched_visits,
        (SELECT COUNT(*) FROM ${qualification.matchedEventRelation}) AS matched_events,
        (SELECT COUNT(*) FROM report_visits) AS report_visits,
        (SELECT visit_id FROM report_visits LIMIT 1) AS expanded_visit`,
        compiled.bindings.map((b) => b.value),
      );
      expect(result).toEqual([
        {
          matched_visits: 0,
          matched_events: 1,
          report_visits: 1,
          expanded_visit: "v2",
        },
      ]);
    });
  });

  it("uses the proper SQL entity universe and preserves composite site/identity keys", () => {
    const doc = parseFilterDsl("session.views gte 2", analyticsFilterRegistry);
    const qualification = qualify(doc, "sessions");
    expect(qualification.kind).toBe("entity");
    if (qualification.kind !== "entity") return;
    expect(qualification.entityKind).toBe("session");
    const compiled = composeBoundCtes(qualification.ctes);
    withSqlite((db) => {
      const result = rows(
        db,
        `WITH ${RAW_SOURCES}, ${compiled.ctes}
        SELECT site_pk, entity_id FROM ${qualification.qualifiedEntityRelation}
        ORDER BY site_pk, entity_id`,
        compiled.bindings.map((b) => b.value),
      );
      expect(result).toEqual([{ site_pk: 1, entity_id: "same-session" }]);
    });
  });

  it("supports zero match and an empty dataset without synthesizing qualified entities", () => {
    const qualification = qualify(
      parseFilterDsl("session.views gte 200", analyticsFilterRegistry),
      "sessions",
    );
    expect(qualification.kind).toBe("entity");
    if (qualification.kind !== "entity") return;
    const compiled = composeBoundCtes(qualification.ctes);
    withSqlite((db) => {
      expect(
        rows(
          db,
          `WITH ${RAW_SOURCES}, ${compiled.ctes}
        SELECT * FROM ${qualification.qualifiedEntityRelation}`,
          compiled.bindings.map((b) => b.value),
        ),
      ).toEqual([]);
    });
  });

  it("reuses the ordinary event-payload SQL predicate and positional values", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "event-payload", path: "/plan" },
          operator: "eq",
          value: "pro",
        },
      },
      analyticsFilterRegistry,
    );
    const qualification = qualify(document);
    expect(qualification.kind).toBe("observation");
    if (qualification.kind !== "observation") return;
    const compiled = composeBoundCtes(qualification.ctes);
    withSqlite((db) => {
      db.exec(`
        CREATE TABLE custom_event_json_paths(id INTEGER, site_pk INTEGER, path TEXT);
        CREATE TABLE custom_event_json_values(event_pk INTEGER, site_pk INTEGER, path_id INTEGER, value_type INTEGER, string_value TEXT);
        INSERT INTO custom_event_json_paths VALUES (1, 1, '/plan'), (2, 2, '/plan');
        INSERT INTO custom_event_json_values VALUES (101, 1, 1, 1, 'pro'), (102, 1, 1, 1, 'free'), (201, 2, 2, 1, 'pro');
      `);
      const result = rows(
        db,
        `WITH ${RAW_SOURCES}, ${compiled.ctes}
        SELECT site_pk, event_id FROM ${qualification.matchedEventRelation}
        ORDER BY site_pk, event_id`,
        compiled.bindings.map((b) => b.value),
      );
      expect(result).toEqual([
        { site_pk: 1, event_id: "e1" },
        { site_pk: 2, event_id: "e1" },
      ]);
    });
  });

  it("executes the full Scoped Dataset SQL with actual SQLite source tables", () => {
    withSqlite((database) => {
      const columns = VISIT_SOURCE_COLUMNS.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      database.exec(`CREATE TABLE site_identities(site_pk INTEGER PRIMARY KEY, site_id TEXT NOT NULL);
        CREATE TABLE visits(${columns.map((column) => `${column} ${["site_pk", "started_at", "duration_ms"].includes(column) ? "INTEGER" : "TEXT"}`).join(", ")});
        CREATE TABLE custom_event_names(id INTEGER PRIMARY KEY, site_pk INTEGER, name TEXT);
        CREATE TABLE custom_events(event_pk INTEGER PRIMARY KEY, site_id TEXT, site_pk INTEGER,
          event_id TEXT, visit_id TEXT, event_name_id INTEGER, occurred_at INTEGER,
          received_at INTEGER, sequence INTEGER, node_count INTEGER, value_count INTEGER);
        INSERT INTO site_identities VALUES(1, 'site-a'), (2, 'site-b');
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES
          (1, 'site-a', 'v1', 's1', 'u1', '/pricing', 10, 20),
          (1, 'site-a', 'v2', 's1', 'u1', '/home', 20, 30),
          (2, 'site-b', 'v1', 's1', 'u1', '/home', 10, 40);
        INSERT INTO custom_event_names VALUES(1, 1, 'purchase'), (2, 2, 'pageview');
        INSERT INTO custom_events(event_pk,site_id,site_pk,event_id,visit_id,event_name_id,occurred_at) VALUES
          (101,'site-a',1,'e1','v2',1,25),
          (201,'site-b',2,'e1','v1',2,15);
      `);
      const document = parseFilterDsl(
        'event.name eq "purchase"',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("overview", document)!;
      const window = {
        startMs: 0,
        endExclusiveMs: 100,
        nowMs: 110,
        timeZone: "UTC",
      };
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "event",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(0, 100, "UTC", 110),
        siteIds: ["site-a", "site-b"],
      });
      const dataset = compileScopedDatasetSql({
        filters,
        plan,
        siteIds: ["site-a", "site-b"],
        window,
      });
      const result = rows(
        database,
        `WITH ${dataset.ctes}
        SELECT
          (SELECT COUNT(*) FROM scope_matching_visits) AS matched_visit_count,
          (SELECT COUNT(*) FROM scope_matching_events) AS matched_event_count,
          (SELECT COUNT(*) FROM ${dataset.visitRelation}) AS final_visit_count,
          (SELECT COUNT(*) FROM ${dataset.eventRelation}) AS final_event_count,
          (SELECT COUNT(*) FROM ${dataset.sessionRelation}) AS session_count,
          (SELECT COUNT(*) FROM ${dataset.visitorRelation}) AS visitor_count,
          (SELECT visit_id FROM ${dataset.visitRelation} LIMIT 1) AS expanded_visit,
          (SELECT site_pk FROM ${dataset.visitRelation} LIMIT 1) AS site_pk
        `,
        dataset.bindings.map((binding) => binding.value),
      );
      expect(result).toEqual([
        {
          matched_visit_count: 0,
          matched_event_count: 1,
          final_visit_count: 1,
          final_event_count: 1,
          session_count: 1,
          visitor_count: 1,
          expanded_visit: "v2",
          site_pk: 1,
        },
      ]);
    });
  });

  it("keeps independent Comparison sides' names and positional bindings isolated", () => {
    const current = qualify(
      parseFilterDsl('page.path eq "/pricing"', analyticsFilterRegistry),
    );
    const reference = qualify(
      parseFilterDsl('event.name eq "purchase"', analyticsFilterRegistry),
    );
    expect(current.kind).toBe("observation");
    expect(reference.kind).toBe("observation");
    if (current.kind !== "observation" || reference.kind !== "observation")
      return;
    const one = composeBoundCtes(current.ctes);
    const two = composeBoundCtes(reference.ctes);
    const rename = (sql: string, prefix: string) =>
      sql.replace(/\bscope_/g, `${prefix}_scope_`);
    withSqlite((db) => {
      const result = rows(
        db,
        `WITH ${rename(RAW_SOURCES, "current")},
        ${rename(one.ctes, "current")},
        ${rename(RAW_SOURCES, "reference")},
        ${rename(two.ctes, "reference")}
        SELECT
          (SELECT count(*) FROM current_scope_matching_visits) AS current_count,
          (SELECT count(*) FROM reference_scope_matching_events) AS reference_count`,
        [...one.bindings, ...two.bindings].map((b) => b.value),
      );
      expect(result).toEqual([{ current_count: 1, reference_count: 1 }]);
    });
  });
});
