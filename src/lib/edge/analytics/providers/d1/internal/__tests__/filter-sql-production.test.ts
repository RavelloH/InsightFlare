// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { executeApiV1Query } from "@/lib/api-v1/analytics/query-application";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition/edge-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  FILTER_SCOPE_CAPABILITIES,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { executePrivateQuery } from "@/lib/edge/analytics/interfaces/dashboard/private";
import { executePublicQuery } from "@/lib/edge/analytics/interfaces/dashboard/public";
import { createComparisonProviders } from "@/lib/edge/analytics/providers/d1/comparison";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { DEFAULT_EVENT_RECORD_SORT } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  queryEventsSummaryFromD1,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/internal/funnels";
import { queryGoalSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-summary";
import { queryGoalTimeseriesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import {
  querySessionsFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { queryJourneyEventsPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import { queryOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { queryTopPagesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesWithTabsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import { queryReferrerSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/referrers";
import {
  applyObservationFilterToScopedDataset,
  compileScopedDatasetSql,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { queryTeamOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/team";
import { queryTeamDashboardForTeam } from "@/lib/edge/analytics/providers/d1/internal/team";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import { queryBrowserRadarFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import { queryReferrerTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import { readSiteVisitorSessions } from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { applyFiltersToUrl } from "@/lib/filter-contract/filter-codec";
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
      "CREATE TABLE custom_event_json_values(event_pk INTEGER, node_id INTEGER, site_pk INTEGER, site_id TEXT, event_name_id INTEGER, path_id INTEGER, occurred_at INTEGER, scope_node_id INTEGER, value_type INTEGER, string_value TEXT, string_hash TEXT, number_value REAL, boolean_value INTEGER)",
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
    "INSERT INTO custom_event_json_values VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    for (const value of expansion.data.values) {
      const node = expansion.data.nodes.find(
        (item) => item.nodeId === value.nodeId,
      )!;
      const eventNameId =
        eventPk === 101 || eventPk === 103
          ? 1
          : eventPk === 102
            ? 2
            : eventPk === 104
              ? 3
              : 4;
      const occurredAt =
        eventPk === 101
          ? 30
          : eventPk === 102
            ? 130
            : eventPk === 103
              ? 160
              : eventPk === 104
                ? 240
                : 150;
      valueStmt.run(
        eventPk,
        value.nodeId,
        sitePk,
        sitePk === 1 ? "site-a" : "site-b",
        eventNameId,
        paths.get(sitePk + "/" + node.path)!,
        occurredAt,
        null,
        value.valueType,
        value.stringValue,
        null,
        value.numberValue,
        value.booleanValue,
      );
    }
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

describe("P5 final: visit-derived real production Readers over typed Event payload", () => {
  function ready(
    operation: string,
    expression = 'event.payload("/items/1/sku") eq "B"',
  ) {
    const doc = parseFilterDsl(expression, analyticsFilterRegistry);
    const plan = createScopedFilterPlan(operation as never, doc, "event")!;
    if (!plan) throw new Error("Missing scoped plan");
    return attachScopedFilterMetadata(doc, {
      requestedScope: "event",
      resolvedScope: plan.scope,
      plan,
      time: createQueryTime(100, 300, "UTC", 400),
      siteIds: ["site-a"],
    });
  }

  function runFixture() {
    const db = sqlitePayloadFixture();
    db.exec(
      "UPDATE visits SET browser='Chrome', os='Windows', device_type='Desktop', country='US', region='California', city='LA', latitude=34.05, longitude=-118.25, referrer_host='example.com', referrer_url='https://example.com/from', utm_source='google', perf_ttfb_ms=100, perf_fcp_ms=200, perf_lcp_ms=300 WHERE site_pk=1 AND visit_id='v-new'",
    );
    db.exec(
      "UPDATE visits SET browser='Firefox', os='Linux', device_type='Mobile', country='CA', latitude=45, longitude=-75, referrer_host='other.example' WHERE site_pk=1 AND visit_id='v-docs'",
    );
    db.exec(
      "UPDATE visits SET browser='Safari', os='iOS', device_type='Mobile', country='FR', latitude=48, longitude=2, referrer_host='foreign.example' WHERE site_pk=2",
    );
    return { db, env: { DB: createSqliteD1Database(db) } as never };
  }

  it("Dimension and CrossDimension return only the scoped Page/browser cells", async () => {
    const { db, env } = runFixture();
    try {
      const dimension = ready("dimension");
      const rows = await queryDimensionFromD1(
        env,
        "site-a",
        WINDOW,
        dimension,
        10,
        "pathname",
      );
      expect(rows).toEqual([
        expect.objectContaining({ value: "/home", views: 1 }),
      ]);
      expect(
        await queryDimensionFromD1(
          env,
          "site-b",
          WINDOW,
          dimension,
          10,
          "pathname",
        ),
      ).toEqual([]);
      const primary = resolveCrossBreakdownDimension("page.path")!;
      const secondary = resolveCrossBreakdownDimension("client.browser")!;
      expect(primary).not.toBeNull();
      expect(secondary).not.toBeNull();
      const cross = await queryCrossDimensionFromD1(
        env,
        "site-a",
        WINDOW,
        ready("cross-dimension"),
        10,
        10,
        primary,
        secondary,
      );
      expect(cross).toMatchObject({});
      expect(JSON.stringify(cross)).toContain("Chrome");
      expect(JSON.stringify(cross)).not.toContain("Firefox");
    } finally {
      db.close();
    }
  });

  it("ShareTrend, Radar, PagesDashboard and Channel show selected Visit only", async () => {
    const { db, env } = runFixture();
    try {
      const trends = await queryReferrerTrendFromD1(
        env,
        "site-a",
        WINDOW,
        "minute",
        ready("share-trend"),
        10,
      );
      expect(JSON.stringify(trends)).toContain("example.com");
      expect(JSON.stringify(trends)).not.toContain("other.example");
      const radar = await queryBrowserRadarFromD1(
        env,
        "site-a",
        WINDOW,
        ready("radar"),
      );
      expect(radar).toEqual([
        expect.objectContaining({ browser: "Chrome", sessions: 1 }),
      ]);
      const pages = await queryPagesWithTabsFromD1(
        env,
        "site-a",
        WINDOW,
        ready("pages-dashboard"),
        10,
        false,
      );
      expect(JSON.stringify(pages)).toContain("/home");
      expect(JSON.stringify(pages)).not.toContain("/docs");
      const channel = await queryChannelAggregate(
        env,
        "site-a",
        WINDOW,
        ready("channels"),
        10,
      );
      expect(channel.reduce((sum, item) => sum + item.views, 0)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("FilterValues, Retention, Geo and Performance aggregate only authorized matches", async () => {
    const { db, env } = runFixture();
    try {
      const values = await queryFilterValuesPageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("filter-values"),
        "geo.country",
        10,
      );
      expect(values.items).toEqual([
        expect.objectContaining({ value: "US", occurrences: 1 }),
      ]);
      const retention = await queryRetentionFromD1(
        env,
        "site-a",
        WINDOW,
        ready("retention"),
        "minute",
      );
      expect(
        retention.cohorts.reduce((sum, cohort) => sum + cohort.size, 0),
      ).toBe(1);
      const geo = await queryGeoPointAggregate(
        env,
        "site-a",
        WINDOW,
        ready("geo-points"),
        10,
      );
      expect(JSON.stringify(geo)).toContain("US");
      expect(JSON.stringify(geo)).not.toContain("CA");
      const performance = await queryPerformanceDashboardFromD1(
        env,
        "site-a",
        WINDOW,
        "minute",
        ready("performance"),
        10,
      );
      expect(JSON.stringify(performance)).toContain("/home");
      expect(JSON.stringify(performance)).not.toContain("/docs");
    } finally {
      db.close();
    }
  });

  it("EventSummary, Trend and EventTypes return only the matching typed Event", async () => {
    const { db, env } = runFixture();
    try {
      const summary = await queryEventsSummaryFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-summary"),
      );
      expect(summary.summary).toEqual({
        events: 1,
        eventTypes: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(summary.cards.event.name).toEqual([
        { value: "purchase", views: 1, sessions: 1, visitors: 1 },
      ]);
      expect(
        (
          await queryEventsSummaryFromD1(
            env,
            "site-b",
            WINDOW,
            ready("event-summary"),
          )
        ).summary.events,
      ).toBe(0);
      const trend = await queryEventsTrendFromD1(
        env,
        "site-a",
        WINDOW,
        "minute",
        ready("event-trend"),
        10,
      );
      expect(trend.series).toEqual([
        expect.objectContaining({ eventName: "purchase", events: 1 }),
      ]);
      expect(trend.data.reduce((sum, row) => sum + row.totalEvents, 0)).toBe(1);
      const types = await queryEventTypePageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-types"),
        10,
      );
      expect(types.items).toEqual([
        { value: "purchase", views: 1, sessions: 1, visitors: 1 },
      ]);
      expect(
        (
          await queryEventTypePageFromD1(
            env,
            "site-b",
            WINDOW,
            ready("event-types"),
            10,
          )
        ).items,
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("EventFields, FieldValues and Context calculate typed JSON and source cards from actual matches", async () => {
    const { db, env } = runFixture();
    try {
      const fields = await queryEventFieldsPageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-fields"),
        "purchase",
        50,
      );
      expect(fields.items.map((row) => row.path)).toContain("/items/*/sku");
      expect(
        fields.items
          .filter((row) => row.path === "/items/*/sku")
          .map((row) => row.occurrences),
      ).toEqual([2]);
      const values = await queryEventFieldValuesPageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-field-values"),
        "purchase",
        "/items/*/sku",
        "string",
        20,
      );
      expect(values.items.map((row) => row.stringValue).sort()).toEqual([
        "A",
        "B",
      ]);
      const context = await queryEventAnalyticsContextCardsFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-context"),
        10,
        "purchase",
        ["path", "browser", "country"],
      );
      expect(JSON.stringify(context)).toContain("/home");
      expect(JSON.stringify(context)).toContain("Chrome");
      expect(JSON.stringify(context)).not.toContain("/docs");
      expect(
        (
          await queryEventFieldsPageFromD1(
            env,
            "site-b",
            WINDOW,
            ready("event-fields"),
            "purchase",
            50,
          )
        ).items,
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("EventRecords and visitor/session Journey read only authorized Event membership", async () => {
    const { db, env } = runFixture();
    try {
      const records = await queryEventRecordPageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("event-records"),
        { limit: 20, sort: DEFAULT_EVENT_RECORD_SORT },
      );
      expect(records.rows.map((row) => row.eventId)).toEqual(["e-purchase"]);
      expect(
        (
          await queryEventRecordPageFromD1(
            env,
            "site-b",
            WINDOW,
            ready("event-records"),
            { limit: 20, sort: DEFAULT_EVENT_RECORD_SORT },
          )
        ).rows,
      ).toEqual([]);
      const scope = (operation: string, kind: "visitor" | "session") => {
        const doc = parseFilterDsl(
          'event.payload("/items/1/sku") eq "B"',
          analyticsFilterRegistry,
        );
        const plan = createScopedFilterPlan(operation as never, doc, kind)!;
        return attachScopedFilterMetadata(doc, {
          requestedScope: kind,
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
      };
      for (const [operation, kind] of [
        ["visitor-events", "visitor"],
        ["session-events", "session"],
      ] as const) {
        const target = { type: kind, value: kind === "visitor" ? "u1" : "s1" };
        const page = await queryJourneyEventsPageFromD1(
          env,
          "site-a",
          WINDOW,
          scope(operation, kind),
          target,
          30,
        );
        expect(
          page.items
            .filter((item) => item.kind === "custom")
            .map((item) => item.id),
        ).toEqual(expect.arrayContaining(["e-purchase"]));
        expect(
          (
            await queryJourneyEventsPageFromD1(
              env,
              "site-b",
              WINDOW,
              scope(operation, kind),
              target,
              30,
            )
          ).items,
        ).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it("Comparison overview and breakdown providers return the real selected Event and Visit metrics", async () => {
    const { db, env } = runFixture();
    try {
      const filters = ready("comparison");
      const query = { time: createQueryTime(100, 300, "UTC", 400), filters };
      const context = siteQueryContext("site-a", "private-dashboard");
      const comparison = {
        context,
        current: query,
        reference: query,
        metrics: ["views" as const],
      };
      const provider = createComparisonProviders({ env, siteId: "site-a" });
      const overview = await provider.overview({
        side: "current",
        context,
        query,
        comparison,
      });
      expect(overview.value).toMatchObject({
        views: 1,
        sessions: 1,
        visitors: 1,
        events: 1,
      });
      const breakdown = await provider.breakdown({
        side: "current",
        context,
        query,
        comparison: {
          ...comparison,
          dimension: "page.path",
          limit: 10,
          sort: { by: "current.views" as const, direction: "desc" as const },
        },
      });
      expect(breakdown.value.items).toEqual([
        expect.objectContaining({
          key: "/home",
          views: 1,
          sessions: 1,
          visitors: 1,
        }),
      ]);
      const reference = {
        ...query,
        filters: ready(
          "comparison",
          'event.payload("/items/1/sku") eq "not-present"',
        ),
      };
      expect(
        (
          await provider.overview({
            side: "reference",
            context,
            query: reference,
            comparison: { ...comparison, reference },
          })
        ).value.views,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("GoalSummary and GoalTimeseries evaluate real event conversion on scoped sessions", async () => {
    const { db, env } = runFixture();
    try {
      const goal = parseFilterDsl(
        'event.name eq "purchase"',
        analyticsFilterRegistry,
      );
      const filtered = ready("goal-summary");
      const summary = await queryGoalSummaryFromD1(
        env,
        "site-a",
        WINDOW,
        filtered,
        goal,
      );
      expect(summary).toEqual({
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
      });
      const series = await queryGoalTimeseriesFromD1(
        env,
        "site-a",
        WINDOW,
        "minute",
        ready("goal-timeseries"),
        goal,
      );
      expect(series.reduce((sum, row) => sum + row.convertedSessions, 0)).toBe(
        1,
      );
      const missing = await queryGoalSummaryFromD1(
        env,
        "site-a",
        WINDOW,
        filtered,
        parseFilterDsl('event.name eq "absent"', analyticsFilterRegistry),
      );
      expect(missing).toEqual({
        totalSessions: 1,
        convertedSessions: 0,
        totalVisitors: 1,
        convertedVisitors: 0,
      });
    } finally {
      db.close();
    }
  });

  it("Funnel SQL distinguishes Event-only and expanded Session scope for signup→purchase", async () => {
    const { db, env } = runFixture();
    try {
      const config = {
        filterDslVersion: 1 as const,
        progressionScope: "session" as const,
        conversionWindowMs: null,
        steps: [
          { id: "signup", filterDsl: 'event.name eq "signup"' },
          { id: "purchase", filterDsl: 'event.name eq "purchase"' },
        ],
      };
      const eventOnly = await queryFunnelAnalysis(
        env,
        "site-a",
        WINDOW,
        ready("funnel-analysis"),
        config,
      );
      expect(eventOnly.summary.totalProgressions).toBe(0);
      const sessionDoc = parseFilterDsl(
        'count(EVENT { $.name eq "purchase" }) eq 1',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan(
        "funnel-analysis",
        sessionDoc,
        "session",
      )!;
      const sessionFilters = attachScopedFilterMetadata(sessionDoc, {
        requestedScope: "session",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const full = await queryFunnelAnalysis(
        env,
        "site-a",
        WINDOW,
        sessionFilters,
        config,
      );
      expect(full.summary.totalProgressions).toBe(1);
      expect(full.summary.convertedProgressions).toBe(1);
      expect(
        (
          await queryFunnelAnalysis(
            env,
            "site-b",
            WINDOW,
            sessionFilters,
            config,
          )
        ).summary.totalProgressions,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("TeamSites and TeamDashboard report only member-authorized sites and their filtered metrics", async () => {
    const { db, env } = runFixture();
    try {
      db.exec(
        "CREATE TABLE sites(id TEXT PRIMARY KEY, team_id TEXT, name TEXT, domain TEXT, public_enabled INTEGER, public_slug TEXT, created_at INTEGER, updated_at INTEGER)",
      );
      db.exec(
        "INSERT INTO sites VALUES ('site-a','team-1','A','a.test',1,'a',1,1),('site-b','team-1','B','b.test',1,'b',2,2)",
      );
      const result = await readTeamSites({
        env,
        teamId: "team-1",
        window: WINDOW,
        filters: ready("team-sites"),
        allowedSiteIds: ["site-a"],
        page: { limit: 10, cursor: null },
      });
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]).toMatchObject({
        siteId: "site-a",
        metrics: { views: 1, sessions: 1, visitors: 1 },
      });
      const preloaded = [
        {
          id: "site-a",
          name: "A",
          domain: "a.test",
          teamId: "team-1",
          publicEnabled: 1,
          publicSlug: "a",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "site-b",
          name: "B",
          domain: "b.test",
          teamId: "team-1",
          publicEnabled: 1,
          publicSlug: "b",
          createdAt: 2,
          updatedAt: 2,
        },
      ] as never;
      const dashboard = await queryTeamDashboardForTeam(
        env,
        "team-1",
        WINDOW,
        "minute",
        ["site-a"],
        undefined,
        preloaded,
        ready("team-dashboard"),
      );
      expect(dashboard.data.sites).toHaveLength(1);
      expect(dashboard.data.sites[0]).toMatchObject({
        id: "site-a",
        overview: { views: 1, sessions: 1, visitors: 1 },
      });
      expect(
        dashboard.data.trend
          .flatMap((row) => row.sites)
          .map((row) => row.siteId),
      ).toEqual(["site-a"]);
    } finally {
      db.close();
    }
  });

  it("VisitorSessions uses real Reader membership and isolates same named visitors on other sites", async () => {
    const { db, env } = runFixture();
    try {
      const request = {
        env,
        siteId: "site-a",
        visitorId: "u1",
        window: WINDOW,
        filters: ready("visitor-sessions"),
        page: { limit: 20, cursor: null },
        audience: "private-dashboard" as const,
      };
      const result = await readSiteVisitorSessions(request);
      expect(result.items.map((row) => row.sessionId)).toEqual(["s1"]);
      const other = await readSiteVisitorSessions({
        ...request,
        siteId: "site-b",
      });
      expect(other.items).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("TeamDashboard never treats an explicitly empty authorization list as unlimited", async () => {
    const db = sqlitePayloadFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      const sites = [
        { id: "site-a", name: "A", teamId: "team-1", domain: "a.test" },
        { id: "site-b", name: "B", teamId: "team-1", domain: "b.test" },
      ] as never;
      const denied = await queryTeamDashboardForTeam(
        env,
        "team-1",
        WINDOW,
        "minute",
        [],
        undefined,
        sites,
        ready("team-dashboard"),
      );
      expect(denied.data).toEqual({ sites: [], trend: [] });
      expect(trace.preparedSql).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("real Private/Public query adapters serialize Filter DSL into actual Overview responses", async () => {
    const { db, env } = runFixture();
    try {
      const url = (expr: string) =>
        applyFiltersToUrl(
          new URL(
            "https://app.test/api/public/share/demo/overview?from=100&to=300&timeZone=UTC",
          ),
          parseFilterDsl(expr, analyticsFilterRegistry),
          analyticsFilterRegistry,
        );
      const publicAllowed = url('page.path eq "/home"');
      const shared = await executePublicQuery({
        env,
        siteId: "site-a",
        pathname: "overview",
        url: publicAllowed,
        request: new Request(publicAllowed),
      });
      expect(shared.status).toBe(200);
      expect(await shared.json()).toMatchObject({
        ok: true,
        data: { views: 1, sessions: 1, visitors: 1 },
      });
      const excluded = await executePublicQuery({
        env,
        siteId: "site-a",
        pathname: "overview",
        url: url('page.path eq "/not-present"'),
      });
      expect(excluded.status).toBe(200);
      expect(await excluded.json()).toMatchObject({
        ok: true,
        data: { views: 0 },
      });
      const privateUrl = url('event.payload("/items/1/sku") eq "B"');
      const privateResponse = await executePrivateQuery({
        env,
        siteId: "site-a",
        pathname: "overview",
        url: privateUrl,
        request: new Request(privateUrl),
      });
      expect(privateResponse.status).toBe(200);
      expect(await privateResponse.json()).toMatchObject({
        ok: true,
        data: { views: 1, sessions: 1, visitors: 1 },
      });
      const privateOther = await executePrivateQuery({
        env,
        siteId: "site-b",
        pathname: "overview",
        url: privateUrl,
        request: new Request(privateUrl),
      });
      expect(privateOther.status).toBe(200);
      expect(await privateOther.json()).toMatchObject({
        ok: true,
        data: { views: 0 },
      });
    } finally {
      db.close();
    }
  });

  it("API v1 canonical application returns real scoped Overview data and rejects forbidden operations before SQL", async () => {
    const db = sqlitePayloadFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId: "site-a" });
      const context = siteQueryContext("site-a", "api-v1");
      const query = {
        time: createQueryTime(100, 300, "UTC", 400),
        filters: ready("overview"),
      };
      const result = await executeApiV1Query(
        undefined,
        {
          operation: "site.analytics.overview",
          executor: runtime,
          context,
          query,
        } as never,
        {},
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).toContain('"views":1');
      expect(
        trace.preparedSql.some((sql) => sql.includes("pointer_nodes")),
      ).toBe(true);
      const count = trace.preparedSql.length;
      const denied = {
        ...context,
        policy: { ...context.policy, allowedOperations: new Set() },
      };
      const negative = await executeApiV1Query(
        undefined,
        {
          operation: "site.analytics.overview",
          executor: runtime,
          context: denied,
          query: { ...query, context: denied },
        } as never,
        {},
      );
      expect(negative).toMatchObject({
        ok: false,
        error: { kind: "operation-not-allowed" },
      });
      expect(trace.preparedSql).toHaveLength(count);
    } finally {
      db.close();
    }
  });

  it("public sharing denies hidden details and private-only operations before touching D1", async () => {
    const db = sqlitePayloadFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      const base = "https://app.test/api/public/share/demo/";
      for (const [pathname, query] of [
        ["overview", "?query=confidential"],
        ["overview", "?primaryDimension=page.query"],
        ["overview", "?sourceLink=private"],
        ["events-records", ""],
        ["visitor-events", ""],
        ["sessions", ""],
      ] as const) {
        const url = new URL(base + pathname + query);
        const res = await executePublicQuery({
          env,
          siteId: "site-a",
          pathname,
          url,
        });
        expect(res.status).toBe(404);
      }
      expect(trace.preparedSql).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
