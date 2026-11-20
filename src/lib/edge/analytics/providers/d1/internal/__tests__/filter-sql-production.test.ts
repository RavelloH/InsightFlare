// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  applyObservationFilterToScopedDataset,
  compileScopedDatasetSql,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

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

/** Persist genuine ingest expansion as Node/Key/Path/Value rows. */
function sqlitePayloadFixture(): DatabaseSync {
  const db = sqliteFixture();
  db.exec(
    [
      "CREATE TABLE custom_event_json_keys(id INTEGER PRIMARY KEY, site_pk INTEGER, key TEXT)",
      "CREATE TABLE custom_event_json_paths(id INTEGER PRIMARY KEY, site_pk INTEGER, path TEXT)",
      "CREATE TABLE custom_event_json_nodes(event_pk INTEGER, node_id INTEGER, parent_node_id INTEGER, key_id INTEGER, path_id INTEGER, value_type INTEGER, member_order INTEGER, array_index INTEGER, depth INTEGER, PRIMARY KEY(event_pk,node_id))",
      "CREATE TABLE custom_event_json_values(event_pk INTEGER, node_id INTEGER, site_pk INTEGER, value_type INTEGER, string_value TEXT, number_value REAL, boolean_value INTEGER)",
    ].join("; ") + ";",
  );
  const keys = new Map<string, number>();
  const paths = new Map<string, number>();
  const keyStmt = db.prepare(
    "INSERT INTO custom_event_json_keys VALUES (?, ?, ?)",
  );
  const pathStmt = db.prepare(
    "INSERT INTO custom_event_json_paths VALUES (?, ?, ?)",
  );
  const nodeStmt = db.prepare(
    "INSERT INTO custom_event_json_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const valueStmt = db.prepare(
    "INSERT INTO custom_event_json_values VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const payloads: ReadonlyArray<readonly [number, number, object]> = [
    [101, 1, { items: [{ sku: "A" }] }], // historical Event outside Q
    [102, 1, { items: [] }],
    [
      103,
      1,
      {
        items: [{ sku: "A" }, { sku: "B" }],
        "0": "literal-zero",
        "*": "literal-star",
        nested: { "a/b": 7, "~tag": 8 },
        nil: null,
        enabled: false,
        search: "abc%_\\Suffix",
      },
    ],
    [104, 1, { emptyObj: {}, misc: "other" }],
    [
      201,
      2,
      { items: [{ sku: "X" }, { sku: "Y" }], nil: 2, search: "ABC%_\\suffix" },
    ],
  ];
  for (const [eventPk, sitePk, payload] of payloads) {
    const expansion = expandCustomEventData(payload);
    if (!expansion.ok) throw new Error(expansion.error);
    for (const key of expansion.data.keys) {
      const identity = sitePk + "/" + key;
      if (!keys.has(identity)) {
        const id = keys.size + 1;
        keys.set(identity, id);
        keyStmt.run(id, sitePk, key);
      }
    }
    for (const path of expansion.data.paths) {
      const identity = sitePk + "/" + path;
      if (!paths.has(identity)) {
        const id = paths.size + 1;
        paths.set(identity, id);
        pathStmt.run(id, sitePk, path);
      }
    }
    for (const node of expansion.data.nodes)
      nodeStmt.run(
        eventPk,
        node.nodeId,
        node.parentNodeId,
        node.key === null ? null : keys.get(sitePk + "/" + node.key)!,
        paths.get(sitePk + "/" + node.path)!,
        node.valueType,
        node.memberOrder,
        node.arrayIndex,
        node.depth,
      );
    for (const value of expansion.data.values)
      valueStmt.run(
        eventPk,
        value.nodeId,
        sitePk,
        value.valueType,
        value.stringValue,
        value.numberValue,
        value.booleanValue,
      );
  }
  return db;
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

describe("FSQL-07 ordinary Event Payload through real ScopedDataset SQL", () => {
  const a = [{ site_pk: 1, event_id: "e-purchase" }];
  const b = [{ site_pk: 2, event_id: "e-purchase" }];
  const signup = [{ site_pk: 1, event_id: "e-signup" }];
  const view = [{ site_pk: 1, event_id: "e-view" }];
  function matched(db: DatabaseSync, expression: string) {
    const document = parseFilterDsl(expression, analyticsFilterRegistry);
    expect(filterDocumentUsesAdvancedExpressions(document)).toBe(false);
    const sql = dataset(expression, "event");
    expect(sql.ctes).toContain("pointer_nodes");
    expect(sql.ctes).not.toContain("custom_event_json_paths");
    return select(
      db,
      "WITH " +
        sql.ctes +
        " SELECT site_pk, event_id FROM " +
        sql.eventRelation +
        " ORDER BY site_pk, event_id",
      sql.bindings.map((binding) => binding.value),
    );
  }

  it("uses exact array offsets, escaped keys and literal star, never dictionary wildcard", () => {
    const db = sqlitePayloadFixture();
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM custom_event_json_paths WHERE path = '/items/*/sku'",
          )
          .get(),
      ).toEqual({ n: 2 });
      expect(matched(db, 'event.payload("/items/0/sku") eq "A"')).toEqual(a);
      expect(matched(db, 'event.payload("/items/1/sku") eq "B"')).toEqual(a);
      expect(matched(db, 'event.payload("/items/0/sku") eq "B"')).toEqual([]);
      expect(matched(db, 'event.payload("/items/1/sku") eq "Y"')).toEqual(b);
      expect(matched(db, 'event.payload("/items/*/sku") eq "A"')).toEqual([]);
      expect(matched(db, 'event.payload("/*") eq "literal-star"')).toEqual(a);
      expect(matched(db, 'event.payload("/0") eq "literal-zero"')).toEqual(a);
      expect(matched(db, 'event.payload("/nested/a~1b") eq 7')).toEqual(a);
      expect(matched(db, 'event.payload("/nested/~0tag") eq 8')).toEqual(a);
    } finally {
      db.close();
    }
  });

  it("distinguishes containers, empty arrays and objects, JSON null, missing and NOT EXISTS", () => {
    const db = sqlitePayloadFixture();
    try {
      expect(matched(db, 'event.payload("/items") exists')).toEqual([
        ...a,
        ...signup,
        ...b,
      ]);
      expect(matched(db, 'event.payload("/items") notExists')).toEqual(view);
      expect(matched(db, 'event.payload("/items") isEmpty')).toEqual(signup);
      expect(matched(db, 'event.payload("/items/0") exists')).toEqual([
        ...a,
        ...b,
      ]);
      expect(matched(db, 'event.payload("/items/0") notExists')).toEqual([
        ...signup,
        ...view,
      ]);
      expect(matched(db, 'event.payload("/emptyObj") isEmpty')).toEqual(view);
      expect(matched(db, 'event.payload("/nil") isNull')).toEqual(a);
      expect(matched(db, 'event.payload("/nil") notExists')).toEqual([
        ...signup,
        ...view,
      ]);
      expect(matched(db, 'event.payload("/nil") notNull')).toEqual(b);
    } finally {
      db.close();
    }
  });

  it("keeps typed IN/NOT IN and case-sensitive text matching scoped to each site", () => {
    const db = sqlitePayloadFixture();
    try {
      expect(matched(db, 'event.payload("/items/0/sku") in ["A", 1]')).toEqual(
        a,
      );
      expect(
        matched(db, 'event.payload("/items/0/sku") notIn ["A", 1]'),
      ).toEqual(b);
      expect(matched(db, 'event.payload("/items/0/sku") notExists')).toEqual([
        ...signup,
        ...view,
      ]);
      expect(matched(db, 'event.payload("/nil") in [null, 2]')).toEqual([
        ...a,
        ...b,
      ]);
      expect(matched(db, 'event.payload("/nil") notIn [null, "A"]')).toEqual(b);
      expect(matched(db, 'event.payload("/search") contains "ABC"')).toEqual(b);
      expect(matched(db, 'event.payload("/search") contains "abc"')).toEqual(a);
      expect(matched(db, 'event.payload("/search") contains "%_"')).toEqual([
        ...a,
        ...b,
      ]);
    } finally {
      db.close();
    }
  });

  it("does not silently route ordinary payload through Visit-only unprepared Reader fallback", () => {
    const db = sqlitePayloadFixture();
    try {
      const filter = parseFilterDsl(
        'event.payload("/items/0/sku") eq "A"',
        analyticsFilterRegistry,
      );
      const sql = scopedDatasetForUnpreparedReader(
        "overview",
        "site-a",
        WINDOW,
        filter,
        "event",
      );
      expect(sql).not.toBeNull();
      expect(sql!.ctes).toContain("pointer_nodes");
      expect(
        select(
          db,
          `WITH ${sql!.ctes} SELECT site_pk, event_id FROM ${sql!.eventRelation} ORDER BY event_id`,
          sql!.bindings.map((item) => item.value),
        ),
      ).toEqual(a);
    } finally {
      db.close();
    }
  });

  it("returns correct real Overview Reader metrics for ordinary prepared and unprepared Payload filters", async () => {
    const db = sqlitePayloadFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      const raw = parseFilterDsl(
        'event.payload("/items/0/sku") eq "A"',
        analyticsFilterRegistry,
      );
      const unprepared = await queryOverviewFromD1(env, "site-a", WINDOW, raw);
      expect(unprepared).toEqual({
        views: 1,
        sessions: 1,
        visitors: 1,
        bounces: 1,
        totalDuration: 20,
        durationViews: 1,
      });
      const plan = createScopedFilterPlan("overview", raw, "session")!;
      const prepared = attachScopedFilterMetadata(raw, {
        requestedScope: "session",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const preparedResult = await queryOverviewFromD1(
        env,
        "site-a",
        WINDOW,
        prepared,
      );
      expect(preparedResult).toEqual(unprepared);
      const missing = parseFilterDsl(
        'event.payload("/items/0/sku") eq "X"',
        analyticsFilterRegistry,
      );
      expect(
        (await queryOverviewFromD1(env, "site-a", WINDOW, missing)).views,
      ).toBe(0);
      expect(
        trace.preparedSql.some((sql) => sql.includes("pointer_nodes")),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("returns correctly isolated Event Overview Reader summary and local EXPLAIN QUERY PLAN", async () => {
    const db = sqlitePayloadFixture();
    try {
      const raw = parseFilterDsl(
        'event.payload("/items/0/sku") eq "A"',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("overview", raw, "event")!;
      const filters = attachScopedFilterMetadata(raw, {
        requestedScope: "event",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      const result = await queryEventTypeOverviewFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        "purchase",
        { includeBreakdowns: false },
      );
      expect(result.summary).toMatchObject({
        events: 1,
        eventTypes: 1,
        sessions: 1,
        visitors: 1,
      });
      const unknownSiteResult = await queryEventTypeOverviewFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        "signup",
        { includeBreakdowns: false },
      );
      expect(unknownSiteResult.summary.events).toBe(0);
      for (let i = 0; i < trace.preparedSql.length; i++) {
        const query = trace.preparedSql[i]!;
        const binds = trace.bindings[i]!;
        const plan = db.prepare("EXPLAIN QUERY PLAN " + query).all(...binds);
        expect(plan.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it("keeps Funnel step Observation Payload results within the final scoped dataset", () => {
    const db = sqlitePayloadFixture();
    try {
      const empty = { version: 1 as const, root: null };
      const plan = createScopedFilterPlan("overview", empty, "event")!;
      const source = compileScopedDatasetSql({
        filters: empty,
        plan,
        siteIds: SITES,
        window: WINDOW,
      });
      const step = parseFilterDsl(
        'event.payload("/items/1/sku") eq "B"',
        analyticsFilterRegistry,
      );
      const result = applyObservationFilterToScopedDataset(
        source,
        step,
        "step_payload",
      );
      expect(result.ctes).toContain("pointer_nodes");
      expect(
        select(
          db,
          `WITH ${source.ctes}, ${result.ctes} SELECT site_pk, event_id FROM ${result.matchedEventRelation} ORDER BY site_pk,event_id`,
          [...source.bindings, ...result.bindings].map((item) => item.value),
        ),
      ).toEqual(a);
    } finally {
      db.close();
    }
  });

  it("keeps Comparison-side parameter ordering and Event-to-Visit report expansion correct", () => {
    const db = sqlitePayloadFixture();
    try {
      const current = dataset('event.payload("/items/0/sku") eq "A"', "event");
      const reference = dataset(
        'event.payload("/items/0/sku") eq "X"',
        "event",
      );
      const rename = (sql: string, prefix: string) =>
        sql
          .replace(/\bscope_[A-Za-z0-9_]*/g, (name) => prefix + "_" + name)
          .replace(/\bvisit_source\b/g, prefix + "_visit_source");
      const combined = select(
        db,
        "WITH " +
          rename(current.ctes, "current") +
          ", " +
          rename(reference.ctes, "reference") +
          " SELECT (SELECT COUNT(*) FROM current_scope_final_events) AS current_count, " +
          "(SELECT COUNT(*) FROM reference_scope_final_events) AS reference_count",
        [...current.bindings, ...reference.bindings].map((item) => item.value),
      );
      expect(combined).toEqual([{ current_count: 1, reference_count: 1 }]);
      const visits = select(
        db,
        "WITH " +
          current.ctes +
          " SELECT site_pk, visit_id FROM " +
          current.visitRelation +
          " ORDER BY site_pk, visit_id",
        current.bindings.map((item) => item.value),
      );
      expect(visits).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
    } finally {
      db.close();
    }
  });
});

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
