import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/contract/types";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import {
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import * as hourlyRollupQueries from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import {
  buildOverviewClientDimensionTabs,
  buildOverviewGeoDimensionTabs,
  queryOverviewAggregate,
  queryOverviewFromD1,
  queryTrendAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type CanonicalJsonPath,
  type FilterDocument,
  type FilterDocument as RawFilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import type { FilterScopePreference } from "@/lib/filter-contract/scope-preference";

const SITE_ID = "wave62-overview-site";
const OTHER_SITE_ID = "wave62-overview-other-site";
const WINDOW: QueryWindow = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 180,
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  startMs: 0,
  endExclusiveMs: WINDOW.startMs,
  nowMs: WINDOW.nowMs,
  timeZone: WINDOW.timeZone,
};

interface SiteIdentity {
  readonly siteId: string;
  readonly sitePk: number;
}

interface PageInput {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly pathname?: string;
  readonly siteId?: string;
}

interface EventInput {
  readonly eventId: string;
  readonly ownerVisitId: string;
  readonly occurredAt: number;
  readonly name: string;
  readonly siteId?: string;
}

interface CapturedQuery {
  readonly sql: string;
  readonly bindings: Array<string | number | null>;
}

function createDatabase(): {
  readonly database: DatabaseSync;
  readonly sites: ReadonlyMap<string, SiteIdentity>;
} {
  const database = createMigratedDatabase();
  const sites = new Map<string, SiteIdentity>();
  for (const siteId of [SITE_ID, OTHER_SITE_ID]) {
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run(siteId);
    const row = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { readonly site_pk: number };
    sites.set(siteId, { siteId, sitePk: row.site_pk });
  }
  return { database, sites };
}

function insertPage(
  database: DatabaseSync,
  sites: ReadonlyMap<string, SiteIdentity>,
  input: PageInput,
): void {
  const site = sites.get(input.siteId ?? SITE_ID);
  if (!site) throw new Error("wave62_overview_site_missing");
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, duration_ms, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'overview.test')`,
    )
    .run(
      input.visitId,
      site.siteId,
      site.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.durationMs,
      input.pathname ?? "/page",
    );
}

function insertEvent(
  database: DatabaseSync,
  sites: ReadonlyMap<string, SiteIdentity>,
  input: EventInput,
): void {
  const site = sites.get(input.siteId ?? SITE_ID);
  if (!site) throw new Error("wave62_overview_event_site_missing");
  database
    .prepare(
      "INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(site.siteId, input.name, input.occurredAt, site.sitePk);
  const name = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.sitePk, input.name) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      input.eventId,
      site.siteId,
      site.sitePk,
      input.ownerVisitId,
      name.id,
      input.occurredAt,
      input.occurredAt,
    );
}

function filterDocument(root: RawFilterDocument["root"]): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function fieldFilter(field: string, value: string | number, operator = "eq") {
  return filterDocument({
    kind: "condition",
    target: { kind: "field", field },
    operator,
    value,
  } as RawFilterDocument["root"]);
}

function payloadExistsFilter(count: number): FilterDocument {
  return filterDocument({
    kind: "and",
    children: Array.from({ length: count }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/wave62/payload-${index}` as CanonicalJsonPath,
      },
      operator: "exists" as const,
    })),
  } as RawFilterDocument["root"]);
}

function emptyAndFilter(): FilterDocument {
  return {
    version: 1,
    root: { kind: "and", children: [] },
  } as unknown as FilterDocument;
}

function queryTime(window: QueryWindow): QueryTime {
  return createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
}

function preparedFilter(input: {
  readonly filters: FilterDocument;
  readonly scopePreference: FilterScopePreference;
  readonly advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>;
  readonly preparationWindow?: QueryWindow;
}): FilterDocument {
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: queryTime(input.preparationWindow ?? WINDOW),
    filters: input.filters,
    scopePreference: input.scopePreference,
  } as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePreference: FilterScopePreference;
  }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave62_overview_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave62_overview_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: { ...prepared.scopePlan, advancedMatches: input.advancedMatches },
  });
}

/** Frozen pre-Wave62 Overview SQL, source selection, filter and binding assembly. */
function parentOverviewSql(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): { readonly sql: string; readonly bindings: Array<string | number | null> } {
  const scopedDataset =
    scopedDatasetFor(siteId, window, filters) ??
    scopedDatasetForUnpreparedReader(
      "overview",
      siteId,
      window,
      filters,
      "session",
    );
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : "filtered_visits";
  const entityCounts = scopedDataset
    ? `
  (SELECT count(*) FROM ${scopedDataset.sessionRelation}) AS sessions,
  (SELECT count(*) FROM ${scopedDataset.visitorRelation}) AS visitors,`
    : `
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,`;
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),`;
  const sql = `
