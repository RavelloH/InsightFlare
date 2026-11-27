// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { executeApiV1Query } from "@/lib/api-v1/analytics/query-application";
import { startSiteAnalyticsStream } from "@/lib/dashboard/server/query";
import { SYSTEM_FILTER_PRESETS } from "@/lib/dashboard/system-filter-presets";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition/edge-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  createTimeRange,
  EMPTY_FILTER_DOCUMENT,
  FILTER_SCOPE_CAPABILITIES,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { executePrivateQuery } from "@/lib/edge/analytics/interfaces/dashboard/private";
import { executePublicQuery } from "@/lib/edge/analytics/interfaces/dashboard/public";
import { createComparisonProviders } from "@/lib/edge/analytics/providers/d1/comparison";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  decodeComparisonDimensionCursor,
  eventComparisonExpression,
  queryComparisonDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { DEFAULT_EVENT_RECORD_SORT } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import {
  decodeDimensionCursor,
  type DimensionAggregateCursor,
  queryDimensionFromD1,
  queryDimensionPageFromD1,
  runWithDimensionPageBatch,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  queryEventsSummaryFromD1,
  queryEventTotalFromD1,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTotalsTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import {
  buildFunnelMembershipSqlPlan,
  buildFunnelSqlPlan,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-planner";
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
import {
  queryTeamDashboardForTeam,
  queryTeamOverviewFromD1,
  queryTeamScopedCurrentFromD1,
  queryTeamTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import { queryBrowserRadarFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import { queryReferrerTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import { readSiteVisitorSessions } from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { registerHotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import { currentQueryIdentity } from "@/lib/edge/analytics-engine/query-registry";
import * as siteAccess from "@/lib/edge/auth/site-access";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
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

  it("constrains each exact JSON Pointer child lookup by both Event and parent node", () => {
    const db = sqlitePayloadFixture();
    try {
      db.exec(
        "CREATE INDEX idx_custom_event_nodes_event_parent ON custom_event_json_nodes(event_pk, parent_node_id, member_order, array_index)",
      );
      const statement = dataset(
        'event.payload("/items/1/sku") eq "B"',
        "event",
      );
      const query = `EXPLAIN QUERY PLAN WITH ${statement.ctes}
        SELECT COUNT(*) AS matched FROM ${statement.eventRelation}`;
      const plan = db
        .prepare(query)
        .all(...statement.bindings.map((binding) => binding.value));
      const childLookups = plan
        .map((row) => String(row.detail))
        .filter((detail) =>
          detail.includes(
            "SEARCH child USING INDEX idx_custom_event_nodes_event_parent",
          ),
        );
      expect(childLookups.length).toBeGreaterThan(0);
      expect(
        childLookups.every((detail) =>
          detail.includes("(event_pk=? AND parent_node_id=?)"),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

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
  it("shares only same-grain non-event fact predicates and preserves other strategies", () => {
    for (const [scope, expression, shared] of [
      ["session", "session.views gte 2", true],
      ["session", "session.durationMs gte 0 and session.views gte 2", true],
      ["visitor", "visitor.sessions gte 2", true],
      ["visitor", "visitor.views gte 0 and visitor.sessions gte 2", true],
      ["session", "session.events gte 1", false],
      ["visitor", "visitor.events gte 1", false],
      ["session", "session.views gte 1 or session.events gte 1", false],
      ["visitor", "not (visitor.sessions gte 2)", false],
      ["visitor", "session.views gte 1", false],
    ] as const) {
      const result = dataset(expression, scope);
      const optimized =
        scope === "session"
          ? result.ctes.includes("scope_session_totals AS (")
          : result.ctes.includes("scope_visitor_facts AS (") &&
            !result.ctes.includes("scope_visitor_visit_facts AS (");
      expect(optimized, expression).toBe(shared);
    }
  });

  it("combines same-grain fact AND evidence once without changing membership intersections", () => {
    const db = sqliteFixture();
    try {
      for (const [scope, predicates] of [
        [
          "session",
          [
            "session.views gte 1",
            "session.durationMs gte 0",
            "session.bounce eq true",
          ],
        ],
        [
          "visitor",
          [
            "visitor.views gte 1",
            "visitor.sessions gte 1",
            "visitor.views lt 100",
          ],
        ],
        ["session", ["session.views gte 100000", "session.durationMs gte 0"]],
        ["visitor", ["visitor.sessions gte 100000", "visitor.views gte 0"]],
      ] as const) {
        const combined = dataset(predicates.join(" and "), scope);
        expect(combined.ctes).toContain("scope_shared_fact_membership AS (");
        expect(combined.ctes).not.toContain("first_child");
        const column = scope === "session" ? "session_id" : "visitor_id";
        const read = (expression: string) => {
          const result = dataset(expression, scope);
          return select(
            db,
            `WITH ${result.ctes} SELECT DISTINCT site_pk,${column} AS entity_id FROM ${scope === "session" ? result.sessionRelation : result.visitorRelation} ORDER BY site_pk,entity_id`,
            result.bindings.map((b) => b.value),
          );
        };
        const sets = predicates.map((p) =>
          read(p).map((row) => JSON.stringify(row)),
        );
        const expected = sets[0].filter((row) =>
          sets.slice(1).every((set) => set.includes(row)),
        );
        expect(
          read(predicates.join(" and ")).map((row) => JSON.stringify(row)),
        ).toEqual(expected);
      }
      const mixed = dataset("session.views gte 1 and session.events gte 1");
      expect(mixed.ctes).not.toContain("scope_shared_fact_membership AS (");
    } finally {
      db.close();
    }
  });

  it("qualifies positive event counts directly but retains zero-count and cross-grain membership", () => {
    const db = sqliteFixture();
    try {
      for (const scope of ["session", "visitor"] as const) {
        const column = scope === "session" ? "session_id" : "visitor_id";
        for (const predicate of [
          "gte 1",
          "eq 1",
          "gt 0",
          "gt 1",
          "eq 0",
          "gte 0",
          "lte 1",
        ]) {
          const expression = `${scope}.events ${predicate}`;
          const result = dataset(expression, scope);
          const direct = ["gte 1", "eq 1", "gt 0", "gt 1"].includes(predicate);
          expect(result.ctes.includes("HAVING COUNT(*)"), expression).toBe(
            direct,
          );
          expect(
            result.ctes.includes(`scope_${scope}_facts AS (`),
            expression,
          ).toBe(!direct);
          const read = (compiled: ReturnType<typeof dataset>) =>
            select(
              db,
              `WITH ${compiled.ctes} SELECT DISTINCT site_pk,${column} AS entity_id
              FROM ${scope === "session" ? compiled.sessionRelation : compiled.visitorRelation}
              ORDER BY site_pk,entity_id`,
              compiled.bindings.map((b) => b.value),
            );
          // A redundant, always-true nonnegative count comparison forces the
          // legacy fact path without altering the membership.
          const legacy = dataset(
            `${expression} and ${scope}.events gte 0`,
            scope,
          );
          expect(legacy.ctes).toContain(`scope_${scope}_facts AS (`);
          expect(read(result), expression).toEqual(read(legacy));
        }
      }
      const cross = dataset("session.events gte 1", "visitor");
      expect(cross.ctes).toContain("scope_session_facts AS (");
    } finally {
      db.close();
    }
  });

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

  it("merges authorized canonical API dimension queries without merging denied children", async () => {
    const db = sqlitePayloadFixture();
    try {
      db.exec(
        "UPDATE visits SET country='US' WHERE site_pk=1 AND visit_id='v-new'",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const identities: string[] = [];
      const real = createSqliteD1Database(db, trace);
      const env = {
        DB: {
          prepare(sql: string) {
            identities.push(currentQueryIdentity().id);
            return real.prepare(sql);
          },
        },
        DAILY_SALT_SECRET: "test-secret",
      } as never;
      const context = siteQueryContext("site-a", "api-v1");
      const filters = parseFilterDsl(
        'geo.country eq "US"',
        analyticsFilterRegistry,
      );
      const denied = {
        ...context,
        policy: { ...context.policy, allowedOperations: new Set<never>() },
      };
      const read = (dimension: string, policy = context) =>
        executeApiV1Query(
          undefined,
          {
            operation: "site.analytics.breakdown",
            executor: createEdgeSiteAnalyticsRuntime({ env, siteId: "site-a" }),
            context: policy,
            query: {
              siteId: "site-a",
              dimension,
              startMs: 100,
              endExclusiveMs: 300,
              timeZone: "UTC",
              filters,
              scopePreference: "session",
              limit: 1,
            },
          } as never,
          { capturedAtMs: 400 },
        );
      const separate = await Promise.all([
        read("page.path"),
        read("geo.country"),
      ]);
      expect(separate.every((result) => result.ok)).toBe(true);
      trace.preparedSql.length = 0;
      identities.length = 0;
      const results = await runWithDimensionPageBatch(() =>
        Promise.all([
          read("page.path"),
          read("geo.country"),
          read("client.browser", denied),
        ]),
      );
      expect(results.slice(0, 2)).toEqual(separate);
      expect(results[2]).toMatchObject({
        ok: false,
        error: { kind: "operation-not-allowed" },
      });
      expect(trace.preparedSql).toHaveLength(1);
      expect(identities).toEqual(["analytics.dimension.batch"]);
    } finally {
      db.close();
    }
  });

  it("shares real private overview adapter reads while preserving geography filter semantics", async () => {
    const db = sqlitePayloadFixture();
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    try {
      db.exec(
        "UPDATE visits SET country='US', browser='Chrome' WHERE site_pk=1 AND visit_id='v-new'; UPDATE visits SET country='CA', browser='Firefox' WHERE site_pk=1 AND visit_id='v-docs'",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = instrumentEnv(
        {
          DB: createSqliteD1Database(db, trace),
          DAILY_SALT_SECRET: "test-secret",
        } as never,
        logger,
      );
      const paths = [
        "overview-page-path",
        "overview-client-browser",
        "overview-geo-country",
      ];
      const read = async (
        pathname: string,
        field = "page.path",
        value = "/home",
      ) => {
        const url = new URL("https://app.test/api/private/" + pathname);
        for (const [key, val] of Object.entries({
          siteId: "site-a",
          from: "100",
          to: "300",
          timeZone: "UTC",
          scope: "session",
          limit: "100",
          ["filter[" + field + "]"]: value,
        }))
          url.searchParams.set(key, val);
        const response = await executePrivateQuery({
          env,
          siteId: "site-a",
          pathname,
          url,
          request: new Request(url),
          dashboardMode: true,
          batchExecution: { capturedAtMs: 400 },
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: unknown }).data;
      };
      const baseline = await Promise.all(paths.map((path) => read(path)));
      trace.preparedSql.length = 0;
      const batched = await runWithInvocationLogger(logger, () =>
        runWithDimensionPageBatch(
          () => Promise.all(paths.map((path) => read(path))),
          "private-dashboard",
        ),
      );
      expect(batched).toEqual(baseline);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.preparedSql[0]).toContain("dimension_page_2");
      expect(collector.snapshot().dimensionBatch).toEqual({
        merged3: { events: 1, items: 3 },
      });
      const geoBaseline = await Promise.all(
        paths.map((path) => read(path, "geo.country", "US")),
      );
      trace.preparedSql.length = 0;
      const geoBatched = await runWithInvocationLogger(logger, () =>
        runWithDimensionPageBatch(
          () =>
            Promise.all(paths.map((path) => read(path, "geo.country", "US"))),
          "private-dashboard",
        ),
      );
      expect(geoBatched).toEqual(geoBaseline);
      expect(trace.preparedSql).toHaveLength(2);
      expect(collector.snapshot().dimensionBatch).toMatchObject({
        merged2: { events: 1, items: 2 },
        unfiltered: { events: 1, items: 1 },
      });
    } finally {
      db.close();
    }
  });

  it("streams nonempty D1 map points with canonical metadata on cold cache and cache hit", async () => {
    const { db, env } = runFixture();
    const acl = vi.spyOn(siteAccess, "resolvePrivateSite").mockResolvedValue({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    const entries = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response.clone());
        },
      }),
    });
    try {
      const request = new Request("https://app.test/en/app/team/site/geo");
      const window = {
        preset: "custom" as const,
        from: 100,
        to: 300,
        interval: "day" as const,
        timeZone: "UTC",
      };
      const start = () =>
        startSiteAnalyticsStream({
          request,
          env,
          siteId: "site-a",
          page: "geo",
          window,
          search: "",
        });
      const read = async () => {
        const reads = await start();
        const key = Object.keys(reads).find((key) =>
          key.includes("overview-geo-points"),
        )!;
        const result = await reads[key];
        await Promise.all(Object.values(reads));
        if (!result || !("json" in result))
          throw new Error("missing geo JSON handoff");
        return {
          key,
          value: JSON.parse(result.json) as Record<string, unknown>,
        };
      };
      const cold = await read();
      expect(cold.value).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ latitude: 34.05, longitude: -118.25 }),
        ]),
      });
      expect(cold.value).not.toHaveProperty("requestId");
      expect(cold.value).not.toHaveProperty("timestamp");
      const url = new URL(cold.key, request.url);
      const standalone = await executePrivateQuery({
        env,
        siteId: "site-a",
        pathname: "overview-geo-points",
        url,
        request: new Request(url),
        dashboardMode: true,
      });
      expect(standalone.status).toBe(200);
      expect(await standalone.json()).toEqual({
        ...cold.value,
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
      expect(await read()).toEqual(cold);
    } finally {
      vi.unstubAllGlobals();
      acl.mockRestore();
      db.close();
    }
  });

  it("uses the existing dimension batch from the SSR overview planner, including geography isolation", async () => {
    const db = sqlitePayloadFixture();
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    const acl = vi.spyOn(siteAccess, "resolvePrivateSite").mockResolvedValue({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    try {
      db.exec(
        "UPDATE visits SET country='US',browser='Chrome' WHERE site_pk=1 AND visit_id='v-new'; UPDATE visits SET country='CA',browser='Firefox' WHERE site_pk=1 AND visit_id='v-docs'",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = instrumentEnv(
        {
          DB: createSqliteD1Database(db, trace),
          DAILY_SALT_SECRET: "test-secret",
        } as never,
        logger,
      );
      const window = {
        preset: "custom" as const,
        from: 100,
        to: 300,
        interval: "day" as const,
        timeZone: "UTC",
      };
      const request = new Request("https://app.test/en/app/team/site");
      const reads = await runWithInvocationLogger(logger, () =>
        startSiteAnalyticsStream({
          request,
          env,
          siteId: "site-a",
          window,
          search: "scope=session&filter[page.path]=/home",
        }),
      );
      const entries = Object.entries(reads).filter(([key]) =>
        /overview-(?:page-path|client-browser|geo-country)\?/.test(key),
      );
      expect(entries).toHaveLength(3);
      const results = await Promise.all(
        entries.map(async ([key, promise]) => {
          const value = await promise;
          expect(value).not.toBeNull();
          const url = new URL(key, request.url);
          const standalone = await executePrivateQuery({
            env,
            siteId: "site-a",
            pathname: url.pathname.replace("/api/private/", ""),
            url,
            request: new Request(url),
            dashboardMode: true,
          });
          expect(standalone.status).toBe(200);
          const baseline = (await standalone.json()) as { data: unknown };
          expect(value).toMatchObject({
            value: { ok: true, data: baseline.data },
          });
          return value;
        }),
      );
      expect(results).toHaveLength(3);
      await Promise.all(Object.values(reads));
      expect(collector.snapshot().dimensionBatch).toMatchObject({
        merged3: { events: 1, items: 3 },
      });
      expect(
        trace.preparedSql.filter((sql) => sql.includes("dimension_page_2")),
      ).toHaveLength(1);
      const geo = await runWithInvocationLogger(logger, () =>
        startSiteAnalyticsStream({
          request,
          env,
          siteId: "site-a",
          window,
          search: "scope=session&filter[geo.country]=US",
        }),
      );
      const geoEntries = Object.entries(geo).filter(([key]) =>
        /overview-(?:page-path|client-browser|geo-country)\?/.test(key),
      );
      for (const [key, deferred] of geoEntries) {
        const result = await deferred;
        expect(result).not.toBeNull();
        const url = new URL(key, request.url);
        const standalone = await executePrivateQuery({
          env,
          siteId: "site-a",
          pathname: url.pathname.replace("/api/private/", ""),
          url,
          request: new Request(url),
          dashboardMode: true,
        });
        expect(standalone.status).toBe(200);
        expect(result).toMatchObject({
          value: {
            ok: true,
            data: ((await standalone.json()) as { data: unknown }).data,
          },
        });
      }
      await Promise.all(Object.values(geo));
      await logger.emitWhenComplete();
      expect(collector.snapshot().dimensionBatch).toMatchObject({
        merged3: { events: 1, items: 3 },
        merged2: { events: 1, items: 2 },
        unfiltered: { events: 1, items: 1 },
      });
    } finally {
      acl.mockRestore();
      db.close();
    }
  });

  it.each([
    'event.name eq "purchase"',
    'event.payload("/items/1/sku") eq "B"',
    'event.name eq "purchase" OR page.path contains "/"',
  ])(
    "shares materialized legacy Event qualification for %s",
    async (expression) => {
      const logger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const collector = registerHotspotCollector(logger);
      const db = sqlitePayloadFixture();
      try {
        db.exec(
          "UPDATE visits SET country='US',browser='Chrome' WHERE site_pk=1 AND visit_id='v-new'",
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = instrumentEnv(
          {
            DB: createSqliteD1Database(db, trace),
            DAILY_SALT_SECRET: "test-secret",
          } as never,
          logger,
        );
        const doc = parseFilterDsl(expression, analyticsFilterRegistry);
        const plan = createScopedFilterPlan("dimension", doc, "event")!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: "event",
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
        const dataset = compileScopedDatasetSql({
          filters,
          plan,
          siteIds: ["site-a"],
          window: WINDOW,
        });
        expect(dataset.scope).toBe("event");
        expect(dataset.materializedEventFacts).toBe(true);
        const dims = ["pathname", "country", "browser"];
        const read = (dim: string) =>
          queryDimensionPageFromD1(
            env,
            "site-a",
            WINDOW,
            filters,
            100,
            dim,
            { excludeEmpty: true },
            null,
            undefined,
            "private-dashboard",
            {},
          );
        const separate = await Promise.all(dims.map(read));
        expect(separate[0]!.items.length).toBeGreaterThan(0);
        trace.preparedSql.length = 0;
        const merged = await runWithInvocationLogger(logger, () =>
          runWithDimensionPageBatch(
            () => Promise.all(dims.map(read)),
            "private-dashboard",
          ),
        );
        expect(merged).toEqual(separate);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.preparedSql[0]).toContain(
          "filtered_visits AS NOT MATERIALIZED",
        );
        expect(collector.snapshot().dimensionBatch).toEqual({
          merged3: { events: 1, items: 3 },
        });
      } finally {
        db.close();
      }
    },
  );

  it("shares compatible prepared dimension pages with independent ordering, cursors and limits", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    const db = sqlitePayloadFixture();
    try {
      db.exec(
        "UPDATE visits SET country='US', browser='Chrome' WHERE site_pk=1 AND visit_id IN ('v-new','v-docs')",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = instrumentEnv(
        {
          DB: createSqliteD1Database(db, trace),
          DAILY_SALT_SECRET: "test-secret",
        } as never,
        logger,
      );
      expect(env.DB).toBe(env.DB);
      const doc = parseFilterDsl(
        'geo.country eq "US"',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("dimension", doc, "session")!;
      const filters = attachScopedFilterMetadata(doc, {
        requestedScope: "session",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const request = (
        expression: string,
        limit: number,
        search?: string,
        cursor?: DimensionAggregateCursor | null,
        sortBy: "views" | "sessions" | "visitors" = "views",
        sortDirection: "asc" | "desc" = "desc",
      ) =>
        queryDimensionPageFromD1(
          env,
          "site-a",
          WINDOW,
          filters,
          limit,
          expression,
          { search, excludeEmpty: false, sortBy, sortDirection },
          cursor,
          undefined,
          "api-v1",
          {},
        );
      const baseline = await Promise.all([
        request("pathname", 1),
        request("country", 2, undefined, null, "sessions", "asc"),
        request("browser", 3, "chr", null, "visitors", "desc"),
      ]);
      expect(baseline[0]?.items.length).toBeGreaterThan(0);
      const cursor = await decodeDimensionCursor(
        env,
        "site-a",
        WINDOW,
        filters,
        "pathname",
        undefined,
        baseline[0]?.pagination.nextCursor,
        "api-v1",
      );
      expect(cursor).not.toBeNull();
      const expected = await request("pathname", 1, undefined, cursor);
      expect(expected.items).toHaveLength(1);
      expect(expected.items).not.toEqual(baseline[0]!.items);
      trace.preparedSql.length = 0;
      const result = await runWithInvocationLogger(logger, () =>
        runWithDimensionPageBatch(() =>
          Promise.all([
            request("pathname", 1),
            request("country", 2, undefined, null, "sessions", "asc"),
            request("browser", 3, "chr", null, "visitors", "desc"),
            request("pathname", 1, undefined, cursor),
          ]),
        ),
      );
      expect(collector.snapshot().dimensionBatch).toEqual({
        merged4: { events: 1, items: 4 },
      });
      expect(result).toEqual([...baseline, expected]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.preparedSql[0]).toContain(
        "filtered_visits AS NOT MATERIALIZED",
      );
      expect(trace.preparedSql[0]).toContain("dimension_page_3");
      expect(trace.preparedSql[0]).toContain(
        "CASE slot WHEN 0 THEN -views WHEN 1 THEN sessions",
      );
      trace.preparedSql.length = 0;
      const duplicates = await runWithInvocationLogger(logger, () =>
        runWithDimensionPageBatch(() =>
          Promise.all([
            request("pathname", 1),
            request("pathname", 1),
            request("country", 2, undefined, null, "sessions", "asc"),
            request("pathname", 1, undefined, cursor),
          ]),
        ),
      );
      expect(duplicates).toEqual([
        baseline[0],
        baseline[0],
        baseline[1],
        expected,
      ]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.preparedSql[0]).toContain("dimension_page_2");
      expect(trace.preparedSql[0]).not.toContain("dimension_page_3");
      expect(duplicates[0]).not.toBe(duplicates[1]);
      trace.preparedSql.length = 0;
      expect(
        await runWithDimensionPageBatch(() =>
          Promise.all([request("pathname", 1), request("pathname", 1)]),
        ),
      ).toEqual([baseline[0], baseline[0]]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.preparedSql[0]).not.toContain("dimension_page_1");
    } finally {
      db.close();
    }
  });

  it("falls back before issuing a combined statement above the D1 binding budget", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    const calls: number[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          expect(sql).not.toContain("dimension_page_1");
          return {
            bind(...bindings: unknown[]) {
              calls.push(bindings.length);
              return { all: async () => ({ results: [] }) };
            },
          };
        },
      },
      DAILY_SALT_SECRET: "test-secret",
    } as never;
    const expression = Array.from(
      { length: 40 },
      (_, i) =>
        'page.path contains "' +
        String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)) +
        '"',
    ).join(" and ");
    const doc = parseFilterDsl(expression, analyticsFilterRegistry);
    const plan = createScopedFilterPlan("dimension", doc, "session")!;
    const filters = attachScopedFilterMetadata(doc, {
      requestedScope: "session",
      resolvedScope: plan.scope,
      plan,
      time: createQueryTime(100, 300, "UTC", 400),
      siteIds: ["site-a"],
    });
    const results = await runWithInvocationLogger(logger, () =>
      runWithDimensionPageBatch(() =>
        Promise.all(
          ["pathname", "country", "browser", "referrer_host"].map((dimension) =>
            queryDimensionPageFromD1(
              env,
              "site-a",
              WINDOW,
              filters,
              2,
              dimension,
              { search: "a" },
              { primary: 1, secondary: 1, value: "A" },
              undefined,
              "api-v1",
              {},
            ),
          ),
        ),
      ),
    );
    expect(collector.snapshot().dimensionBatch).toEqual({
      budgetFallback: { events: 1, items: 4 },
    });
    expect(results.every((page) => page.items.length === 0)).toBe(true);
    expect(calls).toEqual([94, 94, 94, 94]);
  });

  it("keeps incompatible batches isolated and retries failed shared SQL independently", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    const db = sqlitePayloadFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const real = createSqliteD1Database(db, trace);
      let failures = 0;
      const env = {
        DB: {
          prepare(sql: string) {
            if (sql.includes("dimension_page_1")) {
              failures++;
              throw new Error("shared query failure");
            }
            return real.prepare(sql);
          },
        },
        DAILY_SALT_SECRET: "test-secret",
      } as never;
      const doc = parseFilterDsl(
        'page.path contains "/"',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("dimension", doc, "visitor")!;
      const filters = attachScopedFilterMetadata(doc, {
        requestedScope: "visitor",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const read = (site: string, expression: string, signal?: AbortSignal) =>
        queryDimensionPageFromD1(
          env,
          site,
          WINDOW,
          filters,
          2,
          expression,
          undefined,
          null,
          undefined,
          "api-v1",
          { signal },
        );
      const baseline = await Promise.all([
        read("site-a", "pathname"),
        read("site-a", "country"),
        read("site-b", "pathname"),
      ]);
      trace.preparedSql.length = 0;
      expect(
        await runWithInvocationLogger(logger, () =>
          runWithDimensionPageBatch(() =>
            Promise.all([
              read("site-a", "pathname"),
              read("site-a", "country"),
              read("site-b", "pathname"),
            ]),
          ),
        ),
      ).toEqual(baseline);
      expect(collector.snapshot().dimensionBatch).toEqual({
        queryFallback: { events: 1, items: 2 },
        singleton: { events: 1, items: 1 },
      });
      expect(failures).toBe(1);
      expect(trace.preparedSql).toHaveLength(3);
      trace.preparedSql.length = 0;
      await Promise.all([
        runWithDimensionPageBatch(() => read("site-a", "pathname")),
        runWithDimensionPageBatch(() => read("site-a", "country")),
      ]);
      expect(failures).toBe(1);
      expect(trace.preparedSql).toHaveLength(2);
      const controller = new AbortController();
      trace.preparedSql.length = 0;
      const cancelled = await runWithInvocationLogger(logger, () =>
        runWithDimensionPageBatch(async () => {
          const first = read("site-a", "pathname", controller.signal);
          const second = read("site-a", "country");
          controller.abort();
          return Promise.allSettled([first, second]);
        }),
      );
      expect(collector.snapshot().dimensionBatch).toEqual({
        queryFallback: { events: 1, items: 2 },
        singleton: { events: 2, items: 2 },
        cancelled: { events: 1, items: 1 },
      });
      expect(cancelled[0]).toMatchObject({
        status: "rejected",
        reason: { name: "AbortError" },
      });
      expect(cancelled[1]).toMatchObject({
        status: "fulfilled",
        value: baseline[1],
      });
      expect(trace.preparedSql).toHaveLength(1);
      expect(failures).toBe(1);
    } finally {
      db.close();
    }
  });

  it("distinguishes rejected shared results from intentionally independent pages", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = registerHotspotCollector(logger);
    const calls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          calls.push(sql);
          return {
            bind() {
              return {
                all: async () => ({
                  results: sql.includes("dimension_page_1")
                    ? [{ slot: 99 }]
                    : [],
                }),
              };
            },
          };
        },
      },
      DAILY_SALT_SECRET: "test-secret",
    } as never;
    const doc = parseFilterDsl('geo.country eq "US"', analyticsFilterRegistry);
    const prepared = (scope: "session" | "event") => {
      const plan = createScopedFilterPlan("dimension", doc, scope)!;
      return attachScopedFilterMetadata(doc, {
        requestedScope: scope,
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
    };
    const filters = prepared("session");
    const read = (
      dimension: string,
      filter = filters,
      limit = 2,
      audience: "api-v1" | "private-dashboard" = "api-v1",
    ) =>
      queryDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        filter,
        limit,
        dimension,
        undefined,
        null,
        undefined,
        audience,
        {},
      );
    await runWithInvocationLogger(logger, () => read("pathname"));
    expect(collector.snapshot().dimensionBatch).toBeUndefined();
    calls.length = 0;
    const result = await runWithInvocationLogger(logger, () =>
      runWithDimensionPageBatch(() =>
        Promise.all([
          read("pathname"),
          read("country"),
          read("browser"),
          read("pathname", EMPTY_FILTER_DOCUMENT),
          read("country", prepared("event")),
          read("pathname", filters, 51),
          read("country", filters, 2, "private-dashboard"),
        ]),
      ),
    );
    expect(result.every((page) => page.items.length === 0)).toBe(true);
    expect(
      calls.filter((sql) => sql.includes("dimension_page_1")),
    ).toHaveLength(1);
    expect(calls).toHaveLength(8);
    expect(collector.snapshot().dimensionBatch).toEqual({
      resultFallback: { events: 1, items: 3 },
      unfiltered: { events: 1, items: 1 },
      eventScope: { events: 1, items: 1 },
      pageLimit: { events: 1, items: 1 },
      audience: { events: 1, items: 1 },
    });
  });
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

  it("uses raw observations for every empty scope without losing Event-only identities or admitting other sites", async () => {
    const db = sqlitePayloadFixture();
    try {
      db.exec(`
        UPDATE visits SET session_id='s-event-only', visitor_id='u-event-only'
          WHERE site_pk=1 AND visit_id='v-old';
        UPDATE custom_events SET occurred_at=150 WHERE event_pk=101;
        UPDATE visits SET duration_ms=-1 WHERE site_pk=1 AND visit_id='v-new';
        UPDATE visits SET duration_ms=0 WHERE site_pk=1 AND visit_id='v-docs';
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms)
          VALUES(1,'site-a','v-empty','','','/anonymous',180,10),
                (1,'site-a','v-whitespace',' ',' ','/anonymous',185,10),
                (1,'site-a','v-null',NULL,NULL,'/anonymous',190,10);
      `);
      for (const scope of ["event", "session", "visitor"] as const) {
        // Each explicit scope must still follow its own membership contract.
        const doc = { ...EMPTY_FILTER_DOCUMENT };
        const plan = createScopedFilterPlan("overview", doc, scope)!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: scope,
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
        const compiled = compileScopedDatasetSql({
          filters,
          plan,
          siteIds: ["site-a"],
          window: WINDOW,
        });
        const run = (sql: string) =>
          db
            .prepare(`WITH ${compiled.ctes} ${sql}`)
            .all(...compiled.bindings.map((b) => b.value));
        if (scope === "event") {
          expect(compiled.ctes).toContain(
            "scope_final_visits AS (SELECT * FROM scope_raw_visits)",
          );
          expect(compiled.ctes).toContain(
            "scope_final_events AS (SELECT * FROM scope_raw_events)",
          );
          expect(compiled.ctes).not.toContain("scope_matching_visit_ids AS");
        } else {
          const column = scope === "session" ? "session_id" : "visitor_id";
          expect(compiled.ctes).toContain(
            `scope_final_visits AS (SELECT * FROM scope_raw_visits WHERE TRIM(COALESCE(${column}, '')) != '')`,
          );
          expect(compiled.ctes).toContain(
            `scope_final_events AS (SELECT * FROM scope_raw_events WHERE TRIM(COALESCE(${column}, '')) != '')`,
          );
          expect(compiled.ctes).not.toContain("JOIN scope_universe");
        }
        expect(compiled.ctes).not.toContain("scope_raw_visits AS MATERIALIZED");
        expect(compiled.ctes).not.toContain("scope_raw_events AS MATERIALIZED");
        expect(
          run(
            `SELECT visit_id FROM ${compiled.visitRelation} ORDER BY visit_id`,
          ),
        ).toEqual(
          (scope === "event"
            ? ["v-docs", "v-empty", "v-new", "v-null", "v-whitespace"]
            : ["v-docs", "v-new"]
          ).map((visit_id) => ({ visit_id })),
        );
        expect(
          run(
            `SELECT event_pk FROM ${compiled.eventRelation} ORDER BY event_pk`,
          ),
        ).toEqual([101, 102, 103, 104].map((event_pk) => ({ event_pk })));
        expect(
          run(
            `SELECT session_id FROM ${compiled.sessionRelation} ORDER BY session_id`,
          ),
        ).toEqual(
          ["s-event-only", "s1", "s2"].map((session_id) => ({ session_id })),
        );
        expect(
          run(
            `SELECT visitor_id FROM ${compiled.visitorRelation} ORDER BY visitor_id`,
          ),
        ).toEqual(
          ["u-event-only", "u1", "u2"].map((visitor_id) => ({ visitor_id })),
        );
        // Preserve the original independent Visit and entity rollups as the
        // differential oracle, including whitespace-only bounce identities,
        // Event-only entities, duplicate Events, negative and zero durations.
        const expected = run(`
          SELECT count(*) AS views,
            (SELECT count(*) FROM ${compiled.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${compiled.visitorRelation}) AS visitors,
            (SELECT count(*) FROM (
              SELECT session_id FROM ${compiled.visitRelation}
              WHERE session_id != '' GROUP BY session_id HAVING count(*) = 1
            )) AS bounces,
            COALESCE(sum(CASE WHEN duration_ms >= 0 THEN duration_ms ELSE 0 END),0) AS totalDuration,
            COALESCE(sum(CASE WHEN duration_ms >= 0 THEN 1 ELSE 0 END),0) AS durationViews
          FROM ${compiled.visitRelation}
        `)[0];
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = { DB: createSqliteD1Database(db, trace) } as never;
        expect(
          await queryOverviewFromD1(env, "site-a", WINDOW, filters),
        ).toEqual(expected);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.preparedSql[0]).toContain(
          "report_observations AS MATERIALIZED",
        );
      }
    } finally {
      db.close();
    }
  });

  it("shares entity membership evidence without narrowing cross-observation AND or losing Event-only entities", async () => {
    const db = sqlitePayloadFixture();
    try {
      db.exec(`
        UPDATE visits SET country='CA', browser='Chrome'
          WHERE site_pk=1 AND visit_id='v-old';
        UPDATE visits SET country='US', browser='Firefox'
          WHERE site_pk=1 AND visit_id='v-new';
        UPDATE visits SET country='CA', browser=NULL
          WHERE site_pk=1 AND visit_id='v-docs';
        UPDATE visits SET country='CA', browser='Chrome'
          WHERE site_pk=2;
        UPDATE custom_events SET occurred_at=150 WHERE event_pk=101;
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms,country,browser)
          VALUES(1,'site-a','v-event-only','s-event','u-event','/historical',20,10,'GB',NULL),
                (1,'site-a','v-empty','','','/anonymous',180,10,'US','Chrome'),
                (1,'site-a','v-whitespace',' ',' ','/anonymous',185,10,'CA',NULL),
                (1,'site-a','v-null',NULL,NULL,'/anonymous',190,10,'CA',NULL);
        INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at)
          VALUES(105,1,'site-a','e-event-only','v-event-only',3,170);
      `);
      const cases = [
        {
          expression: 'geo.country eq "US" or client.browser eq "Chrome"',
          shared: true,
          evidence: false,
          visits: [
            { site_pk: 1, visit_id: "v-new" },
            { site_pk: 2, visit_id: "v-new" },
          ],
          events: [101, 102, 103, 201],
        },
        {
          expression: 'not (geo.country eq "US" or client.browser eq "Chrome")',
          shared: true,
          evidence: true,
          visits: [{ site_pk: 1, visit_id: "v-docs" }],
          events: [104, 105],
        },
        {
          expression:
            'geo.country eq "US" and client.browser eq "Chrome" and not (page.path eq "/docs")',
          shared: true,
          evidence: true,
          visits: [{ site_pk: 1, visit_id: "v-new" }],
          events: [101, 102, 103],
        },
        {
          expression:
            '(geo.country eq "US" or client.browser eq "Chrome") and not (page.path eq "/old")',
          shared: true,
          evidence: true,
          visits: [{ site_pk: 2, visit_id: "v-new" }],
          events: [201],
        },
        {
          expression: 'geo.country eq "US" and client.browser eq "Chrome"',
          shared: false,
          evidence: false,
          visits: [{ site_pk: 1, visit_id: "v-new" }],
          events: [101, 102, 103],
        },
        {
          expression: 'event.name eq "purchase" or geo.country eq "US"',
          shared: false,
          evidence: false,
          visits: [
            { site_pk: 1, visit_id: "v-new" },
            { site_pk: 2, visit_id: "v-new" },
          ],
          events: [101, 102, 103, 201],
        },
      ];
      for (const scope of ["session", "visitor"] as const) {
        for (const item of cases) {
          const compiled = dataset(item.expression, scope);
          expect(compiled.ctes.includes("scope_shared_membership AS")).toBe(
            item.shared,
          );
          expect(compiled.ctes.includes("scope_membership_evidence AS")).toBe(
            item.evidence,
          );
          const run = (sql: string) =>
            select(
              db,
              `WITH ${compiled.ctes} ${sql}`,
              compiled.bindings.map((b) => b.value),
            );
          expect(
            run(
              `SELECT site_pk, visit_id FROM ${compiled.visitRelation} ORDER BY site_pk, visit_id`,
            ),
          ).toEqual(item.visits);
          expect(
            run(
              `SELECT event_pk FROM ${compiled.eventRelation} ORDER BY event_pk`,
            ),
          ).toEqual(item.events.map((event_pk) => ({ event_pk })));
          const doc = parseFilterDsl(item.expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan("overview", doc, scope)!;
          const filters = attachScopedFilterMetadata(doc, {
            requestedScope: scope,
            resolvedScope: plan.scope,
            plan,
            time: createQueryTime(100, 300, "UTC", 400),
            siteIds: ["site-a"],
          });
          const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
          const baseline = compileScopedDatasetSql(input);
          const optimized = compileScopedDatasetSql({
            ...input,
            inlineVisitEvidence: true,
          });
          expect(baseline.ctes).toContain("scope_raw_visits AS MATERIALIZED");
          expect(
            optimized.ctes.includes("scope_raw_visits AS NOT MATERIALIZED"),
          ).toBe(item.evidence);
          expect(optimized.ctes).toContain("scope_raw_events AS MATERIALIZED");
          expect(optimized.bindings).toEqual(baseline.bindings);
          for (const relation of [
            "visitRelation",
            "eventRelation",
            "sessionRelation",
            "visitorRelation",
          ] as const) {
            const read = (data: typeof baseline) =>
              select(
                db,
                `WITH ${data.ctes} SELECT * FROM ${data[relation]} ORDER BY 1,2`,
                data.bindings.map((b) => b.value),
              );
            expect(read(optimized)).toEqual(read(baseline));
          }
          const expected = select(
            db,
            `WITH ${baseline.ctes} SELECT COUNT(*) AS views,
            (SELECT COUNT(*) FROM ${baseline.sessionRelation}) AS sessions,
            (SELECT COUNT(*) FROM ${baseline.visitorRelation}) AS visitors,
            (SELECT COUNT(*) FROM (SELECT session_id FROM ${baseline.visitRelation}
              WHERE session_id != '' GROUP BY session_id HAVING COUNT(*)=1)) AS bounces,
            COALESCE(SUM(CASE WHEN duration_ms>=0 THEN duration_ms ELSE 0 END),0) AS totalDuration,
            COALESCE(SUM(CASE WHEN duration_ms>=0 THEN 1 ELSE 0 END),0) AS durationViews
            FROM ${baseline.visitRelation}`,
            baseline.bindings.map((b) => b.value),
          )[0];
          const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const env = { DB: createSqliteD1Database(db, trace) } as never;
          expect(
            await queryOverviewFromD1(env, "site-a", WINDOW, filters),
          ).toEqual(expected);
          expect(
            trace.preparedSql[0]!.includes(
              "scope_raw_visits AS NOT MATERIALIZED",
            ),
          ).toBe(item.evidence);
        }
      }
    } finally {
      db.close();
    }
  });

  it("pushes visit-context predicates into both observation sources without losing cross-window Events", () => {
    const db = sqlitePayloadFixture();
    try {
      db.exec(`
        UPDATE visits SET country='US', browser='Chrome', session_id='s-historical', visitor_id='u-historical'
          WHERE site_pk=1 AND visit_id='v-old';
        UPDATE visits SET country='US', browser='Chrome' WHERE site_pk=1 AND visit_id='v-new';
        UPDATE visits SET country='CA', browser=NULL WHERE site_pk=1 AND visit_id='v-docs';
        UPDATE visits SET country='US', browser='Chrome' WHERE site_pk=2;
        UPDATE custom_events SET occurred_at=150 WHERE event_pk=101;
      `);
      const cases = [
        {
          expression: 'geo.country eq "US"',
          visits: ["v-new"],
          events: [101, 102, 103],
          fast: true,
        },
        {
          expression: 'page.path eq "/old" or page.path eq "/home"',
          visits: ["v-new"],
          events: [101, 102, 103],
          fast: true,
        },
        {
          expression: 'geo.country eq "US" and client.browser eq "Chrome"',
          visits: ["v-new"],
          events: [101, 102, 103],
          fast: true,
        },
        {
          expression: 'not (geo.country eq "US")',
          visits: ["v-docs"],
          events: [104],
          fast: true,
        },
        {
          expression: 'event.name eq "purchase"',
          visits: ["v-new"],
          events: [101, 103],
          fast: false,
        },
        {
          expression: 'geo.country eq "US" or event.name eq "view"',
          visits: ["v-docs", "v-new"],
          events: [101, 102, 103, 104],
          fast: false,
        },
      ];
      for (const item of cases) {
        const doc = parseFilterDsl(item.expression, analyticsFilterRegistry);
        const plan = createScopedFilterPlan("overview", doc, "event")!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: "event",
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
        const dataset = compileScopedDatasetSql({
          filters,
          plan,
          siteIds: ["site-a"],
          window: WINDOW,
        });
        expect(dataset.ctes.includes("scope_matching_visit_ids AS")).toBe(
          !item.fast,
        );
        const bindings = dataset.bindings.map((b) => b.value);
        const run = (sql: string) =>
          db.prepare(`WITH ${dataset.ctes} ${sql}`).all(...bindings);
        expect(
          run(
            `SELECT visit_id FROM ${dataset.visitRelation} ORDER BY visit_id`,
          ),
        ).toEqual(item.visits.map((visit_id) => ({ visit_id })));
        expect(
          run(
            `SELECT event_pk FROM ${dataset.eventRelation} ORDER BY event_pk`,
          ),
        ).toEqual(item.events.map((event_pk) => ({ event_pk })));
        if (item.fast) {
          expect(dataset.ctes).toContain(
            "scope_final_visits AS (SELECT * FROM scope_matching_visits)",
          );
          expect(dataset.ctes).not.toContain(
            "scope_raw_visits AS MATERIALIZED",
          );
          expect(dataset.ctes).not.toContain(
            "scope_raw_events AS MATERIALIZED",
          );
        }
        if (item.expression === 'geo.country eq "US"') {
          expect(
            run(
              `SELECT session_id FROM ${dataset.sessionRelation} ORDER BY session_id`,
            ),
          ).toEqual([{ session_id: "s-historical" }, { session_id: "s1" }]);
          expect(
            run(
              `SELECT visitor_id FROM ${dataset.visitorRelation} ORDER BY visitor_id`,
            ),
          ).toEqual([{ visitor_id: "u-historical" }, { visitor_id: "u1" }]);
        }
      }
    } finally {
      db.close();
    }
  });

  it("shares prepared geo observations once while keeping invalid-coordinate visits in every drilldown total", async () => {
    const { db } = runFixture();
    try {
      db.exec(`
        UPDATE visits SET region_code='CA' WHERE site_pk=1 AND visit_id='v-new';
        UPDATE visits SET country='US', region='California', region_code='CA', city='LA',
          latitude=NULL, longitude=NULL WHERE site_pk=1 AND visit_id='v-docs';
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms,country,region,region_code,city,latitude,longitude)
          VALUES(1,'site-a','v-repeat','s1','u1','/home',140,5,'US','California','CA','LA',34.05,-118.25);
      `);
      const cases = [
        {
          expression: "",
          key: "countryCounts",
          item: { country: "US" },
        },
        {
          expression: 'page.path contains "/"',
          key: "countryCounts",
          item: { country: "US" },
        },
        {
          expression: 'geo.country eq "US"',
          key: "regionCounts",
          item: { value: "US::CA::California", label: "California" },
        },
        {
          expression: 'geo.country eq "US" and geo.region eq "California"',
          key: "cityCounts",
          item: { value: "US::CA::California::LA", label: "LA" },
        },
      ] as const;
      for (const test of cases) {
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = { DB: createSqliteD1Database(db, trace) } as never;
        const doc = { ...EMPTY_FILTER_DOCUMENT };
        const emptyPlan = createScopedFilterPlan("geo-points", doc, "event")!;
        const filters = test.expression
          ? ready("geo-points", test.expression)
          : attachScopedFilterMetadata(doc, {
              requestedScope: "event",
              resolvedScope: emptyPlan.scope,
              plan: emptyPlan,
              time: createQueryTime(100, 300, "UTC", 400),
              siteIds: ["site-a"],
            });
        const result = await queryGeoPointAggregate(
          env,
          "site-a",
          WINDOW,
          filters,
          1,
        );
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.preparedSql[0]).toContain(
          test.expression
            ? "shared_geo_visits AS MATERIALIZED"
            : "shared_geo_visits AS NOT MATERIALIZED",
        );
        expect(result.points).toEqual([
          expect.objectContaining({
            latitude: 34.05,
            longitude: -118.25,
            pointCount: 2,
            timestampMs: 140,
          }),
        ]);
        expect(result[test.key]).toEqual([
          { ...test.item, views: 3, sessions: 2, visitors: 2 },
        ]);
        expect(
          result.countryCounts.length +
            result.regionCounts.length +
            result.cityCounts.length,
        ).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("compares full event facts beyond the per-period top 100, scopes and cursors stay isolated", async () => {
    const { db, env: base } = runFixture();
    const env = {
      ...(base as object),
      DAILY_SALT_SECRET: "event-comparison-test",
    } as Parameters<typeof queryComparisonDimensionPageFromD1>[0];
    try {
      const insertName = db.prepare(
        "INSERT INTO custom_event_names(id,site_pk,name) VALUES (?,1,?)",
      );
      const insertEvent = db.prepare(
        "INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at) VALUES (?,1,'site-a',?,?,?,?)",
      );
      let id = 1000;
      // 105 higher-ranked reference-only names hide the shared event from
      // a reference Top100, even though it really has a nonzero count.
      insertName.run(500, "shared");
      for (let j = 0; j < 3; j++)
        insertEvent.run(id, "event-" + id++, "v-new", 500, 170);
      insertEvent.run(id, "event-" + id++, "v-old", 500, 40);
      for (let n = 0; n < 105; n++) {
        insertName.run(501 + n, "reference-" + String(n).padStart(3, "0"));
        for (let j = 0; j < 2; j++)
          insertEvent.run(id, "event-" + id++, "v-old", 501 + n, 40);
      }
      for (let n = 0; n < 3; n++) {
        insertName.run(800 + n, "new-" + n);
        insertEvent.run(id, "event-" + id++, "v-new", 800 + n, 170);
      }
      const reference = { ...WINDOW, startMs: 0, endExclusiveMs: 100 };
      const filters = EMPTY_FILTER_DOCUMENT;
      const expr = eventComparisonExpression("event.name")!;
      const options = {
        metric: "views",
        sortBy: "current",
        direction: "desc",
      } as const;
      const page = await queryComparisonDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        reference,
        filters,
        1,
        expr,
        options,
        null,
        "private-dashboard",
      );
      expect(page.items[0]).toMatchObject({
        key: "shared",
        views: 3,
        reference: { views: 1 },
        change: { views: { absolute: 2, relative: 2 } },
      });
      expect(page.pagination.hasMore).toBe(true);
      const decode = (
        expression: string,
        cursor: string | null,
        sortBy: "current" | "change" = "current",
      ) =>
        decodeComparisonDimensionCursor(
          env,
          "site-a",
          WINDOW,
          filters,
          reference,
          filters,
          expression,
          undefined,
          cursor,
          "private-dashboard",
          "views",
          sortBy,
          "desc",
        );
      await expect(
        decode("event-fact:pathname", page.pagination.nextCursor),
      ).rejects.toThrow("invalid-cursor");
      await expect(
        decode("event_name", page.pagination.nextCursor),
      ).rejects.toThrow("invalid-cursor");
      const next = await decode(expr, page.pagination.nextCursor);
      expect(next).not.toBeNull();
      const second = await queryComparisonDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        reference,
        filters,
        1,
        expr,
        options,
        next,
        "private-dashboard",
      );
      expect(second.items[0]?.key).not.toBe("shared");
      const change = { ...options, sortBy: "change" } as const;
      const firstNew = await queryComparisonDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        reference,
        filters,
        1,
        expr,
        change,
        null,
        "private-dashboard",
      );
      expect(firstNew.items[0]?.change.views.relative).toBeNull();
      const changeCursor = await decode(
        expr,
        firstNew.pagination.nextCursor,
        "change",
      );
      const secondNew = await queryComparisonDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        filters,
        reference,
        filters,
        1,
        expr,
        change,
        changeCursor,
        "private-dashboard",
      );
      expect(secondNew.items[0]?.change.views.relative).toBeNull();
      expect(secondNew.items[0]?.key).not.toBe(firstNew.items[0]?.key);
      const read = async (pathname: string, search: string) => {
        const url = new URL(
          "https://edge.test/api/private/" +
            pathname +
            "?siteId=site-a&from=100&to=299&timeZone=UTC&" +
            search,
        );
        return executePrivateQuery({
          env,
          siteId: "site-a",
          pathname,
          url,
          request: new Request(url),
          dashboardMode: true,
          batchExecution: { capturedAtMs: 400 },
        });
      };
      const name = await read(
        "events-compare-name",
        "compare=same&filter[event.name]=shared&compareFilter[event.name]=signup&scope=event&limit=10",
      );
      expect(name.status).toBe(200);
      const body = (await name.json()) as { data: { items: unknown[] } };
      expect(body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "shared",
            views: 3,
            reference: expect.objectContaining({ views: 0 }),
          }),
          expect.objectContaining({
            label: "signup",
            views: 0,
            reference: expect.objectContaining({ views: 1 }),
          }),
        ]),
      );
      const path = await read(
        "events-compare-path",
        "compare=same&filter[event.name]=shared&compareFilter[event.name]=signup&scope=event&limit=10",
      );
      expect(path.status).toBe(200);
      expect(
        ((await path.json()) as { data: { items: unknown[] } }).data.items,
      ).toEqual([
        expect.objectContaining({
          label: "/home",
          views: 3,
          reference: expect.objectContaining({ views: 1 }),
        }),
      ]);
      expect((await read("events-compare-name", "limit=10")).status).toBe(400);
      const scoped = await queryComparisonDimensionPageFromD1(
        env,
        "site-a",
        WINDOW,
        ready("dimension", 'event.name eq "shared"'),
        reference,
        filters,
        10,
        expr,
        options,
        null,
        "private-dashboard",
      );
      expect(scoped.items.find((row) => row.key === "shared")).toMatchObject({
        views: 3,
        reference: { views: 1 },
      });
      expect(
        scoped.items.every((row) => row.key === "shared" || row.views === 0),
      ).toBe(true);
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

  it("shares prepared entity event trends without changing top order or Other distinct identities", async () => {
    const { db } = runFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      // A third name shares the first session/visitor with signup and purchase.
      db.exec(
        "INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at) VALUES(105,1,'site-a','e-view-home','v-new',3,170)",
      );
      for (const scope of ["session", "visitor"] as const) {
        for (const expression of [
          'page.path eq "/home"',
          'page.path eq "/not-present"',
        ]) {
          const doc = parseFilterDsl(expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan("event-trend", doc, scope)!;
          const filters = attachScopedFilterMetadata(doc, {
            requestedScope: scope,
            resolvedScope: plan.scope,
            plan,
            time: createQueryTime(100, 300, "UTC", 400),
            siteIds: ["site-a"],
          });
          for (const limit of [1, 10]) {
            const before = trace.preparedSql.length;
            const result = await queryEventsTrendFromD1(
              env,
              "site-a",
              WINDOW,
              "minute",
              filters,
              limit,
            );
            expect(trace.preparedSql.length - before).toBe(1);
            expect(trace.preparedSql[before]).toContain(
              "trend_observations AS MATERIALIZED",
            );
            if (expression.includes("not-present")) {
              expect(result.series).toEqual([]);
              expect(
                result.data.every((point) => point.totalEvents === 0),
              ).toBe(true);
            } else {
              expect(
                result.data.reduce((sum, point) => sum + point.totalEvents, 0),
              ).toBe(3);
              if (limit === 1) {
                expect(result.series).toEqual([
                  expect.objectContaining({
                    eventName: "purchase",
                    events: 1,
                    sessions: 1,
                    visitors: 1,
                  }),
                  expect.objectContaining({
                    isOther: true,
                    events: 2,
                    sessions: 1,
                    visitors: 1,
                  }),
                ]);
              } else {
                expect(result.series.map((row) => row.eventName)).toEqual([
                  "purchase",
                  "signup",
                  "view",
                ]);
                expect(
                  result.series.every(
                    (row) =>
                      row.events === 1 &&
                      row.sessions === 1 &&
                      row.visitors === 1,
                  ),
                ).toBe(true);
              }
            }
            const isolated = await queryEventsTrendFromD1(
              env,
              "site-b",
              WINDOW,
              "minute",
              filters,
              limit,
            );
            // The independent site's valid data must not include site-a identities.
            expect(
              isolated.data.reduce((sum, point) => sum + point.totalEvents, 0),
            ).toBe(expression.includes("not-present") ? 0 : 1);
          }
        }
      }
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

  it("restricts only same-entity local journey qualification and preserves event-only rows and pagination", async () => {
    const { db } = runFixture();
    try {
      db.exec(
        "UPDATE visits SET session_id='s-event-only', visitor_id='u-event-only' WHERE site_pk=1 AND visit_id='v-old'; UPDATE custom_events SET occurred_at=170 WHERE event_pk=101",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      for (const kind of ["session", "visitor"] as const) {
        const target = { type: kind, value: kind === "session" ? "s1" : "u1" };
        const prepare = (expression: string, scope: "session" | "visitor") => {
          const doc = parseFilterDsl(expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan(
            kind === "session" ? "session-events" : "visitor-events",
            doc,
            scope,
          )!;
          return {
            filters: attachScopedFilterMetadata(doc, {
              requestedScope: scope,
              resolvedScope: plan.scope,
              plan,
              time: createQueryTime(100, 300, "UTC", 400),
              siteIds: ["site-a"],
            }),
            plan,
          };
        };
        for (const expression of [
          'page.path contains "/"',
          'NOT (page.path eq "/missing")',
          'page.path eq "/home" OR geo.country eq "ZZ"',
          'NOT (event.name eq "missing")',
          'event.name eq "purchase" OR page.path eq "/docs"',
          'event.payload("/items/1/sku") eq "B" AND page.path eq "/home"',
          kind + ".views gte 1",
          kind + ".events eq 0",
          kind + ".views gte 1 AND " + kind + ".events gte 0",
          kind === "session"
            ? "session.durationMs gte 1 AND session.bounce eq true"
            : "visitor.sessions gte 1",
        ]) {
          const { filters, plan } = prepare(expression, kind);
          const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
          const unrestricted = compileScopedDatasetSql(input);
          const restricted = compileScopedDatasetSql({ ...input, target });
          const column = kind + "_id";
          expect(restricted.ctes).toContain("AND " + column + " = ?");
          expect(restricted.ctes).toContain("AND v." + column + " = ?");
          for (const relation of ["visitRelation", "eventRelation"] as const) {
            const query = (
              dataset: ReturnType<typeof compileScopedDatasetSql>,
            ) =>
              db
                .prepare(
                  "WITH " +
                    dataset.ctes +
                    " SELECT * FROM " +
                    dataset[relation] +
                    " WHERE " +
                    column +
                    " = ? ORDER BY " +
                    (relation === "visitRelation" ? "visit_id" : "event_id"),
                )
                .all(...dataset.bindings.map((b) => b.value), target.value);
            expect(query(restricted)).toEqual(query(unrestricted));
          }
          const all = await queryJourneyEventsPageFromD1(
            env,
            "site-a",
            WINDOW,
            filters,
            target,
            100,
          );
          const first = await queryJourneyEventsPageFromD1(
            env,
            "site-a",
            WINDOW,
            filters,
            target,
            1,
          );
          expect(first.items).toEqual(all.items.slice(0, 1));
          expect(trace.preparedSql.at(-1)).not.toContain(
            "LEFT JOIN filtered_visits",
          );
          if (first.pagination.nextCursor) {
            const second = await queryJourneyEventsPageFromD1(
              env,
              "site-a",
              WINDOW,
              filters,
              target,
              100,
              first.pagination.nextCursor,
            );
            expect(second.items).toEqual(all.items.slice(1));
          }
        }
        const eventOnly = {
          type: kind,
          value: kind === "session" ? "s-event-only" : "u-event-only",
        };
        const historical = prepare('page.path eq "/old"', kind);
        const historicalPage = await queryJourneyEventsPageFromD1(
          env,
          "site-a",
          WINDOW,
          historical.filters,
          eventOnly,
          100,
        );
        expect(
          historicalPage.items.map((item) => ({
            id: item.id,
            kind: item.kind,
          })),
        ).toEqual([{ id: "e-old", kind: "custom" }]);
        expect(
          (
            await queryJourneyEventsPageFromD1(
              env,
              "site-b",
              WINDOW,
              historical.filters,
              eventOnly,
              100,
            )
          ).items,
        ).toEqual([]);
        for (const [expression, scope] of [
          [
            'page.path contains "/"',
            kind === "session" ? "visitor" : "session",
          ],
          ['event.name eq "purchase"', kind],
          [(kind === "session" ? "visitor" : "session") + ".views gt 0", kind],
          [kind + ".events gt 0", kind],
          ['event.payload("/items/1/sku") eq "B"', kind],
          ["count(VISITOR) gte 1", kind],
        ] as const) {
          const { filters, plan } = prepare(expression, scope);
          const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
          expect(compileScopedDatasetSql({ ...input, target })).toEqual(
            compileScopedDatasetSql(input),
          );
        }
      }
    } finally {
      db.close();
    }
  });
  const localHistoryBase = createQueryTime(100, 300, "UTC", 400);
  it.each([
    ["count(PAGE) gte 1", localHistoryBase, true],
    ["count(EVENT) eq 2", localHistoryBase, true],
    ['count(EVENT { $.name eq "purchase" }) eq 1', localHistoryBase, true],
    [
      'count(EVENT { $.payload("/items/1/sku") eq "B" }) eq 1',
      localHistoryBase,
      true,
    ],
    [
      'first(EVENT).name eq "purchase"',
      { ...localHistoryBase, fullHistory: true },
      true,
    ],
    [
      'first(EVENT).name eq "signup"',
      { ...localHistoryBase, fullHistory: true },
      false,
    ],
    [
      'first(EVENT).name eq "signup"',
      {
        ...localHistoryBase,
        fullHistory: true,
        filterRange: { startMs: 100, endExclusiveMs: 300 },
      },
      true,
    ],
    [
      'first(PAGE).path eq "/old"',
      { ...localHistoryBase, readRange: createTimeRange(0, 300) },
      true,
    ],
    ["count(PAGE) eq 1 AND NOT (count(EVENT) eq 0)", localHistoryBase, true],
    [
      'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }]) exists',
      { ...localHistoryBase, fullHistory: true },
      true,
    ],
    [
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
      localHistoryBase,
      true,
    ],
    [
      'without(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]), EVENT { $.name eq "view" }) exists',
      localHistoryBase,
      true,
    ],
    [
      "count(window(EVENT, @range.start, [0ms, 200ms])) eq 2",
      localHistoryBase,
      true,
    ],
    ["count(periods(PAGE, 1d)) eq 1", localHistoryBase, true],
    [
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 40ms AND $gap(1, 2) gte 20ms } exists',
      localHistoryBase,
      true,
    ],
    [
      'count(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 20ms }) eq 0',
      localHistoryBase,
      true,
    ],
    [
      'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "purchase" }]) { $same($.name) } exists',
      { ...localHistoryBase, fullHistory: true },
      true,
    ],
    [
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $same($.payload("/items/0/sku")) } notExists',
      localHistoryBase,
      true,
    ],
    [
      "count(periods(PAGE, 1d) { count($items) eq 1 }) eq 1",
      localHistoryBase,
      true,
    ],
    [
      "periods(EVENT, 1d) { count($items) gte 2 AND NOT (count($items) gte 3) } exists",
      localHistoryBase,
      true,
    ],
  ] as const)(
    "narrows local advanced occurrence relation %s without narrowing Q/F/R",
    async (expression, time, expected) => {
      const { db, env } = runFixture();
      try {
        for (const kind of ["session", "visitor"] as const) {
          const column = kind + "_id";
          const doc = parseFilterDsl(expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan(
            (kind + "-events") as "session-events" | "visitor-events",
            doc,
            kind,
          )!;
          const filters = attachScopedFilterMetadata(doc, {
            requestedScope: kind,
            resolvedScope: plan.scope,
            plan,
            time,
            siteIds: ["site-a"],
          });
          const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
          const original = compileScopedDatasetSql(input);
          for (const value of [
            kind === "session" ? "s1" : "u1",
            kind === "session" ? "s2" : "u2",
            "missing",
          ]) {
            const target = { type: kind, value };
            const restricted = compileScopedDatasetSql({ ...input, target });
            expect(restricted.ctes).toContain("AND " + column + " = ?");
            expect(restricted.ctes).toContain("AND v." + column + " = ?");
            if ("fullHistory" in time || "readRange" in time) {
              expect(
                restricted.ctes.match(
                  new RegExp("AND " + column + " = \\?", "g"),
                ),
              ).toHaveLength(2);
            }
            for (const relation of [
              "visitRelation",
              "eventRelation",
            ] as const) {
              const read = (
                dataset: ReturnType<typeof compileScopedDatasetSql>,
              ) =>
                db
                  .prepare(
                    `WITH ${dataset.ctes} SELECT * FROM ${dataset[relation]} WHERE ${column} = ? ORDER BY ${relation === "visitRelation" ? "visit_id" : "event_id"}`,
                  )
                  .all(...dataset.bindings.map((b) => b.value), value);
              expect(read(restricted)).toEqual(read(original));
            }
            const all = await queryJourneyEventsPageFromD1(
              env,
              "site-a",
              WINDOW,
              filters,
              target,
              100,
            );
            if (value === (kind === "session" ? "s1" : "u1"))
              expect(all.items.length > 0).toBe(expected);
            const first = await queryJourneyEventsPageFromD1(
              env,
              "site-a",
              WINDOW,
              filters,
              target,
              1,
            );
            expect(first.items).toEqual(all.items.slice(0, 1));
            if (first.pagination.nextCursor) {
              const next = await queryJourneyEventsPageFromD1(
                env,
                "site-a",
                WINDOW,
                filters,
                target,
                100,
                first.pagination.nextCursor,
              );
              expect(next.items).toEqual(all.items.slice(1));
            }
          }
        }
      } finally {
        db.close();
      }
    },
  );
  it("retains full qualification for cross-entity advanced relations", () => {
    const base = localHistoryBase;
    for (const kind of ["session", "visitor"] as const) {
      for (const expression of [
        "count(VISITOR) gte 1",
        "count(SESSION) gte 1",
        'SESSION { PAGE { $.path eq "/home" } exists } exists',
      ]) {
        const doc = parseFilterDsl(expression, analyticsFilterRegistry);
        const plan = createScopedFilterPlan(
          (kind + "-events") as "session-events" | "visitor-events",
          doc,
          kind,
        )!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: kind,
          resolvedScope: plan.scope,
          plan,
          time: base,
          siteIds: ["site-a"],
        });
        const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
        expect(
          compileScopedDatasetSql({
            ...input,
            target: { type: kind, value: kind === "session" ? "s1" : "u1" },
          }),
        ).toEqual(compileScopedDatasetSql(input));
      }
    }
  });
  it("seeks historical Event witnesses only for small report universes and preserves dense fallback", () => {
    const db = sqliteFixture();
    try {
      db.exec(`
        CREATE UNIQUE INDEX test_visit_key ON visits(site_pk,visit_id);
        CREATE INDEX test_visit_session ON visits(site_pk,session_id,started_at);
        CREATE INDEX test_visit_visitor ON visits(site_pk,visitor_id,started_at);
        CREATE INDEX test_event_visit ON custom_events(site_pk,visit_id,occurred_at);
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms)
        VALUES(1,'site-a','v-before','s3','u3','/before',-10001,1),
              (1,'site-a','v-report','s3','u3','/report',200,1),
              (1,'site-a','v-only','s4','u4','/before',-10001,1),
              (1,'site-a','v-blank','','','/report',210,1),
              (2,'site-b','v-report','s3','u3','/report',200,1);
        INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at)
        VALUES(105,1,'site-a','e-left','v-before',1,-10000),
              (106,1,'site-a','e-same-time','v-before',1,-10000),
              (107,1,'site-a','e-right','v-before',1,400),
              (108,1,'site-a','e-only','v-only',1,150),
              (109,1,'site-a','e-only-before','v-only',1,30),
              (110,1,'site-a','e-orphan-name','v-report',999,200),
              (111,2,'site-b','e-one','v-report',4,200),
              (112,1,'site-a','e-blank','v-blank',1,220);
      `);
      const base = createQueryTime(100, 300, "UTC", 400);
      const history = { ...base, readRange: createTimeRange(-10000, 400) };
      const read = (
        scope: "session" | "visitor",
        expression: string,
        time: QueryTime = history,
        forceSet = false,
      ) => {
        const data = dataset(expression, scope, time);
        const sql = forceSet
          ? data.ctes.replaceAll("LIMIT 1 OFFSET 64", "LIMIT 1 OFFSET 0")
          : data.ctes;
        const rows = (relation: string, column: string) =>
          select(
            db,
            `WITH ${sql} SELECT site_pk,${column} FROM ${relation} ORDER BY site_pk,${column}`,
            data.bindings.map((b) => b.value),
          );
        return {
          sql: data.ctes,
          visits: rows(data.visitRelation, "visit_id"),
          events: rows(data.eventRelation, "event_pk"),
        };
      };
      const namedPair =
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" }]) exists';
      const forward =
        'sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }]) exists';
      const reverse =
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "signup" }]) exists';
      const overlap =
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name exists }]) exists';
      const lowerExpressions = [
        "sequence([EVENT,EVENT,EVENT]) { $span gte 130ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $span gt 130ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,2) gte 100ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,2) gt 100ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(2,3) gte 30ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(2,3) gt 30ms } exists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) { $gap(2,3) gte 0ms } notExists",
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" }]) { $span gte 0ms } exists',
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" }]) { $span gt 0ms } exists',
        "sequence([EVENT { $.name exists },EVENT { $.name exists },EVENT { $.name exists }]) { $gap(2,3) gte 0ms } notExists",
      ];
      const expressions = [
        "sequence([EVENT,EVENT]) exists",
        "sequence([EVENT,EVENT]) notExists",
        "sequence([EVENT,EVENT,EVENT]) exists",
        namedPair,
        namedPair.replace(" exists", " notExists"),
        'sequence([EVENT { $.name eq "missing" },EVENT { $.name eq "missing" }]) notExists',
        "sequence([EVENT { $.name exists },EVENT { $.name exists },EVENT { $.name exists }]) exists",
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" }]) exists',
        forward,
        reverse,
        overlap,
        forward.replace("]) exists", "]) notExists"),
        overlap.replace("]) exists", "]) notExists"),
        'sequence([EVENT { $.name exists },EVENT { $.name eq "missing" }]) notExists',
        'sequence([EVENT { $.name eq "missing" },EVENT { $.name exists }]) exists',
        ...lowerExpressions,
      ];
      for (const scope of ["session", "visitor"] as const) {
        for (const expression of expressions) {
          const actual = read(scope, expression);
          expect(actual.sql).toContain("history_visit");
          expect(actual.sql).toContain("LIMIT 1 OFFSET 64");
          expect(actual).toEqual(read(scope, expression, history, true));
        }
        const pair = read(scope, expressions[0]!);
        expect(pair.visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
          { site_pk: 1, visit_id: "v-report" },
        ]);
        expect(pair.events).toEqual([
          { site_pk: 1, event_pk: 102 },
          { site_pk: 1, event_pk: 103 },
          { site_pk: 1, event_pk: 108 },
        ]);
        for (const i of [0, 2, 4]) {
          expect(read(scope, lowerExpressions[i]!).visits).toEqual([
            { site_pk: 1, visit_id: "v-new" },
          ]);
        }
        for (const i of [1, 3, 5]) {
          expect(read(scope, lowerExpressions[i]!).visits).toEqual([]);
        }
        expect(read(scope, lowerExpressions[7]!).visits).toEqual(pair.visits);
        expect(read(scope, lowerExpressions[8]!).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
        ]);
        expect(read(scope, lowerExpressions[8]!).events).toEqual([
          { site_pk: 1, event_pk: 102 },
          { site_pk: 1, event_pk: 103 },
          { site_pk: 1, event_pk: 108 },
        ]);
        expect(
          read(scope, "sequence([EVENT,EVENT]) { $span lte 1000ms } exists")
            .sql,
        ).not.toContain("history_visit");
        expect(
          read(scope, lowerExpressions[0]!, {
            ...history,
            filterRange: createTimeRange(100, 300),
          }).sql,
        ).not.toContain("history_visit");
        const triple = read(scope, expressions[2]!);
        expect(triple.visits).toEqual([{ site_pk: 1, visit_id: "v-new" }]);
        expect(
          read(scope, "sequence([EVENT,EVENT,EVENT,EVENT,EVENT,EVENT]) exists")
            .sql,
        ).not.toContain("history_visit");
        expect(read(scope, expressions[0]!, base).sql).not.toContain(
          "history_visit",
        );
        expect(
          read(scope, expressions[0]!, {
            ...history,
            filterRange: createTimeRange(100, 300),
          }).sql,
        ).not.toContain("history_visit");
        expect(read(scope, namedPair).visits).toEqual(pair.visits);
        expect(read(scope, namedPair).events).toEqual(pair.events);
        expect(read(scope, expressions[7]!).visits).toEqual([]);
        expect(read(scope, expressions[7]!).events).toEqual([]);
        expect(
          read(scope, namedPair, {
            ...history,
            filterRange: createTimeRange(100, 300),
          }).sql,
        ).not.toContain("history_visit");
        expect(
          read(
            scope,
            'sequence([EVENT { $.name contains "purchase" },EVENT { $.name contains "purchase" }]) exists',
          ).sql,
        ).not.toContain("history_visit");
        expect(read(scope, forward).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
        ]);
        expect(read(scope, reverse).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
        ]);
        expect(read(scope, overlap).visits).toEqual(pair.visits);
        expect(read(scope, overlap).events).toEqual(pair.events);
        expect(
          read(scope, forward, {
            ...history,
            filterRange: createTimeRange(100, 300),
          }).sql,
        ).not.toContain("history_visit");
        expect(
          read(
            scope,
            'sequence([EVENT { $.name contains "signup" },EVENT { $.name eq "purchase" }]) exists',
          ).sql,
        ).not.toContain("history_visit");
      }
      // Both paths reuse the same normalized event.name comparison.
      db.exec("UPDATE custom_event_names SET name=' purchase ' WHERE id=1");
      for (const scope of ["session", "visitor"] as const) {
        expect(read(scope, namedPair)).toEqual(
          read(scope, namedPair, history, true),
        );
        expect(read(scope, namedPair).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
          { site_pk: 1, visit_id: "v-report" },
        ]);
      }
      // Equal timestamps are ordered by binary event ID, not by name or insertion order.
      // The right-boundary purchase does not qualify the reverse order.
      db.exec(
        "INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at) VALUES(113,1,'site-a','e-z','v-before',2,-10000)",
      );
      for (const scope of ["session", "visitor"] as const) {
        expect(read(scope, forward).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
        ]);
        expect(read(scope, reverse).visits).toEqual([
          { site_pk: 1, visit_id: "v-new" },
          { site_pk: 1, visit_id: "v-report" },
        ]);
        expect(read(scope, reverse)).toEqual(
          read(scope, reverse, history, true),
        );
      }
      const insert = db.prepare(
        "INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES(1,'site-a',?,?,?,'/dense',200,1)",
      );
      for (let i = 0; i < 70; i++)
        insert.run("dense-" + i, "dense-session-" + i, "dense-visitor-" + i);
      for (const scope of ["session", "visitor"] as const)
        for (const expression of expressions)
          expect(read(scope, expression)).toEqual(
            read(scope, expression, history, true),
          );
    } finally {
      db.close();
    }
  });

  it("uses authorized indexed Page blockers without changing global Adjacent read domains", () => {
    const db = sqliteFixture();
    try {
      db.exec(`
        CREATE UNIQUE INDEX test_visit_key ON visits(site_pk,visit_id);
        CREATE INDEX test_visit_session ON visits(site_pk,session_id,started_at);
        CREATE INDEX test_visit_visitor ON visits(site_pk,visitor_id,started_at);
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms)
        VALUES (1,'site-a','v-history','s3','u3','/old',-20,1),
               (1,'site-a','v-blocker','s3','u3','/between',90,1),
               (1,'site-a','v-report','s3','u3','/report',200,1),
               (2,'site-b','v-blocker','s3','u3','/other-site',90,1);
        INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at)
        VALUES (105,1,'site-a','e-history-start','v-history',2,70),
               (106,1,'site-a','e-history-end','v-history',1,110);
      `);
      const expression =
        'adjacent(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) exists';
      const base = createQueryTime(100, 300, "UTC", 400);
      const history = { ...base, readRange: createTimeRange(0, 300) };
      const read = (
        scope: "session" | "visitor",
        time: QueryTime,
        expr = expression,
      ) => {
        const compiled = dataset(expr, scope, time);
        return {
          sql: compiled.ctes,
          rows: select(
            db,
            `WITH ${compiled.ctes} SELECT site_pk,event_id FROM ${compiled.eventRelation} WHERE event_id='e-history-end' ORDER BY site_pk,event_id`,
            compiled.bindings.map((b) => b.value),
          ),
        };
      };
      const hit = [{ site_pk: 1, event_id: "e-history-end" }];
      for (const scope of ["session", "visitor"] as const) {
        expect(read(scope, history).sql).toContain("CROSS JOIN visits");
        expect(read(scope, history).rows).toEqual([]);
        expect(read(scope, base).rows).toEqual([]);
      }
      db.exec(
        "UPDATE visits SET started_at=-1 WHERE site_pk=1 AND visit_id='v-blocker'",
      );
      for (const scope of ["session", "visitor"] as const) {
        expect(read(scope, history).rows).toEqual(hit);
        const explicit = { ...history, filterRange: createTimeRange(100, 300) };
        expect(read(scope, explicit).sql).not.toContain("CROSS JOIN visits");
        expect(read(scope, explicit).rows).toEqual([]);
      }
      db.exec(
        "UPDATE visits SET visit_id='s3',session_id=NULL,visitor_id='other',started_at=90 WHERE site_pk=1 AND visit_id='v-blocker'",
      );
      expect(read("session", history).rows).toEqual([]);
      expect(read("visitor", history).rows).toEqual(hit);
      db.exec(
        "UPDATE visits SET started_at=300 WHERE site_pk=1 AND visit_id='s3'",
      );
      expect(read("session", history).rows).toEqual(hit);
      expect(
        read("session", history, "adjacent(sequence([PAGE,EVENT])) exists").sql,
      ).toContain("CROSS JOIN visits");
    } finally {
      db.close();
    }
  });

  it("preserves mixed indexed Adjacent witnesses, collision blockers and predicate bindings", () => {
    const db = sqliteFixture();
    try {
      db.exec(`
        CREATE UNIQUE INDEX test_visit_key ON visits(site_pk,visit_id);
        CREATE INDEX test_visit_session ON visits(site_pk,session_id,started_at);
        CREATE INDEX test_visit_visitor ON visits(site_pk,visitor_id,started_at);
        INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms)
        VALUES (1,'site-a','v-history','s3','u3','/old',-20,1),
               (1,'site-a','v-between','s3','u3','/between',90,1),
               (1,'site-a','v-report','s3','u3','/report',200,1),
               (2,'site-b','v-between','s3','u3','/between',90,1);
        INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at)
        VALUES (105,1,'site-a','e-history-start','v-history',2,70),
               (106,1,'site-a','e-history-end','v-history',1,110);
      `);
      const base = createQueryTime(100, 300, "UTC", 400);
      const history = { ...base, readRange: createTimeRange(0, 300) };
      const forward =
        'adjacent(sequence([PAGE { $.path eq "/between" },EVENT { $.name eq "purchase" }]))';
      const reverse =
        'adjacent(sequence([EVENT { $.name eq "signup" },PAGE { $.path contains "/between" }]))';
      const read = (
        scope: "session" | "visitor",
        expression: string,
        time: QueryTime = history,
      ) => {
        const compiled = dataset(expression, scope, time);
        return {
          sql: compiled.ctes,
          rows: select(
            db,
            `WITH ${compiled.ctes} SELECT site_pk,event_id FROM ${compiled.eventRelation} WHERE event_id='e-history-end' ORDER BY site_pk,event_id`,
            compiled.bindings.map((b) => b.value),
          ),
        };
      };
      const hit = [{ site_pk: 1, event_id: "e-history-end" }];
      for (const scope of ["session", "visitor"] as const) {
        for (const expr of [forward, reverse]) {
          expect(read(scope, expr + " exists").sql).toContain(
            "CROSS JOIN visits",
          );
          expect(read(scope, expr + " exists").rows).toEqual(hit);
          expect(read(scope, expr + " notExists").rows).toEqual([]);
          expect(read(scope, expr + " exists", base).rows).toEqual([]);
        }
        expect(
          read(scope, forward + " exists", {
            ...history,
            filterRange: createTimeRange(100, 300),
          }).sql,
        ).not.toContain("CROSS JOIN visits");
      }
      db.exec(
        "UPDATE visits SET visit_id='s3',session_id=NULL WHERE site_pk=1 AND visit_id='v-between'",
      );
      // The same Page remains a real visitor witness, but cannot witness a Session.
      for (const expr of [forward, reverse]) {
        expect(read("session", expr + " exists").rows).toEqual([]);
        expect(read("session", expr + " notExists").rows).toEqual(hit);
        expect(read("visitor", expr + " exists").rows).toEqual(hit);
      }
      db.exec(
        "UPDATE visits SET session_id='s3',started_at=110 WHERE site_pk=1 AND visit_id='s3'",
      );
      // Page precedes Event at equal timestamps.
      expect(read("session", forward + " exists").rows).toEqual(hit);
      expect(read("session", reverse + " exists").rows).toEqual(hit);
      db.exec(
        "INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES(1,'site-a','v-noise','s3','u3','/noise',100,1)",
      );
      expect(read("session", reverse + " exists").rows).toEqual([]);
      expect(read("session", forward + " exists").rows).toEqual(hit);
    } finally {
      db.close();
    }
  });

  it("preserves Session adjacency when a sessionless Visit key collides", async () => {
    const { db, env } = runFixture();
    try {
      db.exec(
        "INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES(1,'site-a','s1','','other','/between',140,1)",
      );
      const doc = parseFilterDsl(
        'adjacent(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) exists',
        analyticsFilterRegistry,
      );
      for (const kind of ["session", "visitor"] as const) {
        const plan = createScopedFilterPlan(
          (kind + "-events") as "session-events" | "visitor-events",
          doc,
          kind,
        )!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: kind,
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: ["site-a"],
        });
        const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
        const target = { type: kind, value: kind === "session" ? "s1" : "u1" };
        const original = compileScopedDatasetSql(input);
        const restricted = compileScopedDatasetSql({ ...input, target });
        if (kind === "session") {
          expect(restricted.ctes).toContain("scope_filter_timeline_visits AS");
          expect(restricted.ctes).toContain("AND session_id = ?");
        } else expect(restricted.ctes).toContain("AND visitor_id = ?");
        const column = kind + "_id";
        const read = (dataset: ReturnType<typeof compileScopedDatasetSql>) =>
          db
            .prepare(
              `WITH ${dataset.ctes} SELECT * FROM ${dataset.eventRelation} WHERE ${column}=? ORDER BY event_id`,
            )
            .all(...dataset.bindings.map((b) => b.value), target.value);
        expect(read(restricted)).toEqual(read(original));
        const result = await queryJourneyEventsPageFromD1(
          env,
          "site-a",
          WINDOW,
          filters,
          target,
          100,
        );
        expect(result.items.length > 0).toBe(kind === "visitor");
      }
    } finally {
      db.close();
    }
  });
  it("keeps collision events position-only even when their linked visit is outside R", async () => {
    const { db, env } = runFixture();
    try {
      db.exec(
        "INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES(1,'site-a','s1',NULL,'other','/outside',20,1),(2,'site-b','s1','','other','/other-site',140,1); INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at) VALUES(105,1,'site-a','collision-event','s1',3,145)",
      );
      const doc = parseFilterDsl(
        'adjacent(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) exists',
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("session-events", doc, "session")!;
      const target = { type: "session", value: "s1" } as const;
      const filters = attachScopedFilterMetadata(doc, {
        requestedScope: "session",
        resolvedScope: plan.scope,
        plan,
        time: createQueryTime(100, 300, "UTC", 400),
        siteIds: ["site-a"],
      });
      const input = { filters, plan, siteIds: ["site-a"], window: WINDOW };
      const read = (dataset: ReturnType<typeof compileScopedDatasetSql>) =>
        db
          .prepare(
            `WITH ${dataset.ctes} SELECT * FROM ${dataset.eventRelation} WHERE session_id = ? ORDER BY event_id`,
          )
          .all(...dataset.bindings.map((b) => b.value), target.value);
      for (const [eventTime, expected] of [
        [145, false],
        [160, false],
        [300, true],
      ] as const) {
        db.prepare(
          "UPDATE custom_events SET occurred_at=? WHERE event_pk=105",
        ).run(eventTime);
        const original = compileScopedDatasetSql(input);
        const restricted = compileScopedDatasetSql({ ...input, target });
        expect(read(restricted)).toEqual(read(original));
        const page = await queryJourneyEventsPageFromD1(
          env,
          "site-a",
          WINDOW,
          filters,
          target,
          100,
        );
        // At an equal timestamp, collision-event sorts before e-purchase.
        expect(page.items.length > 0).toBe(expected);
        expect(page.items.some((item) => item.id === "collision-event")).toBe(
          false,
        );
      }
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

  it("matches complete event trend totals without computing named series", async () => {
    const { db } = runFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      for (const filters of [
        EMPTY_FILTER_DOCUMENT,
        ready("comparison"),
        ready("comparison", 'event.name eq "not-present"'),
      ]) {
        const expected = await queryEventsTrendFromD1(
          env,
          "site-a",
          WINDOW,
          "minute",
          filters,
          1,
        );
        const before = trace.preparedSql.length;
        const totals = await queryEventTotalsTrendFromD1(
          env,
          "site-a",
          WINDOW,
          "minute",
          filters,
        );
        expect(totals).toEqual(
          expected.data.map(({ bucket, timestampMs, totalEvents }) => ({
            bucket,
            timestampMs,
            totalEvents,
          })),
        );
        expect(trace.preparedSql.length - before).toBe(1);
        expect(trace.preparedSql[before]).not.toContain("GROUP BY event_name");
        expect(
          await queryEventTotalFromD1(env, "site-a", WINDOW, filters),
        ).toBe(expected.data.reduce((sum, row) => sum + row.totalEvents, 0));
      }
      expect(
        await queryEventTotalFromD1(env, "site-b", WINDOW, ready("comparison")),
      ).toBe(0);
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
        metrics: ["views", "events"] as const,
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

  it.each([
    ["", "event"],
    ["", "session"],
    ["", "visitor"],
    ['page.path eq "/home"', "event"],
    ['page.path eq "/home"', "session"],
    ['event.name eq "purchase"', "event"],
    ['event.payload("/items/1/sku") eq "B"', "event"],
    ['page.path eq "/home" AND event.name eq "purchase"', "visitor"],
    ['page.path eq "/home" OR event.name eq "view"', "session"],
    ['NOT (page.path eq "/docs")', "visitor"],
    ["session.views gte 1 AND session.events gte 1", "session"],
    ["session.views gte 1", "visitor"],
    ['first(EVENT).name eq "purchase"', "session"],
    [
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
      "visitor",
    ],
    ['count(EVENT { $.name eq "missing" }) eq 0', "session"],
  ] as const)(
    "proves canonical source uniqueness and preserves funnel results for %s (%s)",
    (expression, scope) => {
      const { db } = runFixture();
      try {
        // A second qualifying Visit and Event share the same entity. Entity
        // membership and event-to-Visit qualification must not amplify either.
        db.exec(
          "INSERT INTO visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,started_at,duration_ms) VALUES(1,'site-a','v-repeat','s1','u1','/home',180,15); INSERT INTO custom_events(event_pk,site_pk,site_id,event_id,visit_id,event_name_id,occurred_at,sequence) VALUES(105,1,'site-a','e-repeat','v-repeat',1,190,0); UPDATE custom_events SET sequence=0 WHERE sequence IS NULL",
        );
        const doc = expression
          ? parseFilterDsl(expression, analyticsFilterRegistry)
          : EMPTY_FILTER_DOCUMENT;
        const plan = createScopedFilterPlan("funnel-analysis", doc, scope)!;
        const filters = attachScopedFilterMetadata(doc, {
          requestedScope: scope,
          resolvedScope: plan.scope,
          plan,
          time: createQueryTime(100, 300, "UTC", 400),
          siteIds: SITES,
        });
        const input = { filters, plan, siteIds: SITES, window: WINDOW };
        const canonical = compileScopedDatasetSql(input);
        const optimized = !expression.startsWith("session.views");
        expect(canonical.uniqueObservationIds).toBe(optimized);
        expect(
          compileScopedDatasetSql({ ...input, compatibilityEventSource: true })
            .uniqueObservationIds,
        ).toBe(false);
        for (const [relation, id] of [
          [canonical.visitRelation, "visit_id"],
          [canonical.eventRelation, "event_id"],
        ])
          expect(
            select(
              db,
              `WITH ${canonical.ctes} SELECT site_pk,${id} FROM ${relation} GROUP BY site_pk,${id} HAVING COUNT(*)>1`,
              canonical.bindings.map((binding) => binding.value),
            ),
          ).toEqual([]);
        const legacy = { ...canonical, uniqueObservationIds: false };
        for (const progressionScope of ["session", "visitor"] as const) {
          const config = {
            filterDslVersion: 1 as const,
            progressionScope,
            conversionWindowMs: progressionScope === "visitor" ? 1000 : null,
            steps: [
              { id: "page", filterDsl: 'page.path eq "/home"' },
              { id: "purchase", filterDsl: 'event.name eq "purchase"' },
              { id: "repeat", filterDsl: 'event.name eq "purchase"' },
            ],
          };
          const oldPlan = buildFunnelSqlPlan(config, legacy);
          const newPlan = buildFunnelSqlPlan(config, canonical);
          expect(oldPlan.sql).toContain("source_rank");
          if (optimized) expect(newPlan.sql).not.toContain("source_rank");
          else expect(newPlan.sql).toContain("source_rank");
          expect(
            select(
              db,
              newPlan.sql,
              newPlan.bindings.map((binding) => binding.value),
            ),
          ).toEqual(
            select(
              db,
              oldPlan.sql,
              oldPlan.bindings.map((binding) => binding.value),
            ),
          );
          for (const outcome of ["converted", "dropoff"] as const) {
            const read = (source: typeof canonical) => {
              const membership = buildFunnelMembershipSqlPlan(
                config,
                source,
                2,
                { outcome },
              );
              return select(
                db,
                `WITH ${source.ctes},${membership.ctes} SELECT * FROM ${membership.relation} ORDER BY site_pk,session_id,visitor_id`,
                [...source.bindings, ...membership.bindings].map(
                  (binding) => binding.value,
                ),
              );
            };
            expect(read(canonical)).toEqual(read(legacy));
          }
        }
      } finally {
        db.close();
      }
    },
  );
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

  it("shares nonempty team entity qualification with exact independent overview and trend parity", async () => {
    const { db } = runFixture();
    try {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = { DB: createSqliteD1Database(db, trace) } as never;
      for (const scope of ["session", "visitor"] as const) {
        for (const expression of [
          'geo.country eq "US"',
          'page.path contains "/"',
          'event.name eq "absent"',
        ]) {
          const doc = parseFilterDsl(expression, analyticsFilterRegistry);
          const plan = createScopedFilterPlan("team-dashboard", doc, scope)!;
          const filters = attachScopedFilterMetadata(doc, {
            requestedScope: scope,
            resolvedScope: plan.scope,
            plan,
            time: createQueryTime(100, 300, "UTC", 400),
            siteIds: ["site-a", "site-b"],
          });
          const expectedOverview = await queryTeamOverviewFromD1(
            env,
            ["site-a", "site-b"],
            WINDOW,
            undefined,
            filters,
          );
          const expectedTrend = await queryTeamTrendFromD1(
            env,
            ["site-a", "site-b"],
            WINDOW,
            "minute",
            undefined,
            filters,
          );
          const before = trace.preparedSql.length;
          const actual = await queryTeamScopedCurrentFromD1(
            env,
            ["site-a", "site-b"],
            WINDOW,
            "minute",
            filters,
          );
          expect(actual.overview).toEqual(expectedOverview);
          expect(actual.trend).toEqual(expectedTrend);
          expect(trace.preparedSql.length - before).toBe(1);
          expect(trace.preparedSql[before]).toContain(
            "shared_team_visits AS MATERIALIZED",
          );
          expect(trace.bindings[before].length).toBeLessThanOrEqual(100);
          const isolated = await queryTeamScopedCurrentFromD1(
            env,
            ["site-a"],
            WINDOW,
            "minute",
            filters,
          );
          expect(
            [...isolated.overview.keys()].every((id) => id === "site-a"),
          ).toBe(true);
          expect(isolated.trend.every((row) => row.siteId === "site-a")).toBe(
            true,
          );
        }
      }
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

describe("System preset end-to-end SQLite smoke matrix", () => {
  it.each(SYSTEM_FILTER_PRESETS)(
    "executes $id for its declared scope",
    (preset) => {
      const db = sqlitePayloadFixture();
      try {
        const scopes =
          preset.scope === "preserve"
            ? (["event", "session", "visitor"] as const)
            : [preset.scope];
        for (const scope of scopes) {
          const sql = dataset(preset.filterDsl, scope);
          const results = select(
            db,
            "WITH " +
              sql.ctes +
              " SELECT (SELECT COUNT(*) FROM " +
              sql.visitRelation +
              ") AS views, (SELECT COUNT(*) FROM " +
              sql.eventRelation +
              ") AS events",
            sql.bindings.map((binding) => binding.value),
          );
          expect(results).toHaveLength(1);
          expect(results[0]).toEqual({
            views: expect.any(Number),
            events: expect.any(Number),
          });
        }
      } finally {
        db.close();
      }
    },
  );
});
