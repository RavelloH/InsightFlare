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
  FILTER_SCOPE_CAPABILITIES,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  querySessionsFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { queryOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { queryTopPagesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryReferrerSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/referrers";
import {
  applyObservationFilterToScopedDataset,
  compileScopedDatasetSql,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { queryTeamOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/team";
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
    [102, 1, { items: [], hetero: null }],
    [
      103,
      1,
      {
        items: [{ sku: "A" }, { sku: "B" }],
        "0": "literal-zero",
        "*": "literal-star",
        nested: { "a/b": 7, "~tag": 8 },
        nil: null,
        hetero: "A",
        enabled: false,
        search: "abc%_\\Suffix",
      },
    ],
    [104, 1, { emptyObj: {}, misc: "other", hetero: false }],
    [
      201,
      2,
      {
        items: [{ sku: "X" }, { sku: "Y" }],
        nil: 2,
        hetero: 1,
        search: "ABC%_\\suffix",
      },
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

  it("FSQL-08 compares differing String, Number and Boolean Payload types as unequal", () => {
    const db = sqlitePayloadFixture();
    try {
      const check = (expr: string) =>
        matched(db, 'event.payload("/hetero") ' + expr);
      expect(check('eq "A"')).toEqual(a);
      expect(check('neq "A"')).toEqual([...view, ...b]);
      expect(check('notIn ["A"]')).toEqual([...signup, ...view, ...b]);
      expect(check("neq 1")).toEqual([...a, ...view]);
      expect(check("notIn [1]")).toEqual([...a, ...signup, ...view]);
      expect(check("neq false")).toEqual([...a, ...b]);
      expect(check("notIn [false]")).toEqual([...a, ...signup, ...b]);
      expect(check("eq false")).toEqual(view);
      expect(check("neq 0")).toEqual([...a, ...view, ...b]);
      expect(check("neq true")).toEqual([...a, ...view, ...b]);
      expect(check('in [null, "A"]')).toEqual([...a, ...signup]);
      expect(check('notIn [null, "A"]')).toEqual([...view, ...b]);
      expect(check('neq "missing"')).toEqual([...a, ...view, ...b]);
      expect(matched(db, 'event.payload("/items") neq "A"')).toEqual([]);
      expect(matched(db, 'event.payload("/missing") neq "A"')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("FSQL-08 uses the same typed NEQ inside advanced current-payload selectors", () => {
    const db = sqlitePayloadFixture();
    try {
      const matchedVisits = (expr: string) => {
        const result = dataset(
          'EVENT { $.payload("/hetero") ' + expr + " } exists",
          "session",
        );
        return select(
          db,
          "WITH " +
            result.ctes +
            " SELECT site_pk,visit_id FROM " +
            result.visitRelation +
            " ORDER BY site_pk,visit_id",
          result.bindings.map((binding) => binding.value),
        );
      };
      expect(matchedVisits('neq "A"')).toEqual([
        { site_pk: 1, visit_id: "v-docs" },
        { site_pk: 2, visit_id: "v-new" },
      ]);
      expect(matchedVisits('notIn ["A"]')).toEqual([
        { site_pk: 1, visit_id: "v-docs" },
        { site_pk: 1, visit_id: "v-new" },
        { site_pk: 2, visit_id: "v-new" },
      ]);
      expect(matchedVisits("neq 1")).toEqual([
        { site_pk: 1, visit_id: "v-docs" },
        { site_pk: 1, visit_id: "v-new" },
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

  it("executes real Pages, Trend, Referrers and Team Reader output with authorized site scope", async () => {
    const db = sqlitePayloadFixture();
    try {
      const raw = parseFilterDsl(
        'event.payload("/items/1/sku") eq "B"',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("pages", raw, "event")!;
      const filters = attachScopedFilterMetadata(raw, {
        requestedScope: "event",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;

      expect(
        await queryTopPagesFromD1(env, "site-a", WINDOW, 10, false, filters),
      ).toEqual([
        { pathname: "/home", query: "", hash: "", views: 1, sessions: 1 },
      ]);
      expect(
        await queryTopPagesFromD1(env, "site-b", WINDOW, 10, false, filters),
      ).toEqual([]);

      const trend = await queryTrendFromD1(
        env,
        "site-a",
        WINDOW,
        "minute",
        filters,
      );
      expect(trend.map((item) => item.views).reduce((a, b) => a + b, 0)).toBe(
        1,
      );
      expect(
        trend.map((item) => item.visitors).reduce((a, b) => a + b, 0),
      ).toBe(1);
      expect(
        (await queryTrendFromD1(env, "site-b", WINDOW, "minute", filters))
          .map((item) => item.views)
          .reduce((a, b) => a + b, 0),
      ).toBe(0);

      const refs = await queryReferrerSummaryFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        5,
      );
      expect(refs).toMatchObject({
        totalViews: 1,
        directViews: 1,
        externalViews: 0,
        uniqueDomains: 0,
      });
      expect(
        (await queryReferrerSummaryFromD1(env, "site-b", WINDOW, filters, 5))
          .totalViews,
      ).toBe(0);

      const team = await queryTeamOverviewFromD1(
        env,
        ["site-a", "site-b"],
        WINDOW,
        undefined,
        filters,
      );
      expect(team.get("site-a")).toMatchObject({
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(team.get("site-b")?.views ?? 0).toBe(0);
      expect(
        trace.preparedSql.filter((sql) => sql.includes("pointer_nodes")).length,
      ).toBeGreaterThanOrEqual(6);
    } finally {
      db.close();
    }
  });

  it("returns correct prepared visitor and session Reader rows with no cross-site collisions", async () => {
    const db = sqlitePayloadFixture();
    try {
      const raw = parseFilterDsl(
        'event.payload("/items/1/sku") eq "B"',
        analyticsFilterRegistry,
      );
      const env = { DB: createSqliteD1Database(db) } as never;
      const filtered = (
        op: "visitors" | "sessions",
        scope: "visitor" | "session",
      ) => {
        const plan = createScopedFilterPlan(op, raw, scope)!;
        return attachScopedFilterMetadata(raw, {
          requestedScope: scope,
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
      };
      const visitors = filtered("visitors", "visitor");
      const sessions = filtered("sessions", "session");
      const siteAVisitors = await queryVisitorsFromD1(
        env,
        "site-a",
        WINDOW,
        visitors,
        10,
      );
      const siteASessions = await querySessionsFromD1(
        env,
        "site-a",
        WINDOW,
        sessions,
        10,
      );
      expect(siteAVisitors.map((item) => item.visitorId)).toEqual(["u1"]);
      expect(siteASessions.map((item) => item.sessionId)).toEqual(["s1"]);
      expect(
        await queryVisitorsFromD1(env, "site-b", WINDOW, visitors, 10),
      ).toEqual([]);
      expect(
        await querySessionsFromD1(env, "site-b", WINDOW, sessions, 10),
      ).toEqual([]);
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

describe("P5 execution matrix across 35 operation scope contracts", () => {
  const operations = Object.entries(FILTER_SCOPE_CAPABILITIES).filter(
    ([, capability]) => capability.kind === "scoped",
  );
  const negative = 'count(EVENT { $.name eq "purchase" }) eq 2';
  const positive = 'count(EVENT { $.name eq "purchase" }) eq 1';

  it.each(operations)(
    "executes real SQLite dataset rows for %s",
    (operation, capability) => {
      if (capability.kind !== "scoped")
        throw new Error("Expected scoped operation");
      const db = sqliteFixture();
      try {
        for (const [expression, matches] of [
          [positive, true],
          [negative, false],
        ] as const) {
          const document = parseFilterDsl(expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan(operation as never, document)!;
          expect(plan).not.toBeNull();
          expect(plan.scope).toBe(capability.autoScope);
          const filters = attachScopedFilterMetadata(document, {
            requestedScope: plan.scope,
            resolvedScope: plan.scope,
            plan,
            time: createQueryTime(100, 300, "UTC", 400),
            siteIds: SITES,
          });
          const result = compileScopedDatasetSql({
            filters,
            plan,
            siteIds: SITES,
            window: WINDOW,
          });
          const rows = select(
            db,
            "WITH " +
              result.ctes +
              " SELECT site_pk, visit_id FROM " +
              result.visitRelation +
              " ORDER BY site_pk, visit_id",
            result.bindings.map((b) => b.value),
          );
          if (matches) {
            expect(rows).toEqual([
              { site_pk: 1, visit_id: "v-new" },
              { site_pk: 2, visit_id: "v-new" },
            ]);
          } else {
            expect(rows).toEqual([]);
          }
          expect(result.ctes).not.toContain("scope_advanced_matching_entities");
        }
      } finally {
        db.close();
      }
    },
  );
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
