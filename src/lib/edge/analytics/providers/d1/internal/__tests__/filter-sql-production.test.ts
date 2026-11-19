// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import {
  compileScopedDatasetSql,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITES = ["site-a", "site-b"];
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 300,
  nowMs: 400,
  timeZone: "UTC",
};

function sqliteFixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const columns = VISIT_SOURCE_COLUMNS.split(",")
    .map((col) => col.trim())
    .filter(Boolean);
  database.exec(`
    CREATE TABLE site_identities(site_pk INTEGER PRIMARY KEY,site_id TEXT UNIQUE);
    CREATE TABLE visits(${columns
      .map(
        (column) =>
          `${column} ${["site_pk", "started_at", "duration_ms"].includes(column) ? "INTEGER" : "TEXT"}`,
      )
      .join(",")});
    CREATE TABLE custom_event_names(id INTEGER PRIMARY KEY,site_pk INTEGER,name TEXT);
    CREATE TABLE custom_events(
      event_pk INTEGER PRIMARY KEY,site_id TEXT,site_pk INTEGER,event_id TEXT,
      visit_id TEXT,event_name_id INTEGER,occurred_at INTEGER,received_at INTEGER,
      sequence INTEGER,node_count INTEGER,value_count INTEGER
    );
    INSERT INTO site_identities VALUES (1,'site-a'),(2,'site-b');
    INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms)
    VALUES(1,'site-a','v-old','s1','u1','/old',20,5),
          (1,'site-a','v-new','s1','u1','/home',120,20),
          (1,'site-a','v-docs','s2','u2','/docs',220,30),
          (2,'site-b','v-new','s1','u1','/home',120,40);
    INSERT INTO custom_event_names VALUES
      (1,1,'purchase'),(2,1,'signup'),(3,1,'view'),(4,2,'purchase');
    INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at)
    VALUES(101,1,'site-a','e-old','v-old',1,30),
          (102,1,'site-a','e-signup','v-new',2,130),
          (103,1,'site-a','e-purchase','v-new',1,160),
          (104,1,'site-a','e-view','v-docs',3,240),
          (201,2,'site-b','e-purchase','v-new',4,150);
  `);
  return database;
}