WITH
${sourceSql}
session_rollup AS (
  SELECT vs.session_id, count(*) AS visit_count
  FROM ${metricSource} vs
  WHERE vs.session_id != ''
  GROUP BY vs.session_id
)
SELECT
  count(*) AS views,
${entityCounts}
  COALESCE((SELECT count(*) FROM session_rollup WHERE visit_count = 1), 0) AS bounces,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
FROM ${metricSource}
`;
  return {
    sql,
    bindings: scopedDataset
      ? scopedDataset.bindings.map(({ value }) => value)
      : [...visitSourceBindings(siteId, window), ...filter.bindings],
  };
}

async function parentOverview(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<OverviewAggregateRow> {
  const parent = parentOverviewSql(siteId, window, filters);
  const row = database.prepare(parent.sql).get(...parent.bindings) as
    Record<string, unknown> | undefined;
  return {
    views: Number(row?.views ?? 0),
    sessions: Number(row?.sessions ?? 0),
    visitors: Number(row?.visitors ?? 0),
    bounces: Number(row?.bounces ?? 0),
    totalDuration: Number(row?.totalDuration ?? 0),
    durationViews: Number(row?.durationViews ?? 0),
  };
}

interface OverviewAggregateRow {
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly bounces: number;
  readonly totalDuration: number;
  readonly durationViews: number;
}

async function logicalOverview(
  database: DatabaseSync,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<{
  readonly row: OverviewAggregateRow;
  readonly trace: SqliteD1Trace;
}> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const row = await queryOverviewFromD1(
    { DB: createSqliteD1Database(database, trace) } as unknown as Env,
    SITE_ID,
    window,
    filters,
  );
  return { row, trace };
}

function createCaptureEnv(): {
  readonly env: Env;
  readonly calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: Array<string | number | null>) {
            calls.push({ sql, bindings });
            return {
              async all() {
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

async function compilePublicReader(
  name: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<{
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly observation: Record<string, unknown>;
  readonly statementCount: number;
}> {
  const { env, calls } = createCaptureEnv();
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const operation = `wave62.overview.${name}`;
  await runWithInvocationLogger(logger, () =>
    runWithD1Operation(operation, () =>
      queryOverviewFromD1(instrumentEnv(env, logger), SITE_ID, window, filters),
    ),
  );
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let emitted;
  try {
    emitted = await logger.emitWhenComplete();
  } finally {
    consoleLog.mockRestore();
  }
  const call = calls[0];
  const observation = emitted.logs.find(
    (entry) =>
      entry.message === "db.query.v1.all.success" &&
      entry.data?.tag === operation,
  )?.data;
  if (!call || !observation)
    throw new Error("wave62_overview_public_reader_observation_missing");
  return {
    sql: call.sql,
    bindings: call.bindings,
    observation,
    statementCount: calls.length,
  };
}

function addPayloadValues(
  database: DatabaseSync,
  site: SiteIdentity,
  eventId: string,
  ownerVisitId: string,
  paths: readonly string[],
): void {
  insertEvent(database, new Map([[site.siteId, site]]), {
    eventId,
    ownerVisitId,
    occurredAt: WINDOW.startMs + 2,
    name: "payload",
  });
  const event = database
    .prepare(
      "SELECT event_pk, event_name_id FROM custom_events WHERE event_id = ?",
    )
    .get(eventId) as {
    readonly event_pk: number;
    readonly event_name_id: number;
  };
  const insertPath = database.prepare(
    "INSERT OR IGNORE INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?)",
  );
  const insertNode = database.prepare(
    "INSERT INTO custom_event_json_nodes (event_pk, node_id, path_id, value_type, depth) VALUES (?, ?, ?, 1, 1)",
  );
  const insertValue = database.prepare(
    `INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'present')`,
  );
  for (const [index, path] of paths.entries()) {
    insertPath.run(site.siteId, site.sitePk, path, WINDOW.startMs + 2);
    const pathRow = database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.sitePk, path) as { readonly id: number };
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathRow.id);
    insertValue.run(
      event.event_pk,
      nodeId,
      site.siteId,
      site.sitePk,
      event.event_name_id,
      pathRow.id,
      WINDOW.startMs + 2,
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Overview six-metric Logical report", () => {
  it("selects complete hourly rollups only for unfiltered overview and trend reads", async () => {
    const { database } = createDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
    } as unknown as Env;
    const overviewValue = {
      views: 7,
      sessions: 5,
      visitors: 4,
      bounces: 2,
      totalDuration: 90,
      durationViews: 3,
    };
    const overviewRollup = vi
      .spyOn(hourlyRollupQueries, "queryOverviewForSitesFromHourlyRollups")
      .mockResolvedValue(new Map([[SITE_ID, overviewValue]]));
    const trendRollupRow = {
      siteId: SITE_ID,
      bucket: 0,
      timestampMs: 0,
      views: 7,
      sessions: 5,
      visitors: 4,
      bounces: 2,
      totalDuration: 90,
      durationViews: 3,
    };
    const trendRollup = vi
      .spyOn(hourlyRollupQueries, "queryTrendForSitesFromHourlyRollups")
      .mockResolvedValue([
        trendRollupRow,
        { ...trendRollupRow, siteId: OTHER_SITE_ID },
      ]);

    try {
      const overview = await queryOverviewAggregate(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      );
      const trend = await queryTrendAggregate(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
      );

      expect(overview).toEqual({
        value: overviewValue,
        source: "d1",
        diagnosticSource: "rollup",
        approximateVisitors: false,
      });
      expect(trend).toEqual({
        value: [
          {
            bucket: 0,
            timestampMs: 0,
            views: 7,
            sessions: 5,
            visitors: 4,
            bounces: 2,
            totalDuration: 90,
            durationViews: 3,
          },
        ],
        source: "d1",
        diagnosticSource: "rollup",
      });
      expect(trace.preparedSql).toEqual([]);
      expect(overviewRollup).toHaveBeenCalledWith(
        env,
        [SITE_ID],
        WINDOW,
        undefined,
      );
      expect(trendRollup).toHaveBeenCalledWith(
        env,
        [SITE_ID],
        WINDOW,
        "hour",
        undefined,
      );

      overviewRollup.mockResolvedValue(null);
      trendRollup.mockResolvedValue(null);
      const overviewFallback = await queryOverviewAggregate(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      );
      const trendFallback = await queryTrendAggregate(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
      );
      expect(overviewFallback).toMatchObject({
        source: "d1",
        diagnosticSource: "raw",
      });
      expect(trendFallback).toMatchObject({
        source: "d1",
        diagnosticSource: "raw",
      });
      expect(trace.preparedSql.length).toBeGreaterThan(0);

      const filtered = fieldFilter("geo.country", "US");
      const overviewCallsBeforeFilter = overviewRollup.mock.calls.length;
      const trendCallsBeforeFilter = trendRollup.mock.calls.length;
      await queryOverviewAggregate(env, SITE_ID, WINDOW, filtered);
      await queryTrendAggregate(env, SITE_ID, WINDOW, "hour", filtered);
      expect(overviewRollup).toHaveBeenCalledTimes(overviewCallsBeforeFilter);
      expect(trendRollup).toHaveBeenCalledTimes(trendCallsBeforeFilter);

      const preparedEmpty = preparedFilter({
        filters: EMPTY_FILTER_DOCUMENT,
        scopePreference: "session",
        advancedMatches: { entityIds: [] },
      });
      expect(scopedFilterMetadata(preparedEmpty)).toBeDefined();
      const overviewCallsBeforePrepared = overviewRollup.mock.calls.length;
      const trendCallsBeforePrepared = trendRollup.mock.calls.length;
      await queryOverviewAggregate(env, SITE_ID, WINDOW, preparedEmpty);
      await queryTrendAggregate(env, SITE_ID, WINDOW, "hour", preparedEmpty);
      expect(overviewRollup).toHaveBeenCalledTimes(overviewCallsBeforePrepared);
      expect(trendRollup).toHaveBeenCalledTimes(trendCallsBeforePrepared);

      const clientTabs = await buildOverviewClientDimensionTabs(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      const geoTabs = await buildOverviewGeoDimensionTabs(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      expect(clientTabs).toBeDefined();
      expect(geoTabs).toBeDefined();
    } finally {
      database.close();
    }
  });

  it("matches the frozen parent DTO across direct, prepared and empty-input scopes", async () => {
    const { database, sites } = createDatabase();
    try {
      const pages: PageInput[] = [
        {
          visitId: "p-shared-a",
          sessionId: "shared",
          visitorId: "v-shared",
          startedAt: 110,
          durationMs: 0,
          pathname: "/match",
        },
        {
          visitId: "p-shared-b",
          sessionId: "shared",
          visitorId: "v-shared",
          startedAt: 120,
          durationMs: 25,
          pathname: "/sibling",
        },
        {
          visitId: "p-single",
          sessionId: "single",
          visitorId: "v-single",
          startedAt: 130,
          durationMs: -5,
          pathname: "/match",
        },
        {
          visitId: "p-empty",
          sessionId: "",
          visitorId: "",
          startedAt: 140,
          durationMs: null,
          pathname: "/empty",
        },
        {
          visitId: "p-space",
          sessionId: " ",
          visitorId: " ",
          startedAt: 150,
          durationMs: 7,
          pathname: "/space",
        },
        {
          visitId: "p-tab",
          sessionId: "\t",
          visitorId: "\u00a0",
          startedAt: 160,
          durationMs: 3,
          pathname: "/tab",
        },
        {
          visitId: "p-padded",
          sessionId: " shared ",
          visitorId: " v-shared ",
          startedAt: 165,
          durationMs: 4,
          pathname: "/padded",
        },
        {
          visitId: "p-event-owner-before-window",
          sessionId: "event-only",
          visitorId: "v-event-only",
          startedAt: 50,
          durationMs: 9,
          pathname: "/owner",
        },
        {
          visitId: "p-window-end",
          sessionId: "end",
          visitorId: "v-end",
          startedAt: 200,
          durationMs: 40,
          pathname: "/end",
        },
        {
          visitId: "p-other-site",
          sessionId: "other",
          visitorId: "v-other",
          startedAt: 120,
          durationMs: 100,
          pathname: "/other",
          siteId: OTHER_SITE_ID,
        },
        {
          visitId: "p-previous",
          sessionId: "previous",
          visitorId: "v-previous",
          startedAt: 50,
          durationMs: 11,
          pathname: "/prepared",
        },
        {
          visitId: "p-previous-event-owner",
          sessionId: "previous-event",
          visitorId: "v-previous-event",
          startedAt: 125,
          durationMs: 19,
          pathname: "/owner",
        },
      ];
      for (const page of pages) insertPage(database, sites, page);
      const events: EventInput[] = [
        {
          eventId: "e-shared",
          ownerVisitId: "p-shared-a",
          occurredAt: 125,
          name: "signup",
        },
        {
          eventId: "e-event-only",
          ownerVisitId: "p-event-owner-before-window",
          occurredAt: 155,
          name: "signup",
        },
        {
          eventId: "e-tab",
          ownerVisitId: "p-tab",
          occurredAt: 166,
          name: "signup",
        },
        {
          eventId: "e-window-end",
          ownerVisitId: "p-shared-a",
          occurredAt: 200,
          name: "signup",
        },
        {
          eventId: "e-other-site",
          ownerVisitId: "p-other-site",
          occurredAt: 125,
          name: "signup",
          siteId: OTHER_SITE_ID,
        },
        {
          eventId: "e-previous",
          ownerVisitId: "p-previous-event-owner",
          occurredAt: 70,
          name: "signup",
        },
      ];
      for (const event of events) insertEvent(database, sites, event);

      const directFilter = fieldFilter("page.path", "/match");
      const eventFactFilter = fieldFilter("event.name", "signup");
      const observationFilter = preparedFilter({
        filters: directFilter,
        scopePreference: "event",
        advancedMatches: {
          visitIds: [
            "p-shared-a",
            "p-space",
            "p-tab",
            "p-padded",
            "p-previous",
          ].map((id) => ({ siteId: SITE_ID, id })),
          eventIds: ["e-shared", "e-event-only", "e-tab", "e-previous"].map(
            (id) => ({ siteId: SITE_ID, id }),
          ),
        },
      });
      const sessionFilter = preparedFilter({
        filters: directFilter,
        scopePreference: "session",
        advancedMatches: {
          entityIds: ["shared", "event-only"].map((id) => ({
            siteId: SITE_ID,
            id,
          })),
        },
      });
      const visitorFilter = preparedFilter({
        filters: directFilter,
        scopePreference: "visitor",
        advancedMatches: {
          entityIds: ["v-shared", "v-event-only"].map((id) => ({
            siteId: SITE_ID,
            id,
          })),
        },
      });
      const emptyPrepared = preparedFilter({
        filters: directFilter,
        scopePreference: "event",
        advancedMatches: { visitIds: [], eventIds: [] },
      });
      const previousPrepared = preparedFilter({
        filters: directFilter,
        scopePreference: "event",
        advancedMatches: {
          visitIds: [{ siteId: SITE_ID, id: "p-previous" }],
          eventIds: [{ siteId: SITE_ID, id: "e-previous" }],
        },
      });
      const cases = [
        { name: "plain", window: WINDOW, filters: EMPTY_FILTER_DOCUMENT },
        {
          name: "direct-page-fact-session-expansion",
          window: WINDOW,
          filters: directFilter,
        },
        {
          name: "direct-event-fact-session-expansion",
          window: WINDOW,
          filters: eventFactFilter,
        },
        {
          name: "direct-empty-and-session-compat",
          window: WINDOW,
          filters: emptyAndFilter(),
        },
        {
          name: "prepared-observation",
          window: WINDOW,
          filters: observationFilter,
        },
        { name: "prepared-session", window: WINDOW, filters: sessionFilter },
        { name: "prepared-visitor", window: WINDOW, filters: visitorFilter },
        { name: "prepared-empty", window: WINDOW, filters: emptyPrepared },
        {
          name: "prepared-current-to-actual-previous",
          window: PREVIOUS_WINDOW,
          filters: previousPrepared,
        },
      ] as const;

      for (const item of cases) {
        const expected = await parentOverview(
          database,
          SITE_ID,
          item.window,
          item.filters,
        );
        const actual = await logicalOverview(
          database,
          item.window,
          item.filters,
        );
        expect(actual.trace.preparedSql, item.name).toHaveLength(1);
        expect(actual.row, item.name).toEqual(expected);
      }
    } finally {
      database.close();
    }
  });

  it("preserves the nonempty difference for 40 independent direct payload predicates", async () => {
    const { database, sites } = createDatabase();
    try {
      const site = sites.get(SITE_ID)!;
      insertPage(database, sites, {
        visitId: "p-payload-40",
        sessionId: "payload-40",
        visitorId: "v-payload-40",
        startedAt: 130,
        durationMs: 2,
      });
      insertPage(database, sites, {
        visitId: "p-payload-39",
        sessionId: "payload-39",
        visitorId: "v-payload-39",
        startedAt: 140,
        durationMs: 3,
      });
      const paths = Array.from(
        { length: 40 },
        (_unused, index) => `/wave62/payload-${index}`,
      );
      addPayloadValues(database, site, "e-payload-40", "p-payload-40", paths);
      addPayloadValues(
        database,
        site,
        "e-payload-39",
        "p-payload-39",
        paths.slice(0, 39),
      );

      const filters = payloadExistsFilter(40);
      const expected = await parentOverview(database, SITE_ID, WINDOW, filters);
      const actual = await logicalOverview(database, WINDOW, filters);
      expect(expected.views).toBe(1);
      expect(actual.row).toEqual(expected);
      expect(actual.trace.preparedSql).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("measures actual public-reader budgets and one-statement lowering", async () => {
    const direct40 = payloadExistsFilter(40);
    const directEvent = fieldFilter("event.name", "signup");
    const pageFilter = fieldFilter("page.path", "/prepared-budget");
    const currentPrepared = preparedFilter({
      filters: pageFilter,
      scopePreference: "event",
      advancedMatches: {
        visitIds: Array.from({ length: 128 }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `wave62-current-${index}`,
        })),
        eventIds: [],
      },
    });
    const emptyPrepared = preparedFilter({
      filters: pageFilter,
      scopePreference: "event",
      advancedMatches: { visitIds: [], eventIds: [] },
    });
    const previousIds = Array.from({ length: 128 }, (_unused, index) => ({
      siteId: SITE_ID,
      id: `wave62-previous-${index}`,
    }));
    const previousPrepared = preparedFilter({
      filters: pageFilter,
      scopePreference: "event",
      advancedMatches: { visitIds: previousIds, eventIds: [] },
    });
    const profiles = [
      { name: "plain", window: WINDOW, filters: EMPTY_FILTER_DOCUMENT },
      {
        name: "unprepared-event-payload-exists-40",
        window: WINDOW,
        filters: direct40,
      },
      {
        name: "prepared-page-128-current",
        window: WINDOW,
        filters: currentPrepared,
      },
      { name: "prepared-page-empty", window: WINDOW, filters: emptyPrepared },
      {
        name: "prepared-current-to-actual-previous",
        window: PREVIOUS_WINDOW,
        filters: previousPrepared,
      },
      { name: "direct-event-name-fact", window: WINDOW, filters: directEvent },
    ] as const;
    const evidence = [];
    for (const profile of profiles) {
      const parent = parentOverviewSql(
        SITE_ID,
        profile.window,
        profile.filters,
      );
      const logical = await compilePublicReader(
        profile.name,
        profile.window,
        profile.filters,
      );
      const sqlBytes = new TextEncoder().encode(logical.sql).byteLength;
      const sqlHash = createHash("sha256").update(logical.sql).digest("hex");
      expect(logical.statementCount, profile.name).toBe(1);
      expect(sqlBytes, profile.name).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(logical.bindings.length, profile.name).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(logical.observation.tag, profile.name).toBe(
        `wave62.overview.${profile.name}`,
      );
      expect(logical.observation.physicalPlanHash, profile.name).toMatch(
        /^v\d+:/u,
      );
      evidence.push({
        name: profile.name,
        parent: {
          sqlBytes: new TextEncoder().encode(parent.sql).byteLength,
          bindings: parent.bindings.length,
          statements: 1,
          sqlHash: createHash("sha256").update(parent.sql).digest("hex"),
        },
        logical: {
          sqlBytes,
          bindings: logical.bindings.length,
          statements: logical.statementCount,
          sqlHash,
          physicalPlanHash: logical.observation.physicalPlanHash,
          tag: logical.observation.tag,
        },
      });
    }
    console.info("wave62_overview_budget", JSON.stringify(evidence));
    expect(evidence).toHaveLength(profiles.length);
  });

  it("uses one typed Page/Event reader-window selection without widening old profiles", () => {
    const filters = preparedFilter({
      filters: fieldFilter("page.path", "/prepared"),
      scopePreference: "event",
      advancedMatches: {
        visitIds: [{ siteId: SITE_ID, id: "p-prepared" }],
        eventIds: [{ siteId: SITE_ID, id: "e-prepared" }],
      },
    });
    const plan = buildOverviewAggregatePlan({
      siteId: SITE_ID,
      queryTime: queryTime(PREVIOUS_WINDOW),
      filters,
    });
    const sources = plan.nodes.filter((node) => node.kind === "source");
    const page = sources.find(
      (node) => node.kind === "source" && node.entity === "page",
    );
    const event = sources.find(
      (node) => node.kind === "source" && node.entity === "event",
    );
    expect(page?.kind).toBe("source");
    expect(event?.kind).toBe("source");
    if (page?.kind !== "source" || event?.kind !== "source")
      throw new Error("wave62_shared_sources_missing");
    expect(page.selection?.profile).toBe("prepared-scoped-reader-window-v1");
    expect(event.selection).toBe(page.selection);
    expect(page.selection?.preparationTime).toBeDefined();
    expect(page.selection?.time.candidate).not.toEqual(
      page.selection?.preparationTime?.candidate,
    );
    expect(event.selection?.eventNameGate).toBeUndefined();
  });

  it("records plain and scoped parent/logical EQP without claiming production rows-read", async () => {
    const { database, sites } = createDatabase();
    try {
      insertPage(database, sites, {
        visitId: "eqp-page",
        sessionId: "eqp-session",
        visitorId: "eqp-visitor",
        startedAt: 130,
        durationMs: 10,
      });
      insertEvent(database, sites, {
        eventId: "eqp-event",
        ownerVisitId: "eqp-page",
        occurredAt: 140,
        name: "signup",
      });
      const filters = fieldFilter("event.name", "signup");
      const parent = parentOverviewSql(SITE_ID, WINDOW, filters);
      const actual = await logicalOverview(database, WINDOW, filters);
      const parentPlan = explainQueryPlan(database, parent);
      const logicalPlan = explainQueryPlan(database, {
        sql: actual.trace.preparedSql[0]!,
        bindings: actual.trace.bindings[0]!,
      });
      expect(parentPlan.join("\n")).toContain("idx_visits_site_pk_started_at");
      expect(logicalPlan.join("\n")).toMatch(
        /idx_visits_site_pk_started_at|idx_custom_events_site_pk_time/u,
      );
      console.info(
        "wave62_overview_eqp",
        JSON.stringify({ parent: parentPlan, logical: logicalPlan }),
      );
    } finally {
      database.close();
    }
  });
});