function dataset(
  expression: string,
  scope: "event" | "session" | "visitor" = "session",
  range: QueryTime = createQueryTime(100, 300, "UTC", 400),
) {
  const filter = parseFilterDsl(expression, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", filter, scope);
  if (!plan) throw new Error("Missing Filter Scope plan");
  const filters = attachScopedFilterMetadata(filter, {
    requestedScope: scope,
    resolvedScope: plan.scope,
    plan,
    time: range,
    siteIds: SITES,
  });
  return compileScopedDatasetSql({
    filters,
    plan,
    siteIds: SITES,
    window: WINDOW,
  });
}

function select(
  database: DatabaseSync,
  sql: string,
  parameters: readonly (string | number | null)[],
) {
  return database.prepare(sql).all(...parameters);
}

describe("P5 Scoped Dataset integration: SQL-only advanced qualification", () => {
  it("runs a complex Selector/Count Filter without any advanced JS match IDs", () => {
    const db = sqliteFixture();
    try {
      const result = dataset('count(EVENT { $.name eq "purchase" }) eq 1');
      expect(result.ctes).toContain("scope_filter_qualified_entities");
      expect(result.ctes).not.toContain("scope_advanced_matching_entities");
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,visit_id FROM ${result.visitRelation} ORDER BY site_pk,visit_id`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([
        { site_pk: 1, visit_id: "v-new" },
        { site_pk: 2, visit_id: "v-new" },
      ]);
    } finally {
      db.close();
    }
  });

  it("uses historical qualification F/U but projects only current reporting window Q", () => {
    const db = sqliteFixture();
    try {
      const history = {
        ...createQueryTime(100, 300, "UTC", 400),
        filterRange: { startMs: 0, endExclusiveMs: 100 },
        readRange: { startMs: 0, endExclusiveMs: 300 } as QueryTime["range"],
      };
      const result = dataset(
        'count(EVENT { $.name eq "purchase" }) eq 1',
        "session",
        history,
      );
      expect(result.ctes).toContain("scope_filter_read_visits");
      expect(result.ctes).toContain("scope_filter_evaluation_events");
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,visit_id FROM ${result.visitRelation}
        ORDER BY site_pk,visit_id`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,event_id FROM ${result.eventRelation}
        ORDER BY site_pk,event_id`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([
        { site_pk: 1, event_id: "e-purchase" },
        { site_pk: 1, event_id: "e-signup" },
      ]);
    } finally {
      db.close();
    }
  });

  it("uses correct matched Event observations and joined Report Visits", () => {
    const db = sqliteFixture();
    try {
      const result = dataset(
        'event.name eq "purchase" AND page.path eq "/home"',
        "event",
      );
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,visit_id FROM ${result.visitRelation}
        ORDER BY site_pk,visit_id`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([
        { site_pk: 1, visit_id: "v-new" },
        { site_pk: 2, visit_id: "v-new" },
      ]);
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,event_id FROM ${result.eventRelation}
        ORDER BY site_pk,event_id`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([
        { site_pk: 1, event_id: "e-purchase" },
        { site_pk: 2, event_id: "e-purchase" },
      ]);
    } finally {
      db.close();
    }
  });

  it("combines independently scoped Comparison sides without colliding CTEs/parameters", () => {
    const db = sqliteFixture();
    try {
      const current = dataset('count(EVENT { $.name eq "purchase" }) eq 1');
      const reference = dataset('count(PAGE { $.path eq "/docs" }) eq 1');
      const rename = (sql: string, prefix: string) =>
        sql
          .replace(/\bscope_[A-Za-z0-9_]*/g, (name) => `${prefix}_${name}`)
          .replace(/\bvisit_source\b/g, `${prefix}_visit_source`);
      const result = select(
        db,
        `WITH
        ${rename(current.ctes, "current")},
        ${rename(reference.ctes, "reference")}
        SELECT
          (SELECT COUNT(*) FROM current_scope_final_visits) AS current_count,
          (SELECT COUNT(*) FROM reference_scope_final_visits) AS reference_count`,
        [...current.bindings, ...reference.bindings].map((b) => b.value),
      );
      expect(result).toEqual([{ current_count: 2, reference_count: 1 }]);
    } finally {
      db.close();
    }
  });

  it("uses the full authorized read range R for ordered first(Event), while keeping report Q", () => {
    const db = sqliteFixture();
    try {
      const historical: QueryTime = {
        ...createQueryTime(100, 300, "UTC", 400),
        fullHistory: true,
      };
      const earliest = dataset(
        'first(EVENT).name eq "purchase"',
        "session",
        historical,
      );
      expect(
        select(
          db,
          `WITH ${earliest.ctes}
        SELECT site_pk,visit_id FROM ${earliest.visitRelation}
        ORDER BY site_pk,visit_id`,
          earliest.bindings.map((b) => b.value),
        ),
      ).toEqual([
        { site_pk: 1, visit_id: "v-new" },
        { site_pk: 2, visit_id: "v-new" },
      ]);
      const firstSignup = dataset(
        'first(EVENT).name eq "signup"',
        "session",
        historical,
      );
      expect(
        select(
          db,
          `WITH ${firstSignup.ctes}
        SELECT site_pk,visit_id FROM ${firstSignup.visitRelation}`,
          firstSignup.bindings.map((b) => b.value),
        ),
      ).toEqual([]);
      // An explicit Filter domain F changes the ordered collection even
      // when the authorized R range still contains the old purchase.
      const explicit: QueryTime = {
        ...historical,
        filterRange: { startMs: 100, endExclusiveMs: 300 },
      };
      const bounded = dataset(
        'first(EVENT).name eq "signup"',
        "session",
        explicit,
      );
      expect(
        select(
          db,
          `WITH ${bounded.ctes}
        SELECT site_pk,visit_id FROM ${bounded.visitRelation}`,
          bounded.bindings.map((b) => b.value),
        ),
      ).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
    } finally {
      db.close();
    }
  });

  it("uses historical R for Sequence steps while retaining only Q report Visits", () => {
    const db = sqliteFixture();
    try {
      const historical: QueryTime = {
        ...createQueryTime(100, 300, "UTC", 400),
        fullHistory: true,
      };
      const result = dataset(
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }]) exists',
        "session",
        historical,
      );
      expect(
        select(
          db,
          `WITH ${result.ctes}
        SELECT site_pk,visit_id FROM ${result.visitRelation}`,
          result.bindings.map((b) => b.value),
        ),
      ).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
    } finally {
      db.close();
    }
  });

  it("keeps Calendar Bucket and Periods on explicit F rather than truncating to Q", () => {
    const db = sqliteFixture();
    try {
      db.exec(`INSERT INTO custom_events(
        event_pk, site_pk, site_id, event_id, visit_id, event_name_id, occurred_at
      ) VALUES(107, 1, 'site-a', 'e-prior-day', 'v-old', 1, -86399950)`);
      const time: QueryTime = {
        ...createQueryTime(100, 300, "UTC", 400),
        filterRange: { startMs: -86400000, endExclusiveMs: 300 },
        readRange: {
          startMs: -86400000,
          endExclusiveMs: 300,
        } as QueryTime["range"],
      };
      for (const expression of [
        "countDistinct(bucket(EVENT, 1d)) eq 2",
        "count(periods(EVENT, 1d)) eq 2",
      ]) {
        const compiled = dataset(expression, "session", time);
        expect(
          select(
            db,
            `WITH ${compiled.ctes}
          SELECT site_pk, visit_id FROM ${compiled.visitRelation}`,
            compiled.bindings.map((binding) => binding.value),
          ),
        ).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
      }
    } finally {
      db.close();
    }
  });

  it("reports an explicit failure for unknown unbounded IANA calendar history", () => {
    const time: QueryTime = {
      ...createQueryTime(100, 300, "UTC", 400),
      fullHistory: true,
      filterRange: { endExclusiveMs: 300 },
    };
    expect(() =>
      dataset("count(periods(EVENT, 1d)) gte 1", "session", time),
    ).toThrow("filter_calendar_history_requires_retained_start");
  });

  it("short-circuits proven empty Filter time across historical Sequence/Window and entity scopes", () => {
    const db = sqliteFixture();
    try {
      const time: QueryTime = {
        ...createQueryTime(100, 300, "UTC", 400),
        fullHistory: true,
        filterRangeEmpty: true,
      };
      for (const scope of ["session", "visitor", "event"] as const) {
        const result = dataset(
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
          scope,
          time,
        );
        expect(result.ctes).not.toContain("scope_filter_timeline");
        expect(
          select(
            db,
            `WITH ${result.ctes}
          SELECT site_pk, visit_id FROM ${result.visitRelation}`,
            result.bindings.map((binding) => binding.value),
          ),
        ).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it("rejects Relation DSL at unprepared compatibility readers instead of silently using legacy visit-only filters", () => {
    const document = parseFilterDsl(
      'count(EVENT { $.name eq "purchase" }) gte 1',
      analyticsFilterRegistry,
    );
    expect(() =>
      scopedDatasetForUnpreparedReader(
        "overview",
        "site-a",
        WINDOW,
        document,
        "session",
      ),
    ).toThrow("advanced_filter_requires_prepared_scope");
  });

  it("rejects a broken historical range instead of returning false zero matches", () => {
    const bad = {
      ...createQueryTime(100, 300, "UTC", 400),
      readRange: { startMs: -100, endExclusiveMs: 500 } as QueryTime["range"],
    };
    expect(() => dataset("count(EVENT) gte 1", "session", bad)).toThrow(
      "filter_evaluation_range_unavailable",
    );
  });
});
